import { ObjectId } from "mongodb";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb, tenantDbExists } from "../db/tenantDb.js";
import { increaseAllocatedForOrderLineItems } from "./inventoryService.js";
import { ShopifyIntegration } from "../integrations/Shopify.js";
import { DarazIntegration } from "../integrations/Daraz.js";

const INTEGRATION_CLASSES = {
  shopify: ShopifyIntegration,
  daraz: DarazIntegration,
};

/**
 * Run order import for a single tenant: find active company_integrations, fetch orders, save to orders collection.
 */
export async function runOrderImportForTenant(tenantName) {
  if (!(await tenantDbExists(tenantName))) return { imported: 0, errors: [] };
  const tenantDb = await getTenantDb(tenantName);
  const authDb = await getAuthDb();
  const integrationsColl = authDb.collection("integrations");
  const companyIntegrations = tenantDb.collection("company_integrations");
  const ordersColl = tenantDb.collection("orders");
  const productsColl = tenantDb.collection("products");

  // Only integrations that have orders feature (or no features field = all)
  const active = await companyIntegrations
    .find({
      status: 1,
      $or: [{ features: { $exists: false } }, { features: "orders" }],
    })
    .toArray();
  let totalImported = 0;
  let totalUpdated = 0;
  let totalFetched = 0;
  const errors = [];

  for (const ci of active) {
    const integrationId = typeof ci.integration_id === "string" ? new ObjectId(ci.integration_id) : ci.integration_id;
    const integration = await integrationsColl.findOne({ _id: integrationId });
    const slug = integration?.slug || String(ci.integration_id);
    const Klass = INTEGRATION_CLASSES[slug];
    if (!Klass || !Klass.fetchOrders) {
      errors.push({ company_integration_id: ci._id.toString(), error: `Unknown integration: ${slug}` });
      continue;
    }
    try {
      let credentials = ci.credentials || {};
      if (slug === "daraz") {
        credentials = await DarazIntegration.ensureAccessToken(credentials);
        if (credentials.access_token && credentials.access_token !== ci.credentials?.access_token) {
          await companyIntegrations.updateOne(
            { _id: ci._id },
            { $set: { credentials, updated_at: new Date() } }
          );
        }
      }
      const orders = await Klass.fetchOrders(credentials);
      totalFetched += orders.length;
      const companyOid = ci.company_id ? (typeof ci.company_id === "string" ? new ObjectId(ci.company_id) : ci.company_id) : null;
      for (const order of orders) {
        const existing = await ordersColl.findOne({ external_id: order.external_id, source: order.source || slug });
        const raw = order.raw || {};
        const ship = raw.shipping_address || raw.shippingAddress || {};
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
        const lineItems = [];
        const rawLines = raw.line_items || [];
        for (const li of rawLines) {
          const sku = li.sku != null ? String(li.sku).trim() : "";
          const qty = Math.max(0, parseInt(li.quantity ?? li.fulfillable_quantity ?? 1, 10) || 0);
          if (!sku || qty === 0) continue;
          const productFilter = companyOid
            ? { company_id: { $in: [companyOid, companyOid.toString()] }, $or: [{ sku }, { "variants.sku": sku }] }
            : { $or: [{ sku }, { "variants.sku": sku }] };
          const product = await productsColl.findOne(productFilter);
          if (product) {
            lineItems.push({ product_id: product._id, quantity: qty });
          }
        }
        if (!existing) {
          await ordersColl.insertOne({
            company_id: companyOid,
            status: "imported",
            external_id: order.external_id,
            order_number: order.order_number,
            email: order.email,
            total: order.total,
            financial_status: order.financial_status,
            fulfillment_status: order.fulfillment_status,
            source: order.source || slug,
            raw,
            shipping_address,
            line_items: lineItems,
            created_at: new Date(),
            updated_at: new Date(),
          });
          await increaseAllocatedForOrderLineItems(tenantDb, lineItems);
          totalImported++;
        } else {
          await ordersColl.updateOne(
            { external_id: order.external_id, source: order.source || slug },
            { $set: { shipping_address, raw, line_items: lineItems, updated_at: new Date() } }
          );
          totalUpdated++;
        }
      }
    } catch (err) {
      errors.push({
        company_integration_id: ci._id.toString(),
        error: err.message || String(err),
      });
    }
  }

  return { imported: totalImported, updated: totalUpdated, fetched: totalFetched, errors };
}

/**
 * Run order import for all approved tenants (for cron).
 */
export async function runOrderImportForAllTenants() {
  const authDb = await getAuthDb();
  const tenants = await authDb.collection("tenants").find({ status: "approved" }).toArray();
  const results = {};
  for (const t of tenants) {
    const name = t.tenant_name;
    try {
      results[name] = await runOrderImportForTenant(name);
    } catch (err) {
      results[name] = { imported: 0, errors: [err.message] };
    }
  }
  return results;
}
