import { ObjectId } from "mongodb";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb, tenantDbExists } from "../db/tenantDb.js";
import { decryptStoredCredentials } from "../db/credentialEncryption.js";
import { increaseAllocatedForOrderLineItems } from "./inventoryService.js";
import { ShopifyIntegration } from "../integrations/Shopify.js";
import { DarazIntegration } from "../integrations/Daraz.js";
import { withPersistedDarazCredentials } from "./darazCredentialService.js";

const INTEGRATION_CLASSES = {
  shopify: ShopifyIntegration,
  daraz: DarazIntegration,
};

const COUNTRY_NAME_TO_ISO = {
  pakistan: "PK",
  "united states": "US",
  "united kingdom": "GB",
  "united arab emirates": "AE",
  india: "IN",
};

/** Accepts "PK" or "Pakistan"; unknown names keep the old behaviour (first 2 letters). */
function toCountryCode(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.length === 2) return v.toUpperCase();
  return COUNTRY_NAME_TO_ISO[v.toLowerCase()] || v.substring(0, 2).toUpperCase();
}

export function normalizeShippingAddress(value) {
  const ship = value && typeof value === "object" ? value : {};
  const addressLines = [
    ship.address1 || ship.address_1,
    ship.address2 || ship.address_2,
    ship.address3 || ship.address_3,
    ship.address4 || ship.address_4,
    ship.address5 || ship.address_5,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  const country = String(ship.country_code || ship.countryCode || ship.country || "").trim();

  return {
    address1: addressLines.join(", "),
    city: String(ship.city || "").trim(),
    postal_code: String(
      ship.postal_code || ship.postal_code_zip || ship.post_code || ship.postcode || ship.zip || ""
    ).trim(),
    country_code: /^(pak|pakistan)$/i.test(country) ? "PK" : toCountryCode(country),
    name: String(
      ship.name ||
        ship.contact_person ||
        [ship.first_name, ship.last_name].filter(Boolean).join(" ") ||
        ""
    ).trim(),
    first_name: String(ship.first_name || "").trim(),
    last_name: String(ship.last_name || "").trim(),
    phone: String(ship.phone || ship.phone1 || ship.mobile || "").trim(),
  };
}

export function mergeShippingAddress(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value) merged[key] = value;
    else if (merged[key] == null) merged[key] = "";
  }
  return merged;
}

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
      let credentials = decryptStoredCredentials(ci.credentials || {});
      if (slug === "daraz") {
        credentials = await DarazIntegration.ensureAccessToken(credentials);
      }
      const orders =
        slug === "daraz"
          ? await withPersistedDarazCredentials(
              companyIntegrations,
              ci,
              credentials,
              () => Klass.fetchOrders(credentials)
            )
          : await Klass.fetchOrders(credentials);
      totalFetched += orders.length;
      const companyOid = ci.company_id ? (typeof ci.company_id === "string" ? new ObjectId(ci.company_id) : ci.company_id) : null;
      for (const order of orders) {
        const existing = await ordersColl.findOne({ external_id: order.external_id, source: order.source || slug });
        const raw = order.raw || {};
        const sourceCreatedAt = raw.created_at || raw.createdAt || order.created_at;
        const parsedCreatedAt = sourceCreatedAt ? new Date(sourceCreatedAt) : null;
        const createdAt = parsedCreatedAt && !Number.isNaN(parsedCreatedAt.getTime())
          ? parsedCreatedAt
          : existing?.created_at || new Date();
        const ship =
          raw.shipping_address ||
          raw.shippingAddress ||
          raw.address_shipping ||
          raw.addressShipping ||
          raw.address_billing ||
          {};
        const shipping_address = normalizeShippingAddress(ship);
        const hasShippingAddress = Object.values(shipping_address).some((value) => Boolean(value));
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
            created_at: createdAt,
            updated_at: new Date(),
          });
          await increaseAllocatedForOrderLineItems(tenantDb, lineItems);
          totalImported++;
        } else {
          const update = {
            raw,
            line_items: lineItems,
            created_at: createdAt,
            updated_at: new Date(),
          };
          if (hasShippingAddress) {
            update.shipping_address = mergeShippingAddress(existing.shipping_address, shipping_address);
          }
          if (typeof order.email === "string" && order.email.trim()) {
            update.email = order.email.trim();
          }
          await ordersColl.updateOne(
            { external_id: order.external_id, source: order.source || slug },
            { $set: update }
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
