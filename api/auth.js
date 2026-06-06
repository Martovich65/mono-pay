'use strict';

/**
 * api/auth.js
 * OAuth-авторизация Shopify (шаг 1 и шаг 2).
 *
 * Шаг 1 — GET /api/auth?shop=your-store.myshopify.com
 *   → Редирект на страницу разрешений Shopify
 *
 * Шаг 2 — GET /api/auth?code=...&shop=...&hmac=...&state=...
 *   → Обмен code на постоянный access_token
 *   → Выводит токен в браузере (сохраните его в Vercel как SHOPIFY_ACCESS_TOKEN)
 */

const crypto = require('crypto');

// Необходимые разрешения для работы системы
const SCOPES = [
  'write_draft_orders',
  'read_draft_orders',
  'read_products',
  'write_orders',
].join(',');

/**
 * Нормализует домен магазина (убирает https:// и слэш).
 */
function normalizeShop(raw) {
  return String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '');
}

/**
 * Проверяет HMAC-подпись от Shopify.
 * Shopify подписывает callback-параметры через HMAC-SHA256.
 */
function verifyHmac(query, secret) {
  const { hmac, signature, ...rest } = query;

  // Строим строку для проверки: параметры отсортированы и соединены через &
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('&');

  const expected = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  // Безопасное сравнение (защита от timing-атак)
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(hmac || '', 'hex')
    );
  } catch {
    return false;
  }
}

module.exports = async function handler(req, res) {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const appUrl = (process.env.APP_URL || `https://${process.env.VERCEL_URL}`).replace(/\/$/, '');

  if (!clientId || !clientSecret) {
    return res.status(500).send(
      '<h2>Ошибка конфигурации</h2><p>SHOPIFY_CLIENT_ID или SHOPIFY_CLIENT_SECRET не заданы в Vercel.</p>'
    );
  }

  const query = req.query || {};
  const shop = normalizeShop(query.shop || process.env.SHOPIFY_SHOP_DOMAIN);

  if (!shop || !shop.endsWith('.myshopify.com')) {
    return res.status(400).send(
      '<h2>Ошибка</h2><p>Параметр <code>shop</code> обязателен и должен заканчиваться на <code>.myshopify.com</code>.</p>' +
      `<p>Пример: <a href="${appUrl}/api/auth?shop=your-store.myshopify.com">${appUrl}/api/auth?shop=your-store.myshopify.com</a></p>`
    );
  }

  // ─── ШАГ 2: Shopify вернул code (callback) ───────────────────────────────
  if (query.code) {
    // Проверяем HMAC-подпись
    if (!verifyHmac(query, clientSecret)) {
      return res.status(403).send('<h2>Ошибка безопасности</h2><p>HMAC-подпись не прошла проверку. Возможна подделка запроса.</p>');
    }

    // Обмениваем code на постоянный access_token
    try {
      const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code: query.code,
        }),
      });

      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || !tokenData.access_token) {
        throw new Error(
          `Shopify вернул ошибку (HTTP ${tokenResponse.status}): ${JSON.stringify(tokenData)}`
        );
      }

      const accessToken = tokenData.access_token;
      const scope = tokenData.scope || '';

      // Выводим токен в браузере — скопируйте его в Vercel!
      return res.status(200).send(`
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>OAuth завершён — Shopify Access Token</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; }
    .token-box { background: #f0f9ff; border: 2px solid #0ea5e9; border-radius: 8px; padding: 20px; margin: 20px 0; }
    .token { font-family: monospace; font-size: 14px; word-break: break-all; background: #1e293b; color: #7dd3fc; padding: 12px; border-radius: 6px; }
    .steps { background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 20px; }
    .steps ol { margin: 0; padding-left: 20px; }
    .steps li { margin: 8px 0; }
    .warning { background: #fef3c7; border: 1px solid #fbbf24; border-radius: 8px; padding: 16px; margin: 16px 0; }
  </style>
</head>
<body>
  <h1>✅ OAuth авторизация успешна!</h1>

  <div class="warning">
    ⚠️ <strong>Сохраните токен прямо сейчас!</strong> Эта страница не сохраняет данные — после закрытия токен нельзя восстановить.
  </div>

  <div class="token-box">
    <p><strong>Магазин:</strong> ${shop}</p>
    <p><strong>Разрешения (scopes):</strong> ${scope}</p>
    <p><strong>Ваш Admin API Access Token:</strong></p>
    <div class="token">${accessToken}</div>
  </div>

  <div class="steps">
    <h3>📋 Следующие шаги:</h3>
    <ol>
      <li>Скопируйте токен выше</li>
      <li>Откройте <strong>Vercel Dashboard → ваш проект → Settings → Environment Variables</strong></li>
      <li>Добавьте переменную: <code>SHOPIFY_ACCESS_TOKEN</code> = <em>(вставьте токен)</em></li>
      <li>Нажмите <strong>Save</strong> и сделайте <strong>Redeploy</strong> проекта</li>
      <li>Вернитесь к разработке — система готова к работе!</li>
    </ol>
  </div>
</body>
</html>
      `);
    } catch (err) {
      console.error('[auth] Token exchange error:', err.message);
      return res.status(500).send(
        `<h2>Ошибка обмена токена</h2><pre>${err.message}</pre>`
      );
    }
  }

  // ─── ШАГ 1: Редирект на страницу разрешений Shopify ──────────────────────
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${appUrl}/api/auth`;

  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  console.log(`[auth] Redirecting to Shopify OAuth for shop: ${shop}`);
  return res.redirect(302, installUrl);
};
