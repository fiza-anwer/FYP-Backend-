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
export async function updateInventoryQuantity(tenantDb, productId, quantity) {
  const pid = productId instanceof ObjectId ? productId : new ObjectId(String(productId));
  const coll = tenantDb.collection("inventory");
  const num = typeof quantity === "number" && !Number.isNaN(quantity) ? Math.max(0, Math.floor(quantity)) : 0;
  const result = await coll.findOneAndUpdate(
    { product_id: pid },
    { $set: { quantity: num, updated_at: new Date() } },
    { returnDocument: "after", upsert: true }
  );
  if (!result) return null;
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
