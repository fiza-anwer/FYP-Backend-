import { ObjectId } from "mongodb";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb } from "../db/tenantDb.js";
import { ShopifyIntegration } from "../integrations/Shopify.js";

const CHANNEL_FULFILL_CLASSES = {
  shopify: ShopifyIntegration,
};

function toObjectId(id) {
  if (id == null) return null;
  if (id instanceof ObjectId) return id;
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

/**
 * Dispatch orders: fulfill on channel (e.g. Shopify) with tracking and mark order as dispatched.
 * @param {string} tenantName
 * @param {string[]} orderIds - tenant order _id strings
 * @returns {{ dispatched: number, errors: Array<{ order_id: string, error: string }> }}
 */
export async function dispatchOrders(tenantName, orderIds) {
  const tenantDb = await getTenantDb(tenantName);
  const authDb = await getAuthDb();
  const ordersColl = tenantDb.collection("orders");
  const consignmentsColl = tenantDb.collection("consignments");
  const companyIntegrationsColl = tenantDb.collection("company_integrations");
  const integrationsColl = authDb.collection("integrations");

  const shopifyIntegration = await integrationsColl.findOne({ slug: "shopify" });
  if (!shopifyIntegration) {
    throw new Error("Shopify integration not found in auth");
  }
  const shopifyId = shopifyIntegration._id.toString();

  let dispatched = 0;
  const errors = [];
  for (const orderIdStr of orderIds) {
    let orderId;
    try {
      orderId = new ObjectId(orderIdStr);
    } catch {
      errors.push({ order_id: orderIdStr, error: "Invalid order id" });
      continue;
    }
    const order = await ordersColl.findOne({ _id: orderId });
    if (!order) {
      errors.push({ order_id: orderIdStr, error: "Order not found" });
      continue;
    }
    const ship = order.shipping_address || order.raw?.shipping_address || order.raw?.shippingAddress || {};
    const hasAddress = !!(ship.address1 || ship.address_1 || ship.city || ship.postal_code || ship.zip || ship.postal_code_zip || ship.country_code || ship.country);
    if (!hasAddress) {
      errors.push({ order_id: orderIdStr, error: "Order has no shipping address; cannot dispatch without destination" });
      continue;
    }
    if (order.status === "dispatched") {
      errors.push({ order_id: orderIdStr, error: "Order already dispatched" });
      continue;
    }
    const consignment = await consignmentsColl.findOne({ order_id: orderId });
    if (!consignment || !consignment.tracking_number) {
      errors.push({ order_id: orderIdStr, error: "No consignment with tracking for this order" });
      continue;
    }
    const source = (order.source || "shopify").toLowerCase();
    const FulfillClass = CHANNEL_FULFILL_CLASSES[source];
    if (!FulfillClass || !FulfillClass.fulfillOrder) {
      errors.push({ order_id: orderIdStr, error: `Channel ${source} does not support fulfill` });
      continue;
    }
    const companyId = order.company_id ? order.company_id.toString() : null;
    const shopifyOid = toObjectId(shopifyId);
    const conditions = [{ status: 1 }, { $or: [{ integration_id: shopifyId }, { integration_id: shopifyOid }] }];
    if (companyId) {
      const companyOid = toObjectId(companyId);
      conditions.push({ $or: [{ company_id: companyId }, { company_id: companyOid }] });
    } else {
      conditions.push({ $or: [{ company_id: null }, { company_id: { $exists: false } }] });
    }
    const companyIntegration = await companyIntegrationsColl.findOne({ $and: conditions });
    if (!companyIntegration) {
      errors.push({ order_id: orderIdStr, error: "No active Shopify integration found for this order's company. Add an active Company Integration (Shopify) for this company with valid token." });
      continue;
    }
    try {
      await FulfillClass.fulfillOrder(
        companyIntegration.credentials || {},
        order.external_id,
        consignment.tracking_number,
        consignment.tracking_url
      );
      await ordersColl.updateOne(
        { _id: orderId },
        { $set: { status: "dispatched", fulfillment_status: "fulfilled", updated_at: new Date() } }
      );
      dispatched++;
    } catch (err) {
      errors.push({ order_id: orderIdStr, error: err.message || String(err) });
    }
  }
  return { dispatched, errors };
}
