/**
 * Общие HTTP-утилиты для serverless-функций Vercel.
 *
 * SHOPIFY_ACCESS_TOKEN теперь получается через OAuth-флоу (api/auth.js).
 * Функция getShopifyAccessToken() читает токен из process.env.SHOPIFY_ACCESS_TOKEN,
 * который устанавливается в Vercel после прохождения OAuth и сохранения токена
 * в переменных окружения проекта.
 */

const DEFAULT_SHOPIFY_API_VERSION = '2025-01';

/**
 * Возвращает динамический SHOPIFY_ACCESS_TOKEN из окружения.
 * Токен выдаётся Shopify в ходе OAuth-флоу (api/auth.js) и сохраняется
 * в Vercel → Settings → Environment Variables как SHOPIFY_ACCESS_TOKEN.
 *
 * @throws {Error} если токен не задан
 */
function getShopifyAccessToken() {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      'SHOPIFY_ACCESS_TOKEN is not set. ' +
      'Complete the OAuth flow at /api/auth?shop=<your-store>.myshopify.com ' +
      'and save the returned token to Vercel Environment Variables.'
    );
  }
  return token;
}

/**
 * Базовый URL деплоя (для webHookUrl Monobank).
 * На Vercel автоматически доступен process.env.VERCEL_URL.
 */
function getAppBaseUrl() {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/$/, '');
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return '';
}

/**
 * Нормализует домен магазина Shopify (без протокола и слэша).
 */
function normalizeShopDomain(domain) {
  return String(domain || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '');
}

/**
 * Преобразует числовой order id в GraphQL GID.
 */
function toOrderGid(orderId) {
  const numeric = String(orderId).replace(/\D/g, '');
  if (!numeric) {
    throw new Error('Invalid orderId');
  }
  return `gid://shopify/Order/${numeric}`;
}

/**
 * CORS для запросов с домена магазина Shopify.
 */
function applyCors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const origin = req.headers.origin || '';
  const storeUrl = process.env.SHOPIFY_STORE_URL || '';
  const storeOrigin = storeUrl ? storeUrl.replace(/\/$/, '') : '';

  const isAllowed =
    !allowed.length ||
    allowed.includes(origin) ||
    (storeOrigin && origin === storeOrigin);

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
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.body === 'string' && req.body.length) {
    return JSON.parse(req.body);
  }
  return {};
}

/**
 * Выполняет GraphQL-запрос к Shopify Admin API.
 *
 * Токен доступа получается динамически через getShopifyAccessToken(),
 * который читает SHOPIFY_ACCESS_TOKEN из переменных окружения Vercel.
 * Токен устанавливается один раз после прохождения OAuth-флоу (api/auth.js)
 * и остаётся актуальным до явного отзыва приложения в Shopify.
 *
 * @param {string} query     - GraphQL-запрос или мутация
 * @param {object} variables - переменные запроса
 * @returns {Promise<object>} - поле data из ответа Shopify
 */
async function shopifyAdminGraphql(query, variables) {
  const shop = normalizeShopDomain(process.env.SHOPIFY_SHOP_DOMAIN);
  const apiVersion = process.env.SHOPIFY_API_VERSION || DEFAULT_SHOPIFY_API_VERSION;

  if (!shop) {
    throw new Error('SHOPIFY_SHOP_DOMAIN is not configured');
  }

  // Токен читается динамически при каждом вызове — это позволяет
  // обновить SHOPIFY_ACCESS_TOKEN в Vercel без изменения кода.
  const token = getShopifyAccessToken();

  const response = await fetch(
    `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const payload = await response.json();

  if (!response.ok) {
    const message = payload?.errors?.[0]?.message || response.statusText;
    throw new Error(`Shopify GraphQL HTTP ${response.status}: ${message}`);
  }

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message).join('; '));
  }

  return payload.data;
}

module.exports = {
  DEFAULT_SHOPIFY_API_VERSION,
  getShopifyAccessToken,
  getAppBaseUrl,
  normalizeShopDomain,
  toOrderGid,
  applyCors,
  readJsonBody,
  shopifyAdminGraphql,
};
