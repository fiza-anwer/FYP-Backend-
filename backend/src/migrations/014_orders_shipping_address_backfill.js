/**
 * Backfill top-level shipping_address on orders from raw.shipping_address so address is in DB for labels and API.
 */
import { connectMongo, getTenantDb } from "../db/mongo.js";
import { config } from "../config.js";

const client = await connectMongo();
const authDb = client.db(config.authDbName);
const tenants = await authDb.collection("tenants").find({}).project({ tenant_name: 1 }).toArray();
let totalUpdated = 0;
for (const t of tenants) {
  const tenantName = t.tenant_name;
  if (!tenantName) continue;
  try {
    const db = await getTenantDb(tenantName);
    const orders = await db.collection("orders").find({ $or: [{ shipping_address: { $exists: false } }, { shipping_address: null }], raw: { $exists: true } }).toArray();
    for (const o of orders) {
      const ship = o.raw?.shipping_address || o.raw?.shippingAddress || {};
      const shipping_address = {
        address1: ship.address1 || ship.address_1 || "",
        city: ship.city || "",
        postal_code: ship.zip || ship.postal_code || ship.postal_code_zip || "",
        country_code: (ship.country_code || ship.country || "").toString().substring(0, 2).toUpperCase(),
        name: ship.name || [ship.first_name, ship.last_name].filter(Boolean).join(" ") || "",
        first_name: ship.first_name || "",
        last_name: ship.last_name || "",
        phone: ship.phone || "",
      };
      await db.collection("orders").updateOne(
        { _id: o._id },
        { $set: { shipping_address, updated_at: new Date() } }
      );
      totalUpdated++;
    }
  } catch (e) {
    console.warn("Migration 014: skip tenant", tenantName, e.message);
  }
}
console.log("Migration 014_orders_shipping_address_backfill: backfilled shipping_address for", totalUpdated, "orders.");
console.log("Migration 014_orders_shipping_address_backfill: done.");
