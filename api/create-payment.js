'use strict';

const { getAppBaseUrl, applyCors, shopifyAdminGraphql, readJsonBody } = require('../lib/http');

const MONOBANK_INVOICE_URL = 'https://api.monobank.ua/api/merchant/invoice/create';

const DRAFT_ORDER_CREATE_MUTATION = /* GraphQL */ `
  mutation draftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        totalPrice
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function extractNumericId(gid) {
  if (!gid || typeof gid !== 'string') throw new Error('Invalid GID received from Shopify');
  const parts = gid.split('/');
  const numeric = parts[parts.length - 1];
  if (!numeric || !/^\d+$/.test(numeric)) {
    throw new Error(`Cannot extract numeric ID from GID: ${gid}`);
  }
  return numeric;
}

function reserveUntilIso() {
  return new Date(Date.now() + 30 * 60 * 1000).toISOString();
}

function buildLineItems(rawItems = []) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error('lineItems array is required and must not be empty');
  }

  return rawItems.map((item, idx) => {
    const variantId =
      item.variantId ||
      item.variant_id ||
      (typeof item.id === 'string' && item.id.startsWith('gid://') ? item.id : null);

    if (!variantId) {
      throw new Error(`lineItems[${idx}] is missing variantId`);
    }

    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));

    const gid = String(variantId).startsWith('gid://')
      ? variantId
      : `gid://shopify/ProductVariant/${String(variantId).replace(/\D/g, '')}`;

    return { variantId: gid, quantity };
  });
}

function buildDraftOrderInput(body) {
  const lineItems = buildLineItems(body.lineItems || body.line_items);

  const input = {
    lineItems,
    reserveInventoryUntil: reserveUntilIso(),
    note: body.note || 'Monobank payment — draft order',
    tags: ['monobank', 'draft-order-flow'],
  };

  const email = body.customer?.email || body.email;
  if (email) input.email = String(email).trim();

  const phone = body.customer?.phone || body.phone;
  if (phone) input.phone = String(phone).trim();

  const shippingAddress = body.shippingAddress || body.shipping_address;
  if (shippingAddress && typeof shippingAddress === 'object') {
    input.shippingAddress = shippingAddress;
  }

  const billingAddress = body.billingAddress || body.billing_address;
  if (billingAddress && typeof billingAddress === 'object') {
    input.billingAddress = billingAddress;
  }

  return input;
}

async function createDraftOrder(body) {
  const input = buildDraftOrderInput(body);
  const data = await shopifyAdminGraphql(DRAFT_ORDER_CREATE_MUTATION, { input });

  const { draftOrder, userErrors } = data?.draftOrderCreate || {};

  if (userErrors?.length) {
    throw new Error(
      `Shopify draftOrderCreate userErrors: ${userErrors.map((e) => `${e.field}: ${e.message}`).join('; ')}`
    );
  }

  if (!draftOrder?.id) {
    throw new Error('draftOrderCreate returned no draftOrder');
  }

  return draftOrder;
}

async function createMonobankInvoice({ reference, amountCoins }) {
  const monoToken = process.env.MONOBANK_API_TOKEN;
  const baseUrl = getAppBaseUrl();

  if (!monoToken) throw new Error('MONOBANK_API_TOKEN env variable is not configured');
  if (!baseUrl) throw new Error('APP_URL or VERCEL_URL env variable is required');

  const redirectUrl =
    process.env.SHOPIFY_REDIRECT_URL ||
    process.env.SHOPIFY_STORE_URL ||
    'https://shopify.com';

  const invoicePayload = {
    amount: amountCoins,
    ccy: 980,
    merchantPaymInfo: {
      reference: String(reference),
      destination: `Оплата замовлення #${reference}`,
      comment: `Shopify Draft Order ${reference}`,
    },
    redirectUrl,
    webHookUrl: `${baseUrl}/api/webhook`,
    validity: Number(process.env.MONOBANK_INVOICE_VALIDITY_SEC) || 86400,
    paymentType: 'debit',
  };

  const response = await fetch(MONOBANK_INVOICE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Token': monoToken,
      'X-Cms': 'Shopify-DraftOrder-Monobank',
      'X-Cms-Version': '2.0.0',
    },
    body: JSON.stringify(invoicePayload),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.pageUrl) {
    throw new Error(
      `Monobank invoice creation failed (HTTP ${response.status}): ${JSON.stringify(result)}`
    );
  }

  return result;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const body = readJsonBody(req);

    const draftOrder = await createDraftOrder(body);
    const draftOrderNumericId = extractNumericId(draftOrder.id);

    const amountUah = Number(draftOrder.totalPrice);
    if (!Number.isFinite(amountUah) || amountUah <= 0) {
      throw new Error(`Invalid draft order total price: ${draftOrder.totalPrice}`);
    }
    const amountCoins = Math.round(amountUah * 100);

    const monoInvoice = await createMonobankInvoice({
      reference: draftOrderNumericId,
      amountCoins,
    });

    return res.status(200).json({
      pageUrl: monoInvoice.pageUrl,
      invoiceId: monoInvoice.invoiceId,
      draftOrderId: draftOrder.id,
      draftOrderNumericId,
      draftOrderName: draftOrder.name,
      amount: amountUah,
      amountCoins,
    });
  } catch (error) {
    console.error('[create-payment] Error:', error.message);
    return res.status(500).json({
      error: 'Failed to create payment',
      message: error.message,
    });
  }
};
