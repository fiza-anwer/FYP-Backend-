import { createHash } from "node:crypto";
import {
  exchangeAuthorizationCode,
  refreshAuthorizationToken,
  fetchSellerProfile,
  fetchProductsPage,
  fetchOrdersPage,
  fetchOrderItems,
  updateProductPriceQuantity,
} from "./darazApi.js";
import { createDarazProduct } from "./darazProductCreate.js";
import { decryptStoredCredentials } from "../db/credentialEncryption.js";

const refreshResults = new Map();
const REFRESH_RESULT_TTL_MS = 30_000;
const REFRESH_FAILURE_TTL_MS = 5_000;

function mapDarazProduct(item) {
  const skus = Array.isArray(item?.skus) ? item.skus : [];
  const firstSku = skus[0] || {};
  const attrs = item?.attributes || {};
  const title =
    attrs.name ||
    attrs.Name ||
    item?.item_name ||
    item?.product_name ||
    `Daraz item ${item?.item_id ?? ""}`;
  const sellerSku =
    firstSku.SellerSku ||
    firstSku.seller_sku ||
    firstSku.ShopSku ||
    firstSku.shop_sku ||
    "";
  const skuId = firstSku.SkuId || firstSku.sku_id || "";
  const priceRaw = firstSku.price ?? firstSku.special_price ?? firstSku.Price;
  const price = priceRaw != null ? parseFloat(String(priceRaw)) : undefined;
  const qtyRaw = firstSku.quantity ?? firstSku.Quantity ?? firstSku.available;
  const inventory_quantity =
    qtyRaw != null && !Number.isNaN(Number(qtyRaw)) ? Number(qtyRaw) : undefined;

  const variants = skus.map((s, idx) => ({
    id: s.SkuId || s.sku_id || s.ShopSku || String(idx),
    sku_id: String(s.SkuId || s.sku_id || "").trim(),
    sku: s.SellerSku || s.seller_sku || s.ShopSku || "",
    title: s.color || s.size || s.seller_sku || "",
    option1: s.color || s.size || undefined,
    price: s.price != null ? parseFloat(String(s.price)) : price,
    inventory_quantity:
      s.quantity != null && !Number.isNaN(Number(s.quantity)) ? Number(s.quantity) : inventory_quantity,
  }));

  return {
    external_id: String(item?.item_id ?? item?.product_id ?? ""),
    title: String(title).trim(),
    sku: String(sellerSku).trim(),
    seller_sku: String(sellerSku).trim(),
    sku_id: String(skuId).trim(),
    product_type: attrs.primary_category || attrs.category || "",
    status: "active",
    price: typeof price === "number" && !Number.isNaN(price) ? price : null,
    source: "daraz",
    raw: item,
    variants:
      variants.length > 0
        ? variants
        : [{ sku: sellerSku, id: skuId, sku_id: String(skuId).trim(), price, inventory_quantity }],
  };
}

function mapDarazOrder(order, items = []) {
  const orderId = String(order.order_id ?? order.order_number ?? "");
  const lineItems = items.map((li) => ({
    sku: li.sku || li.shop_sku || li.SellerSku || li.seller_sku || "",
    quantity: Math.max(1, parseInt(li.quantity ?? li.item_quantity ?? 1, 10) || 1),
    name: li.name || li.product_name || "",
    price: parseFloat(li.item_price ?? li.paid_price ?? li.price ?? 0) || 0,
  }));

  const ship = order.address_shipping || order.address_billing || {};
  const raw = { ...order, line_items: lineItems.length ? lineItems : items };

  return {
    external_id: orderId,
    order_number: order.order_number || orderId,
    email: order.customer_email || order.buyer_email || "",
    total: parseFloat(order.price ?? order.total_amount ?? order.grand_total ?? 0) || 0,
    financial_status: order.payment_method || order.statuses?.[0] || "",
    fulfillment_status: order.statuses?.join(",") || order.status || "",
    source: "daraz",
    raw,
  };
}

function tokenFieldsFromDaraz(data, extras = {}) {
  return {
    oauth_connected: "true",
    authorization_code: "",
    access_token: data.access_token,
    refresh_token: data.refresh_token || extras.refresh_token || "",
    expires_in: data.expires_in != null ? String(data.expires_in) : "",
    refresh_expires_in:
      data.refresh_expires_in != null ? String(data.refresh_expires_in) : extras.refresh_expires_in || "",
  };
}

export class DarazIntegration {
  static async exchangeCode(authorizationCode) {
    const data = await exchangeAuthorizationCode(authorizationCode);
    const seller = await fetchSellerProfile(data.access_token);
    const shortCode = String(seller.short_code || "").trim();
    if (!shortCode) {
      throw new Error("Daraz seller profile did not return a shop short code");
    }

    const apiHost = new URL(process.env.DARAZ_API_URL || "https://api.daraz.pk/rest").hostname;
    const storefrontHost = apiHost.replace(/^api\./i, "www.");
    return {
      ...tokenFieldsFromDaraz(data),
      storefront_url: `https://${storefrontHost}/shop/${encodeURIComponent(shortCode)}/`,
      shop_name: String(seller.name || "").trim(),
      shop_short_code: shortCode,
    };
  }

  static async refreshToken(credentials) {
    const refresh = String(credentials?.refresh_token || "").trim();
    if (!refresh) {
      throw new Error(
        "Daraz access token expired and no refresh token is stored. Connect Daraz again in Company Integrations."
      );
    }
    const cacheKey = createHash("sha256").update(refresh).digest("hex");
    const now = Date.now();
    for (const [key, result] of refreshResults) {
      if (result.expiresAt <= now) refreshResults.delete(key);
    }
    const cached = refreshResults.get(cacheKey);
    if (cached) return cached.promise;

    console.warn("[Daraz] access_token rejected; refreshing…");
    const result = { expiresAt: Number.POSITIVE_INFINITY };
    result.promise = refreshAuthorizationToken(refresh)
      .then((data) => tokenFieldsFromDaraz(data, { refresh_token: refresh }))
      .then(
        (credentials) => {
          result.expiresAt = Date.now() + REFRESH_RESULT_TTL_MS;
          return credentials;
        },
        (error) => {
          result.expiresAt = Date.now() + REFRESH_FAILURE_TTL_MS;
          throw error;
        }
      );
    refreshResults.set(cacheKey, result);
    return result.promise;
  }

  static async ensureAccessToken(credentials) {
    const creds = decryptStoredCredentials(credentials || {});
    const code = typeof creds.authorization_code === "string" ? creds.authorization_code.trim() : "";
    if (code) {
      const exchanged = await DarazIntegration.exchangeCode(code);
      return { ...creds, ...exchanged };
    }
    if (creds.access_token) return creds;
    throw new Error(
      "Daraz is not fully connected. Open Company Integrations, select Daraz, and connect again."
    );
  }

  static isAccessTokenError(err) {
    const msg = String(err?.message || err || "");
    return /IllegalAccessToken|access token is invalid|token.*expired|Invalid access_token/i.test(msg);
  }

  /**
   * Run fn(accessToken); on expired token, refresh once and retry.
   * Mutates `credentials` in place when refreshed so callers can persist it.
   */
  static async withRefreshedAccess(credentials, fn) {
    let creds = await DarazIntegration.ensureAccessToken(credentials);
    Object.assign(credentials, creds);
    try {
      return await fn(creds.access_token);
    } catch (err) {
      if (!DarazIntegration.isAccessTokenError(err)) throw err;
      if (!String(creds.refresh_token || "").trim()) {
        throw new Error(
          "Daraz access token is invalid or expired and no refresh token is available. Reconnect Daraz in Company Integrations."
        );
      }
      let refreshed;
      try {
        refreshed = await DarazIntegration.refreshToken(creds);
      } catch (refreshError) {
        if (DarazIntegration.isAccessTokenError(refreshError)) {
          throw new Error(
            "Daraz authorization could not be refreshed. Reconnect Daraz in Company Integrations."
          );
        }
        throw refreshError;
      }
      if (refreshed.access_token === creds.access_token) {
        throw new Error(
          "Daraz returned the same rejected access token. Reconnect Daraz in Company Integrations."
        );
      }
      creds = { ...creds, ...refreshed };
      Object.assign(credentials, creds);
      try {
        return await fn(creds.access_token);
      } catch (retryError) {
        if (DarazIntegration.isAccessTokenError(retryError)) {
          throw new Error(
            "Daraz rejected its refreshed access token. Reconnect Daraz in Company Integrations."
          );
        }
        throw retryError;
      }
    }
  }

  static async fetchProducts(credentials) {
    const creds = credentials || {};
    return DarazIntegration.withRefreshedAccess(creds, async (accessToken) => {
      const limit = 50;
      let offset = 0;
      const out = [];
      let total = null;

      for (let page = 0; page < 100; page++) {
        const data = await fetchProductsPage(accessToken, { offset, limit, filter: "all" });
        const products = Array.isArray(data.products) ? data.products : [];
        if (total == null && data.total_products != null) {
          total = Number(data.total_products);
        }
        for (const item of products) {
          const mapped = mapDarazProduct(item);
          if (mapped.external_id) out.push(mapped);
        }
        if (products.length < limit) break;
        offset += limit;
        if (total != null && offset >= total) break;
      }
      return out;
    });
  }

  /** Pull orders from Daraz (last ~30 days). */
  static async fetchOrders(credentials) {
    const creds = credentials || {};
    return DarazIntegration.withRefreshedAccess(creds, async (accessToken) => {
      const createdAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const limit = 50;
      let offset = 0;
      const all = [];

      for (let page = 0; page < 50; page++) {
        const data = await fetchOrdersPage(accessToken, { offset, limit, createdAfter });
        const orders = Array.isArray(data.orders) ? data.orders : [];
        for (const order of orders) {
          const orderId = order.order_id ?? order.order_number;
          let items = [];
          if (orderId) {
            try {
              const itemData = await fetchOrderItems(accessToken, orderId);
              items = Array.isArray(itemData) ? itemData : itemData.order_items || [];
            } catch (err) {
              if (DarazIntegration.isAccessTokenError(err)) throw err;
              console.warn("[Daraz] order items fetch failed for", orderId, err.message);
            }
          }
          if (items.length === 0 && Array.isArray(order.order_items)) {
            items = order.order_items;
          }
          all.push(mapDarazOrder(order, items));
        }
        if (orders.length < limit) break;
        offset += limit;
        const count = data.count != null ? Number(data.count) : null;
        if (count != null && offset >= count) break;
      }

      return all;
    });
  }

  /**
   * Resolve a seller SKU to Daraz's internal SkuId for price/quantity updates.
   */
  static async findSkuIdBySellerSku(credentials, sellerSku) {
    const wanted = String(sellerSku || "").trim().toLowerCase();
    if (!wanted) return "";

    const products = await DarazIntegration.fetchProducts(credentials || {});
    for (const product of products) {
      const variant = product.variants?.find(
        (candidate) => String(candidate.sku || "").trim().toLowerCase() === wanted
      );
      if (variant?.sku_id) return String(variant.sku_id).trim();
      if (String(product.sku || "").trim().toLowerCase() === wanted && product.sku_id) {
        return String(product.sku_id).trim();
      }
    }
    return "";
  }

  /**
   * Push stock/price to Daraz using its internal SkuId.
   * @returns {{ success: boolean, error?: string }}
   */
  static async setInventory(credentials, { sellerSku, skuId, quantity, price }) {
    try {
      const creds = credentials || {};
      const normalizedSellerSku = String(sellerSku || "").trim();
      let resolvedSkuId = String(skuId || "").trim();
      if (
        !resolvedSkuId ||
        (normalizedSellerSku && resolvedSkuId.toLowerCase() === normalizedSellerSku.toLowerCase())
      ) {
        resolvedSkuId = await DarazIntegration.findSkuIdBySellerSku(creds, normalizedSellerSku);
      }
      if (!resolvedSkuId) {
        return {
          success: false,
          error: normalizedSellerSku
            ? `Could not find a Daraz SkuId for SellerSku "${normalizedSellerSku}".`
            : "Daraz SKU mapping is missing (SkuId required).",
        };
      }

      const update = (resolvedId) =>
        DarazIntegration.withRefreshedAccess(creds, async (accessToken) => {
          await updateProductPriceQuantity(accessToken, [
            {
              skuId: resolvedId,
              quantity,
              price: price != null ? price : undefined,
            },
          ]);
        });
      try {
        await update(resolvedSkuId);
      } catch (err) {
        if (!normalizedSellerSku || !/E4185|E0501/i.test(String(err?.message || err))) {
          throw err;
        }
        const lookedUpSkuId = await DarazIntegration.findSkuIdBySellerSku(creds, normalizedSellerSku);
        if (!lookedUpSkuId || lookedUpSkuId === resolvedSkuId) throw err;
        await update(lookedUpSkuId);
        resolvedSkuId = lookedUpSkuId;
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Create a new listing on Daraz (category, attributes, images, SKU).
   */
  static async createProduct(credentials, product) {
    const creds = credentials || {};
    return DarazIntegration.withRefreshedAccess(creds, (accessToken) =>
      createDarazProduct(accessToken, product)
    );
  }

  /**
   * Sync local product to Daraz: create listing if not mapped, else update stock/price.
   */
  static async pushProduct(credentials, product, channelMapping = {}) {
    const productSku = (product.sku || product.variants?.[0]?.sku || "").trim();
    const existingItemId =
      channelMapping.channel_product_id ||
      (product.source === "daraz" ? product.external_id : "") ||
      "";
    const sellerSku = (
      existingItemId ? channelMapping.channel_seller_sku || productSku : productSku
    ).trim();

    if (!existingItemId) {
      const created = await DarazIntegration.createProduct(credentials, {
        ...product,
        sku: productSku,
      });
      return {
        external_id: created.item_id || null,
        channel_product_id: created.item_id || null,
        channel_variant_id: created.sku_id || null,
        channel_seller_sku: created.seller_sku || sellerSku || null,
        created: true,
      };
    }

    const skuId =
      channelMapping.channel_variant_id ||
      product.variants?.[0]?.sku_id ||
      product.sku_id ||
      "";
    const qty =
      typeof product.inventory_quantity === "number"
        ? product.inventory_quantity
        : typeof product.quantity === "number"
          ? product.quantity
          : undefined;
    const price = product.price != null ? product.price : product.variants?.[0]?.price;

    const result = await DarazIntegration.setInventory(credentials, {
      sellerSku: sellerSku || undefined,
      skuId: skuId || undefined,
      quantity: qty,
      price,
    });

    if (!result.success) {
      throw new Error(result.error || "Daraz product sync failed");
    }

    return {
      external_id: existingItemId,
      channel_product_id: existingItemId,
      channel_variant_id: skuId || null,
      channel_seller_sku: channelMapping.channel_seller_sku || sellerSku || null,
      created: false,
    };
  }
}
