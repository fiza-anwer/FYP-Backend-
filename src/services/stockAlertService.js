import { ObjectId } from "mongodb";
import { getAuthDb } from "../db/authDb.js";
import { config } from "../config.js";
import { sendOutOfStockEmail } from "./emailService.js";

const ALERTS_COLLECTION = "stock_alerts";

async function ensureAlertIndexes(tenantDb) {
  const coll = tenantDb.collection(ALERTS_COLLECTION);
  await coll.createIndex({ product_id: 1, active: 1 }).catch(() => {});
  await coll.createIndex({ active: 1, read_at: 1, created_at: -1 }).catch(() => {});
}

async function getProductSummary(tenantDb, productId) {
  const pid = productId instanceof ObjectId ? productId : new ObjectId(String(productId));
  const p = await tenantDb.collection("products").findOne({ _id: pid });
  if (!p) return null;
  return {
    product_id: pid,
    title: p.title || "Product",
    sku: p.sku || "",
    company_id: p.company_id ? String(p.company_id) : null,
  };
}

async function resolveTenantNotifyEmail(tenantName) {
  const authDb = await getAuthDb();
  const tenant = await authDb.collection("tenants").findOne({
    tenant_name: tenantName,
    status: "approved",
  });
  return tenant?.email ? String(tenant.email).trim().toLowerCase() : null;
}

/**
 * Call when inventory quantity changes (manual adjust, import, etc.).
 */
export async function onInventoryQuantityChanged(
  tenantDb,
  tenantName,
  productId,
  previousQuantity,
  newQuantity
) {
  if (!tenantDb || !tenantName || !productId) return;

  const prev = typeof previousQuantity === "number" ? previousQuantity : 0;
  const next = typeof newQuantity === "number" ? newQuantity : 0;
  if (prev === next) return;

  await ensureAlertIndexes(tenantDb);
  const coll = tenantDb.collection(ALERTS_COLLECTION);
  const pid = productId instanceof ObjectId ? productId : new ObjectId(String(productId));
  const now = new Date();

  if (next > 0) {
    await coll.updateMany(
      { product_id: pid, active: true },
      { $set: { active: false, resolved_at: now } }
    );
    return;
  }

  if (next !== 0 || prev <= 0) return;

  const summary = await getProductSummary(tenantDb, pid);
  if (!summary) return;

  const existingActive = await coll.findOne({ product_id: pid, active: true });
  if (existingActive) return;

  const alertDoc = {
    product_id: pid,
    title: summary.title,
    sku: summary.sku,
    quantity: 0,
    active: true,
    created_at: now,
    read_at: null,
    email_sent_at: null,
  };

  const insertResult = await coll.insertOne(alertDoc);
  const notifyEmail = await resolveTenantNotifyEmail(tenantName);
  if (notifyEmail) {
    try {
      const emailRes = await sendOutOfStockEmail({
        to: notifyEmail,
        tenantName,
        productTitle: summary.title,
        sku: summary.sku,
        appUrl: config.frontendOrigin,
      });
      if (emailRes.sent) {
        await coll.updateOne(
          { _id: insertResult.insertedId },
          { $set: { email_sent_at: new Date() } }
        );
      }
    } catch (err) {
      console.error("[StockAlert] Email failed:", err.message);
    }
  }
}

/** Unread / active out-of-stock alerts for login banner and API. */
export async function listActiveStockAlerts(tenantDb, { limit = 50 } = {}) {
  await ensureAlertIndexes(tenantDb);
  const coll = tenantDb.collection(ALERTS_COLLECTION);
  const alerts = await coll
    .find({ active: true, read_at: null })
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();

  return alerts.map((a) => ({
    id: a._id.toString(),
    product_id: a.product_id.toString(),
    title: a.title || "",
    sku: a.sku || "",
    quantity: 0,
    created_at: a.created_at,
    email_sent: !!a.email_sent_at,
  }));
}

/** Also include products at qty 0 that may not have an alert row yet (e.g. before feature existed). */
export async function listZeroStockProducts(tenantDb, { limit = 50 } = {}) {
  const inventoryColl = tenantDb.collection("inventory");
  const productsColl = tenantDb.collection("products");
  const zeroInv = await inventoryColl
    .find({ quantity: 0 })
    .sort({ updated_at: -1 })
    .limit(limit)
    .toArray();

  const out = [];
  for (const inv of zeroInv) {
    const p = await productsColl.findOne({ _id: inv.product_id });
    if (!p) continue;
    out.push({
      product_id: inv.product_id.toString(),
      title: p.title || "",
      sku: p.sku || "",
      quantity: 0,
      updated_at: inv.updated_at,
    });
  }
  return out;
}

export async function getStockAlertSummaryForTenant(tenantDb) {
  const alerts = await listActiveStockAlerts(tenantDb);
  const zeroProducts = await listZeroStockProducts(tenantDb);
  const alertProductIds = new Set(alerts.map((a) => a.product_id));
  const merged = [...alerts];
  for (const z of zeroProducts) {
    if (!alertProductIds.has(z.product_id)) {
      merged.push({
        id: null,
        product_id: z.product_id,
        title: z.title,
        sku: z.sku,
        quantity: 0,
        created_at: z.updated_at,
        email_sent: false,
      });
    }
  }
  return {
    count: merged.length,
    alerts: merged.slice(0, 50),
    email_configured: !!config.smtpHost,
  };
}

export async function markStockAlertsRead(tenantDb, { alertIds = null } = {}) {
  await ensureAlertIndexes(tenantDb);
  const coll = tenantDb.collection(ALERTS_COLLECTION);
  const now = new Date();
  const filter = { active: true, read_at: null };
  if (Array.isArray(alertIds) && alertIds.length > 0) {
    const oids = alertIds
      .map((id) => {
        try {
          return new ObjectId(id);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (oids.length) filter._id = { $in: oids };
  }
  await coll.updateMany(filter, { $set: { read_at: now } });
}

/** Periodic scan: catch zero stock from imports without going through updateInventoryQuantity. */
export async function scanZeroStockForTenant(tenantName) {
  const { getTenantDb, tenantDbExists } = await import("../db/tenantDb.js");
  if (!(await tenantDbExists(tenantName))) return { checked: 0 };
  const tenantDb = await getTenantDb(tenantName);
  const inventoryColl = tenantDb.collection("inventory");
  const zeros = await inventoryColl.find({ quantity: 0 }).toArray();
  const alertColl = tenantDb.collection(ALERTS_COLLECTION);
  let triggered = 0;
  for (const inv of zeros) {
    const hasActive = await alertColl.findOne({ product_id: inv.product_id, active: true });
    if (hasActive) continue;
    await onInventoryQuantityChanged(tenantDb, tenantName, inv.product_id, 1, 0);
    triggered++;
  }
  return { checked: zeros.length, triggered };
}

export async function scanZeroStockForAllTenants() {
  const authDb = await getAuthDb();
  const tenants = await authDb.collection("tenants").find({ status: "approved" }).toArray();
  for (const t of tenants) {
    try {
      await scanZeroStockForTenant(t.tenant_name);
    } catch (err) {
      console.error("[StockAlert] scan failed for", t.tenant_name, err.message);
    }
  }
}
