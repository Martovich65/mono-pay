/**
 * Общие HTTP-утилиты для serverless-функций Vercel.
 */

const DEFAULT_SHOPIFY_API_VERSION = '2026-07';

function getShopifyAccessToken() {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      'SHOPIFY_ACCESS_TOKEN is not set. Complete the OAuth flow and save the token in Vercel Environment Variables.'
    );
  }
  return token;
}

function getAppBaseUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return '';
}

function normalizeShopDomain(domain) {
  return String(domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

function toNumericShopifyId(value, label = 'Shopify ID') {
  const raw = String(value || '').trim();
  const numeric = raw.startsWith('gid://') ? raw.split('/').pop() : raw.replace(/\D/g, '');
  if (!numeric || !/^\d+$/.test(numeric)) throw new Error(`Invalid ${label}`);
  return numeric;
}

function toOrderGid(orderId) {
  return `gid://shopify/Order/${toNumericShopifyId(orderId, 'orderId')}`;
}

function toDraftOrderGid(draftOrderId) {
  return `gid://shopify/DraftOrder/${toNumericShopifyId(draftOrderId, 'draftOrderId')}`;
}

function toProductVariantGid(variantId) {
  return `gid://shopify/ProductVariant/${toNumericShopifyId(variantId, 'product variant ID')}`;
}

function applyCors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const storeUrl = process.env.SHOPIFY_STORE_URL || '';
  const storeOrigin = storeUrl ? storeUrl.replace(/\/$/, '') : '';

  const isAllowed = !allowed.length || allowed.includes(origin) || (storeOrigin && origin === storeOrigin);
  if (origin && isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!origin && storeOrigin) {
    res.setHeader('Access-Control-Allow-Origin', storeOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) return JSON.parse(req.body);
  return {};
}

async function shopifyAdminGraphql(query, variables) {
  const shop = normalizeShopDomain(process.env.SHOPIFY_SHOP_DOMAIN);
  const apiVersion = process.env.SHOPIFY_API_VERSION || DEFAULT_SHOPIFY_API_VERSION;
  if (!shop) throw new Error('SHOPIFY_SHOP_DOMAIN is not configured');

  const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': getShopifyAccessToken() },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const message = payload?.errors?.[0]?.message || response.statusText;
    throw new Error(`Shopify GraphQL HTTP ${response.status}: ${message}`);
  }
  if (payload.errors?.length) throw new Error(payload.errors.map((e) => e.message).join('; '));
  return payload.data;
}

module.exports = {
  DEFAULT_SHOPIFY_API_VERSION,
  getShopifyAccessToken,
  getAppBaseUrl,
  normalizeShopDomain,
  toOrderGid,
  toDraftOrderGid,
  toProductVariantGid,
  applyCors,
  readJsonBody,
  shopifyAdminGraphql,
};
