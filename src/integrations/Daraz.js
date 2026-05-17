import {
  exchangeAuthorizationCode,
  fetchProductsPage,
  fetchOrdersPage,
  fetchOrderItems,
  updateProductPriceQuantity,
} from "./darazApi.js";
import { createDarazProduct } from "./darazProductCreate.js";

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
    variants: variants.length > 0 ? variants : [{ sku: sellerSku, id: skuId, price, inventory_quantity }],
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

export class DarazIntegration {
  static async exchangeCode(authorizationCode) {
    const data = await exchangeAuthorizationCode(authorizationCode);
    return {
      oauth_connected: "true",
      authorization_code: String(authorizationCode),
      access_token: data.access_token,
      refresh_token: data.refresh_token || "",
      expires_in: data.expires_in != null ? String(data.expires_in) : "",
      refresh_expires_in: data.refresh_expires_in != null ? String(data.refresh_expires_in) : "",
    };
  }

  static async ensureAccessToken(credentials) {
    const creds = credentials || {};
    if (creds.access_token) return creds;
    if (creds.authorization_code) {
      const exchanged = await DarazIntegration.exchangeCode(creds.authorization_code);
      return { ...creds, ...exchanged };
    }
    throw new Error(
      "Daraz is not fully connected. Open Company Integrations, select Daraz, and connect again."
    );
  }

  static async fetchProducts(credentials) {
    const creds = await DarazIntegration.ensureAccessToken(credentials);
    const accessToken = creds.access_token;
    const limit = 50;
    let offset = 0;
    const all = [];
    let total = null;

    for (let page = 0; page < 100; page++) {
      const data = await fetchProductsPage(accessToken, { offset, limit, filter: "all" });
      const products = Array.isArray(data.products) ? data.products : [];
      if (total == null && data.total_products != null) {
        total = Number(data.total_products);
      }
      for (const item of products) {
        const mapped = mapDarazProduct(item);
        if (mapped.external_id) all.push(mapped);
      }
      if (products.length < limit) break;
      offset += limit;
      if (total != null && offset >= total) break;
    }

    return all;
  }

  /** Pull orders from Daraz (last ~30 days). */
  static async fetchOrders(credentials) {
    const creds = await DarazIntegration.ensureAccessToken(credentials);
    const accessToken = creds.access_token;
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
  }

  /**
   * Push stock/price to Daraz for an existing seller SKU or SkuId.
   * @returns {{ success: boolean, error?: string }}
   */
  static async setInventory(credentials, { sellerSku, skuId, quantity, price }) {
    try {
      const creds = await DarazIntegration.ensureAccessToken(credentials);
      if (!sellerSku && !skuId) {
        return { success: false, error: "Daraz SKU mapping missing (SellerSku or SkuId)" };
      }
      await updateProductPriceQuantity(creds.access_token, [
        {
          sellerSku: sellerSku || undefined,
          skuId: skuId || undefined,
          quantity,
          price: price != null ? price : undefined,
        },
      ]);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Create a new listing on Daraz (category, attributes, images, SKU).
   */
  static async createProduct(credentials, product) {
    const creds = await DarazIntegration.ensureAccessToken(credentials);
    return createDarazProduct(creds.access_token, product);
  }

  /**
   * Sync local product to Daraz: create listing if not mapped, else update stock/price.
   */
  static async pushProduct(credentials, product, channelMapping = {}) {
    const sellerSku =
      (channelMapping.channel_seller_sku || product.sku || product.variants?.[0]?.sku || "").trim();
    const existingItemId = channelMapping.channel_product_id || product.external_id || "";

    if (!existingItemId) {
      const created = await DarazIntegration.createProduct(credentials, {
        ...product,
        sku: sellerSku || product.sku,
      });
      return {
        external_id: created.item_id || null,
        channel_product_id: created.item_id || null,
        channel_variant_id: created.sku_id || null,
        channel_seller_sku: created.seller_sku || sellerSku || null,
        created: true,
      };
    }

    const skuId = channelMapping.channel_variant_id || product.variants?.[0]?.id || "";
    const qty =
      typeof product.inventory_quantity === "number"
        ? product.inventory_quantity
        : typeof product.quantity === "number"
          ? product.quantity
          : undefined;
    const price = product.price != null ? product.price : product.variants?.[0]?.price;

    const result = await DarazIntegration.setInventory(credentials, {
      sellerSku: sellerSku || undefined,
      skuId: sellerSku ? undefined : skuId || undefined,
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
      channel_seller_sku: sellerSku || null,
      created: false,
    };
  }
}
