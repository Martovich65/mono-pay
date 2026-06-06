'use strict';

/**
 * api/webhook.js
 * Receives Monobank payment status webhooks.
 *
 * Security pipeline (in order):
 * 1. Verify X-Sign signature using Monobank's public key (Ed25519 / RSA).
 * 2. Idempotency: fetch draft order status via GraphQL — skip if already COMPLETED.
 * 3. Complete the draft order via draftOrderComplete GraphQL mutation.
 */

const crypto = require('crypto');
const { shopifyAdminGraphql, toOrderGid } = require('../lib/http');

// ─── Constants ────────────────────────────────────────────────────────────────

const MONO_PUBKEY_URL = 'https://api.monobank.ua/api/merchant/pubkey';

// ─── Module-level public key cache ───────────────────────────────────────────

let cachedPublicKey = null; // PEM string, lives for the container lifetime

// ─── GraphQL operations ───────────────────────────────────────────────────────

const DRAFT_ORDER_STATUS_QUERY = /* GraphQL */ `
  query getDraftOrderStatus($id: ID!) {
    draftOrder(id: $id) {
      id
      status
      order {
        id
      }
    }
  }
`;

const DRAFT_ORDER_COMPLETE_MUTATION = /* GraphQL */ `
  mutation draftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder {
        id
        status
        order {
          id
          name
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ─── Monobank public key fetching ─────────────────────────────────────────────

async function getMonobankPublicKey() {
  if (cachedPublicKey) return cachedPublicKey;

  const response = await fetch(MONO_PUBKEY_URL, {
    headers: { 'X-Token': process.env.MONOBANK_API_TOKEN || '' },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Monobank public key (HTTP ${response.status})`
    );
  }

  const data = await response.json();

  if (!data?.key) {
    throw new Error('Monobank public key response missing "key" field');
  }

  const pem = `-----BEGIN PUBLIC KEY-----\n${data.key
    .match(/.{1,64}/g)
    .join('\n')}\n-----END PUBLIC KEY-----`;

  cachedPublicKey = pem;
  return pem;
}

// ─── Signature verification ───────────────────────────────────────────────────

async function verifyMonobankSignature(rawBody, xSign) {
  if (!xSign) {
    throw new Error('Missing X-Sign header — possible spoofed request');
  }

  const pemKey = await getMonobankPublicKey();
  const keyObject = crypto.createPublicKey(pemKey);

  const signatureBuffer = Buffer.from(xSign, 'base64');
  const dataBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');

  const isValid = crypto.verify(null, dataBuffer, keyObject, signatureBuffer);

  if (!isValid) {
    throw new Error('X-Sign verification failed — signature does not match');
  }
}

// ─── Raw body reader ──────────────────────────────────────────────────────────

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') {
      return resolve(Buffer.from(JSON.stringify(req.body), 'utf8'));
    }
    if (typeof req.body === 'string' && req.body.length) {
      return resolve(Buffer.from(req.body, 'utf8'));
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── Shopify: idempotency check ───────────────────────────────────────────────

async function isDraftOrderAlreadyCompleted(draftOrderGid) {
  const data = await shopifyAdminGraphql(DRAFT_ORDER_STATUS_QUERY, {
    id: draftOrderGid,
  });

  const draft = data?.draftOrder;

  if (!draft) {
    throw new Error(`Draft order not found in Shopify: ${draftOrderGid}`);
  }

  return draft.status === 'COMPLETED' || Boolean(draft.order?.id);
}

// ─── Shopify: complete draft order ───────────────────────────────────────────

async function completeDraftOrder(draftOrderGid) {
  const data = await shopifyAdminGraphql(DRAFT_ORDER_COMPLETE_MUTATION, {
    id: draftOrderGid,
  });

  const { draftOrder, userErrors } = data?.draftOrderComplete || {};

  if (userErrors?.length) {
    throw new Error(
      `draftOrderComplete userErrors: ${userErrors.map((e) => `${e.field}: ${e.message}`).join('; ')}`
    );
  }

  if (!draftOrder?.order?.id) {
    throw new Error('draftOrderComplete did not return a linked order');
  }

  return draftOrder;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let rawBody;

  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('[webhook] Failed to read body:', err.message);
    return res.status(400).json({ error: 'Failed to read request body' });
  }

  try {
    await verifyMonobankSignature(rawBody, req.headers['x-sign']);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    cachedPublicKey = null;
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const status = String(payload.status || '').toLowerCase();
  const reference = payload.reference;

  if (!reference) {
    return res.status(400).json({ error: 'Missing reference in Monobank payload' });
  }

  if (status !== 'success') {
    console.log(`[webhook] Ignoring status="${status}" for reference=${reference}`);
    return res.status(200).json({ received: true, status, action: 'ignored' });
  }

  let draftOrderGid;
  try {
    draftOrderGid = toOrderGid(reference).replace('/Order/', '/DraftOrder/');
  } catch (err) {
    return res.status(400).json({ error: `Invalid reference format: ${err.message}` });
  }

  try {
    const alreadyDone = await isDraftOrderAlreadyCompleted(draftOrderGid);
    if (alreadyDone) {
      console.log(`[webhook] Draft order ${draftOrderGid} already completed — skipping.`);
      return res.status(200).json({ received: true, status, action: 'already_completed' });
    }
  } catch (err) {
    console.error('[webhook] Idempotency check failed:', err.message);
    return res.status(500).json({ error: 'Idempotency check failed', message: err.message });
  }

  try {
    const completed = await completeDraftOrder(draftOrderGid);

    console.log(
      `[webhook] Draft order ${draftOrderGid} completed → Order ${completed.order.id} (${completed.order.name})`
    );

    return res.status(200).json({
      received: true,
      status,
      draftOrderId: completed.id,
      orderId: completed.order.id,
      orderName: completed.order.name,
      action: 'draft_completed_to_paid_order',
    });
  } catch (err) {
    console.error('[webhook] Draft order completion failed:', err.message);
    return res.status(500).json({
      error: 'Draft order completion failed',
      message: err.message,
    });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
