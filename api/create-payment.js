'use strict';

const { getAppBaseUrl, applyCors, shopifyAdminGraphql, readJsonBody, toProductVariantGid } = require('../lib/http');

const MONOBANK_INVOICE_URL = 'https://api.monobank.ua/api/merchant/invoice/create';

const PACKAGE_RULES = Object.freeze({
  STARTER: Object.freeze({ discountPercent: 5, giftRequired: false, specialGuarantee: true }),
  GOLD: Object.freeze({ discountPercent: 10, giftRequired: false, specialGuarantee: false }),
  VIP: Object.freeze({ discountPercent: 12, giftRequired: true, specialGuarantee: false }),
});

const VARIANT_QUERY = /* GraphQL */ `
  query getPackageVariant($id: ID!) {
    productVariant(id: $id) {
      id
      availableForSale
      price
      product { id title }
    }
  }
`;

const DRAFT_ORDER_CREATE_MUTATION = /* GraphQL */ `
  mutation draftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name totalPrice status }
      userErrors { field message }
    }
  }
`;

function extractNumericId(gid) {
  if (!gid || typeof gid !== 'string') throw new Error('Invalid GID received from Shopify');
  const numeric = gid.split('/').pop();
  if (!/^\d+$/.test(numeric || '')) throw new Error(`Cannot extract numeric ID from GID: ${gid}`);
  return numeric;
}

function reserveUntilIso() {
  return new Date(Date.now() + 30 * 60 * 1000).toISOString();
}

function requiredVariantFromEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return toProductVariantGid(value);
}

function allowedVipGiftVariants() {
  return ['VIP_GIFT_1_VARIANT_ID', 'VIP_GIFT_2_VARIANT_ID', 'VIP_GIFT_3_VARIANT_ID']
    .map((name) => process.env[name])
    .filter(Boolean)
    .map(toProductVariantGid);
}

function getPackageSelection(body) {
  const packageCode = String(body.packageCode || body.package_code || '').trim().toUpperCase();
  const rule = PACKAGE_RULES[packageCode];
  if (!rule) throw new Error('packageCode must be one of STARTER, GOLD, VIP');

  const mainVariantId = requiredVariantFromEnv('PACKAGE_PRODUCT_VARIANT_ID');

  let giftVariantId = null;
  if (rule.giftRequired) {
    giftVariantId = toProductVariantGid(body.giftVariantId || body.gift_variant_id);
    const allowed = allowedVipGiftVariants();
    if (allowed.length !== 3) throw new Error('All three VIP gift variant IDs must be configured');
    if (!allowed.includes(giftVariantId)) throw new Error('Selected VIP gift is not allowed');
  } else if (body.giftVariantId || body.gift_variant_id) {
    throw new Error(`${packageCode} does not accept a gift selection`);
  }

  return { packageCode, rule, mainVariantId, giftVariantId };
}

async function getVariant(id, label) {
  const data = await shopifyAdminGraphql(VARIANT_QUERY, { id });
  const variant = data?.productVariant;
  if (!variant) throw new Error(`${label} variant was not found in Shopify`);
  if (!variant.availableForSale) throw new Error(`${label} variant is not available for sale`);
  return variant;
}

function percentageDiscount(percent, description) {
  return {
    value: percent,
    valueType: 'PERCENTAGE',
    description,
  };
}

async function buildDraftOrderInput(body) {
  const selection = getPackageSelection(body);
  const mainVariant = await getVariant(selection.mainVariantId, 'Package product');

  const lineItems = [{
    variantId: mainVariant.id,
    quantity: 1,
    appliedDiscount: percentageDiscount(
      selection.rule.discountPercent,
      `${selection.packageCode} package discount`
    ),
  }];

  if (selection.giftVariantId) {
    const giftVariant = await getVariant(selection.giftVariantId, 'VIP gift');
    lineItems.push({
      variantId: giftVariant.id,
      quantity: 1,
      appliedDiscount: percentageDiscount(100, 'VIP gift'),
    });
  }

  const input = {
    lineItems,
    reserveInventoryUntil: reserveUntilIso(),
    note: 'Monobank payment — package draft order',
    tags: ['monobank', 'draft-order-flow', 'package-checkout', `package-${selection.packageCode.toLowerCase()}`],
    customAttributes: [
      { key: 'package_code', value: selection.packageCode },
      { key: 'privilege_on_success', value: 'true' },
      { key: 'special_guarantee', value: selection.rule.specialGuarantee ? 'true' : 'false' },
    ],
  };

  const email = body.customer?.email || body.email;
  if (email) input.email = String(email).trim();
  const phone = body.customer?.phone || body.phone;
  if (phone) input.phone = String(phone).trim();

  const shippingAddress = body.shippingAddress || body.shipping_address;
  if (shippingAddress && typeof shippingAddress === 'object') input.shippingAddress = shippingAddress;
  const billingAddress = body.billingAddress || body.billing_address;
  if (billingAddress && typeof billingAddress === 'object') input.billingAddress = billingAddress;

  return { input, selection };
}

async function createDraftOrder(body) {
  const { input, selection } = await buildDraftOrderInput(body);
  const data = await shopifyAdminGraphql(DRAFT_ORDER_CREATE_MUTATION, { input });
  const { draftOrder, userErrors } = data?.draftOrderCreate || {};

  if (userErrors?.length) {
    throw new Error(`Shopify draftOrderCreate userErrors: ${userErrors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
  }
  if (!draftOrder?.id) throw new Error('draftOrderCreate returned no draftOrder');
  return { draftOrder, selection };
}

async function createMonobankInvoice({ reference, amountCoins }) {
  const monoToken = process.env.MONOBANK_API_TOKEN;
  const baseUrl = getAppBaseUrl();
  if (!monoToken) throw new Error('MONOBANK_API_TOKEN env variable is not configured');
  if (!baseUrl) throw new Error('APP_URL or VERCEL_URL env variable is required');

  const redirectUrl = process.env.SHOPIFY_REDIRECT_URL || process.env.SHOPIFY_STORE_URL || 'https://shopify.com';
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
      'X-Cms-Version': '2.1.0',
    },
    body: JSON.stringify(invoicePayload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.pageUrl) {
    throw new Error(`Monobank invoice creation failed (HTTP ${response.status}): ${JSON.stringify(result)}`);
  }
  return result;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const body = readJsonBody(req);
    const { draftOrder, selection } = await createDraftOrder(body);
    const draftOrderNumericId = extractNumericId(draftOrder.id);

    const amountUah = Number(draftOrder.totalPrice);
    if (!Number.isFinite(amountUah) || amountUah <= 0) throw new Error(`Invalid draft order total price: ${draftOrder.totalPrice}`);
    const amountCoins = Math.round(amountUah * 100);

    const monoInvoice = await createMonobankInvoice({ reference: draftOrderNumericId, amountCoins });

    return res.status(200).json({
      pageUrl: monoInvoice.pageUrl,
      invoiceId: monoInvoice.invoiceId,
      draftOrderId: draftOrder.id,
      draftOrderNumericId,
      draftOrderName: draftOrder.name,
      packageCode: selection.packageCode,
      amount: amountUah,
      amountCoins,
    });
  } catch (error) {
    console.error('[create-payment] Error:', error.message);
    return res.status(500).json({ error: 'Failed to create payment', message: error.message });
  }
};
