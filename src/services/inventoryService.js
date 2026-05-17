import { ObjectId } from "mongodb";

/**
 * Ensure an inventory document exists for a product (create with quantity 0, allocated 0 if missing).
 * @param {object} tenantDb - Tenant MongoDB database
 * @param {ObjectId|string} productId - Product _id
 * @returns {Promise<{ quantity: number, allocated: number }>}
 */
export async function ensureInventoryForProduct(tenantDb, productId) {
  const pid = productId instanceof ObjectId ? productId : new ObjectId(String(productId));
  const coll = tenantDb.collection("inventory");
  const existing = await coll.findOne({ product_id: pid });
  if (existing) {
    return {
      quantity: typeof existing.quantity === "number" ? existing.quantity : 0,
      allocated: typeof existing.allocated === "number" ? existing.allocated : 0,
    };
  }
  const now = new Date();
  await coll.insertOne({
    product_id: pid,
    quantity: 0,
    allocated: 0,
    updated_at: now,
  });
  return { quantity: 0, allocated: 0 };
}

/**
 * Get inventory for a product (or null if not found).
 */
export async function getInventoryByProductId(tenantDb, productId) {
  const pid = productId instanceof ObjectId ? productId : new ObjectId(String(productId));
  const doc = await tenantDb.collection("inventory").findOne({ product_id: pid });
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    product_id: doc.product_id.toString(),
    quantity: typeof doc.quantity === "number" ? doc.quantity : 0,
    allocated: typeof doc.allocated === "number" ? doc.allocated : 0,
    updated_at: doc.updated_at,
  };
}

/**
 * Update inventory quantity (and optionally trigger channel sync elsewhere).
 * @returns {Promise<{ quantity: number, allocated: number } | null>}
 */
export async function updateInventoryQuantity(tenantDb, productId, quantity, options = {}) {
  const pid = productId instanceof ObjectId ? productId : new ObjectId(String(productId));
  const coll = tenantDb.collection("inventory");
  const existing = await coll.findOne({ product_id: pid });
  const previousQuantity =
    typeof existing?.quantity === "number" ? existing.quantity : 0;
  const num = typeof quantity === "number" && !Number.isNaN(quantity) ? Math.max(0, Math.floor(quantity)) : 0;
  const result = await coll.findOneAndUpdate(
    { product_id: pid },
    {
      $set: { quantity: num, updated_at: new Date() },
      $setOnInsert: { product_id: pid, allocated: 0 },
    },
    { returnDocument: "after", upsert: true }
  );
  if (!result) return null;

  const { tenantName } = options;
  if (tenantName) {
    const { onInventoryQuantityChanged } = await import("./stockAlertService.js");
    await onInventoryQuantityChanged(tenantDb, tenantName, pid, previousQuantity, num);
  }

  return {
    quantity: typeof result.quantity === "number" ? result.quantity : 0,
    allocated: typeof result.allocated === "number" ? result.allocated : 0,
  };
}

/**
 * Add or subtract allocated for a product (e.g. when order is created vs deleted/dispatched).
 */
export async function adjustAllocated(tenantDb, productId, delta) {
  const pid = productId instanceof ObjectId ? productId : new ObjectId(String(productId));
  const coll = tenantDb.collection("inventory");
  await ensureInventoryForProduct(tenantDb, pid);
  const num = typeof delta === "number" && !Number.isNaN(delta) ? delta : 0;
  const result = await coll.findOneAndUpdate(
    { product_id: pid },
    { $inc: { allocated: num }, $set: { updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) return null;
  return {
    quantity: typeof result.quantity === "number" ? result.quantity : 0,
    allocated: Math.max(0, typeof result.allocated === "number" ? result.allocated : 0),
  };
}

/**
 * Decrease allocated for each line_item on an order (call when order is deleted or dispatched).
 * line_items: [{ product_id: string|ObjectId, quantity: number }]
 */
export async function decreaseAllocatedForOrderLineItems(tenantDb, order) {
  const lineItems = order?.line_items;
  if (!Array.isArray(lineItems) || lineItems.length === 0) return;
  for (const line of lineItems) {
    const productId = line.product_id;
    const qty = typeof line.quantity === "number" ? line.quantity : 0;
    if (productId && qty > 0) {
      await adjustAllocated(tenantDb, productId, -qty);
    }
  }
}

/**
 * Increase allocated for each line_item (call when a new order is created with line_items).
 */
/**
 * Push current stock level to mapped Shopify/Daraz listings for one product.
 */
export async function syncProductInventoryToChannels(tenantDb, product, quantity) {
  if (!product?.company_id) return;
  const pid = product._id instanceof ObjectId ? product._id : new ObjectId(String(product._id));
  const qty = typeof quantity === "number" && !Number.isNaN(quantity) ? Math.max(0, Math.floor(quantity)) : 0;
  const { getAuthDb } = await import("../db/authDb.js");
  const { ShopifyIntegration } = await import("../integrations/Shopify.js");
  const { DarazIntegration } = await import("../integrations/Daraz.js");
  const authDb = await getAuthDb();
  const cpColl = tenantDb.collection("channel_products");
  const ciColl = tenantDb.collection("company_integrations");
  const companyOid =
    product.company_id instanceof ObjectId ? product.company_id : new ObjectId(product.company_id);

  const shopifyCp = await cpColl.findOne({
    product_id: pid,
    channel_name: "shopify",
    channel_inventory_item_id: { $nin: [null, ""] },
  });
  if (shopifyCp) {
    const shopifyIntegration = await authDb.collection("integrations").findOne({ slug: "shopify" });
    if (shopifyIntegration) {
      const ci = await ciColl.findOne({
        company_id: { $in: [companyOid, companyOid.toString()] },
        integration_id: { $in: [shopifyIntegration._id, shopifyIntegration._id.toString()] },
        status: 1,
      });
      if (ci?.credentials) {
        try {
          const setResult = await ShopifyIntegration.setInventory(
            ci.credentials,
            shopifyCp.channel_inventory_item_id,
            qty
          );
          if (!setResult.success) {
            console.error("[Shopify] Inventory sync after product save failed:", setResult.error);
          }
        } catch (e) {
          console.error("[Shopify] Inventory sync after product save failed:", e?.message);
        }
      }
    }
  }

  const darazCp = await cpColl.findOne({ product_id: pid, channel_name: "daraz" });
  if (darazCp && (darazCp.channel_seller_sku || darazCp.channel_variant_id || product.sku)) {
    const darazIntegration = await authDb.collection("integrations").findOne({ slug: "daraz" });
    if (darazIntegration) {
      const darazCi = await ciColl.findOne({
        company_id: { $in: [companyOid, companyOid.toString()] },
        integration_id: { $in: [darazIntegration._id, darazIntegration._id.toString()] },
        status: 1,
      });
      if (darazCi?.credentials) {
        try {
          let darazCreds = await DarazIntegration.ensureAccessToken(darazCi.credentials);
          const setResult = await DarazIntegration.setInventory(darazCreds, {
            sellerSku: darazCp.channel_seller_sku || product.sku || "",
            skuId: darazCp.channel_variant_id || "",
            quantity: qty,
            price: product.price != null ? product.price : undefined,
          });
          if (!setResult.success) {
            console.error("[Daraz] Inventory sync after product save failed:", setResult.error);
          }
        } catch (e) {
          console.error("[Daraz] Inventory sync after product save failed:", e?.message);
        }
      }
    }
  }
}

export async function increaseAllocatedForOrderLineItems(tenantDb, lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return;
  for (const line of lineItems) {
    const productId = line.product_id;
    const qty = typeof line.quantity === "number" ? line.quantity : 0;
    if (productId && qty > 0) {
      await adjustAllocated(tenantDb, productId, qty);
    }
  }
}
