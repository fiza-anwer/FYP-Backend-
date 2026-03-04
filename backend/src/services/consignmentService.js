import { ObjectId } from "mongodb";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb } from "../db/tenantDb.js";
import { DHLIntegration } from "../integrations/DHL.js";

const CARRIER_CLASSES = {
  dhl: DHLIntegration,
};

/** Returns true if order has at least one of address1, city, postal_code, country_code. */
function hasValidShippingAddress(order) {
  const ship = order?.shipping_address || order?.raw?.shipping_address || order?.raw?.shippingAddress || {};
  const address1 = ship.address1 || ship.address_1 || "";
  const city = ship.city || "";
  const postal = ship.postal_code || ship.zip || ship.postal_code_zip || "";
  const country = (ship.country_code || ship.country || "").toString().trim();
  return !!(address1 || city || postal || country);
}

/**
 * Create consignments for the given orders using the selected carrier integration and service.
 * @param {string} tenantName
 * @param {string[]} orderIds - tenant order _id strings
 * @param {string} carrierIntegrationId - tenant carrier_integration _id
 * @param {string} carrierServiceId - auth carrier_service _id
 * @returns {{ created: number, errors: Array<{ order_id: string, error: string }> }}
 */
export async function createConsignments(tenantName, orderIds, carrierIntegrationId, carrierServiceId) {
  const tenantDb = await getTenantDb(tenantName);
  const authDb = await getAuthDb();
  const ordersColl = tenantDb.collection("orders");
  const consignmentsColl = tenantDb.collection("consignments");
  const ci = await tenantDb.collection("carrier_integrations").findOne({ _id: new ObjectId(carrierIntegrationId) });
  if (!ci) {
    throw new Error("Carrier integration not found");
  }
  const carrier = await authDb.collection("carriers").findOne({ _id: new ObjectId(ci.carrier_id) });
  if (!carrier) {
    throw new Error("Carrier not found");
  }
  const Klass = CARRIER_CLASSES[carrier.slug];
  if (!Klass || !Klass.createShipment) {
    throw new Error(`Carrier ${carrier.slug} is not supported for creating shipments`);
  }
  const service = await authDb.collection("carrier_services").findOne({
    _id: new ObjectId(carrierServiceId),
    carrier_id: carrier._id,
  });
  if (!service) {
    throw new Error("Carrier service not found for this carrier");
  }

  let created = 0;
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
    const existing = await consignmentsColl.findOne({ order_id: orderId });
    if (existing) {
      errors.push({ order_id: orderIdStr, error: "Order already has a consignment" });
      continue;
    }
    if (!hasValidShippingAddress(order)) {
      errors.push({ order_id: orderIdStr, error: "Order has no shipping address; add a destination before creating a label" });
      continue;
    }
    let company = null;
    if (order.company_id) {
      company = await tenantDb.collection("companies").findOne({ _id: order.company_id });
    }
    try {
      const result = await Klass.createShipment(ci.credentials || {}, order, service.code || "", company);
      const doc = {
        order_id: orderId,
        carrier_integration_id: carrierIntegrationId,
        carrier_service_id: carrierServiceId,
        tracking_number: result.trackingNumber,
        label_url: result.labelUrl || null,
        tracking_url: result.trackingUrl || null,
        status: "consigned",
        created_at: new Date(),
        updated_at: new Date(),
      };
      await consignmentsColl.insertOne(doc);
      await ordersColl.updateOne(
        { _id: orderId },
        { $set: { status: "consigned", updated_at: new Date() } }
      );
      created++;
    } catch (err) {
      errors.push({ order_id: orderIdStr, error: err.message || String(err) });
    }
  }
  return { created, errors };
}
