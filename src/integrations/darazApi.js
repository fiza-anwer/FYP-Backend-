import crypto from "crypto";

const API_ROOT = (process.env.DARAZ_API_URL || "https://api.daraz.pk/rest").replace(/\/$/, "");

function appKey() {
  return process.env.DARAZ_APP_KEY || "";
}

function appSecret() {
  return process.env.DARAZ_APP_SECRET || "";
}

/** Lazada/Daraz Open Platform signature (HMAC-SHA256, hex upper). */
export function signRequest(apiPath, params, secret) {
  const keys = Object.keys(params).sort();
  let base = apiPath;
  for (const key of keys) {
    if (params[key] !== undefined && params[key] !== null) {
      base += key + String(params[key]);
    }
  }
  return crypto.createHmac("sha256", secret).update(base).digest("hex").toUpperCase();
}

/**
 * Call Daraz REST API (GET).
 * @returns {object} Parsed JSON body
 */
export async function darazGet(apiPath, businessParams = {}, accessToken = null) {
  const key = appKey();
  const secret = appSecret();
  if (!key || !secret) {
    throw new Error("Daraz API not configured: set DARAZ_APP_KEY and DARAZ_APP_SECRET in .env");
  }

  const params = {
    app_key: key,
    sign_method: "sha256",
    timestamp: String(Date.now()),
    ...businessParams,
  };
  if (accessToken) params.access_token = accessToken;

  const sign = signRequest(apiPath, params, secret);
  const qs = new URLSearchParams({ ...params, sign });
  const url = `${API_ROOT}${apiPath}?${qs.toString()}`;

  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Daraz API invalid response (${res.status}): ${text.slice(0, 200)}`);
  }

  const code = json.code;
  if (code !== "0" && code !== 0) {
    const msg = json.message || json.type || json.error_description || text.slice(0, 300);
    const extra = json.detail ? ` — ${JSON.stringify(json.detail).slice(0, 500)}` : "";
    throw new Error(`Daraz API error (${code}): ${msg}${extra}`);
  }

  return json;
}

/** Exchange OAuth authorization code for access_token. */
export async function exchangeAuthorizationCode(code) {
  const json = await darazGet("/auth/token/create", { code: String(code) });
  const data = json.data || json;
  if (!data.access_token) {
    throw new Error("Daraz token exchange did not return access_token");
  }
  return data;
}

/** Fetch one page of seller products. */
export async function fetchProductsPage(accessToken, { offset = 0, limit = 50, filter = "all" } = {}) {
  const json = await darazGet(
    "/products/get",
    {
      filter,
      offset: String(offset),
      limit: String(limit),
    },
    accessToken
  );
  return json.data || {};
}

function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * POST to Daraz/Lazada Open Platform (all params including `payload` in signed query string).
 */
export async function darazPost(apiPath, businessParams = {}, accessToken = null) {
  const key = appKey();
  const secret = appSecret();
  if (!key || !secret) {
    throw new Error("Daraz API not configured: set DARAZ_APP_KEY and DARAZ_APP_SECRET in .env");
  }

  const params = {
    app_key: key,
    sign_method: "sha256",
    timestamp: String(Date.now()),
    ...businessParams,
  };
  if (accessToken) params.access_token = accessToken;

  const sign = signRequest(apiPath, params, secret);
  const qs = new URLSearchParams({ ...params, sign });
  const url = `${API_ROOT}${apiPath}?${qs.toString()}`;

  const res = await fetch(url, { method: "POST" });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Daraz API invalid response (${res.status}): ${text.slice(0, 200)}`);
  }

  const code = json.code;
  if (code !== "0" && code !== 0) {
    const msg = json.message || json.type || json.error_description || text.slice(0, 300);
    const extra = json.detail ? ` — ${JSON.stringify(json.detail).slice(0, 500)}` : "";
    throw new Error(`Daraz API error (${code}): ${msg}${extra}`);
  }

  return json;
}

/** Build XML for /product/price_quantity/update */
export function buildPriceQuantityXml(skus) {
  const skuNodes = skus
    .map((s) => {
      const parts = [];
      if (s.sellerSku) parts.push(`<SellerSku>${escapeXml(s.sellerSku)}</SellerSku>`);
      if (s.skuId) parts.push(`<SkuId>${escapeXml(s.skuId)}</SkuId>`);
      if (s.quantity != null) parts.push(`<Quantity>${Math.max(0, Math.floor(Number(s.quantity)))}</Quantity>`);
      if (s.price != null && !Number.isNaN(Number(s.price))) {
        parts.push(`<Price>${Number(s.price)}</Price>`);
      }
      return parts.length ? `<Sku>${parts.join("")}</Sku>` : "";
    })
    .filter(Boolean)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Request><Product><Skus>${skuNodes}</Skus></Product></Request>`;
}

/** Update stock and/or price on Daraz for one or more SKUs. */
export async function updateProductPriceQuantity(accessToken, skus) {
  const list = Array.isArray(skus) ? skus.filter((s) => s.sellerSku || s.skuId) : [];
  if (list.length === 0) {
    throw new Error("Daraz update requires SellerSku or SkuId");
  }
  const xml = buildPriceQuantityXml(list);
  const json = await darazPost("/product/price_quantity/update", { payload: xml }, accessToken);
  return json.data || json;
}

/** Fetch one page of orders. */
export async function fetchOrdersPage(
  accessToken,
  { offset = 0, limit = 50, createdAfter } = {}
) {
  const params = {
    offset: String(offset),
    limit: String(limit),
    sort_by: "created_at",
    sort_direction: "DESC",
  };
  if (createdAfter) {
    const d = createdAfter instanceof Date ? createdAfter : new Date(createdAfter);
    if (!Number.isNaN(d.getTime())) {
      params.created_after = d.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
  }
  const json = await darazGet("/orders/get", params, accessToken);
  return json.data || {};
}

/** Fetch line items for an order. */
export async function fetchOrderItems(accessToken, orderId) {
  const json = await darazGet("/order/items/get", { order_id: String(orderId) }, accessToken);
  return json.data || {};
}
