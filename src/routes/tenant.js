import express from "express";
import { ObjectId } from "mongodb";
import { authMiddleware, tenantOnly } from "../middleware/auth.js";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb, tenantDbExists } from "../db/tenantDb.js";
import { createConsignments } from "../services/consignmentService.js";
import { dispatchOrders } from "../services/dispatchService.js";
import {
  ensureInventoryForProduct,
  getInventoryByProductId,
  updateInventoryQuantity,
  decreaseAllocatedForOrderLineItems,
  syncProductInventoryToChannels,
} from "../services/inventoryService.js";
import { runOrderImportForTenant } from "../services/orderImportService.js";
import {
  runProductImportForTenant,
  runPushPendingProductsForTenant,
  runPushPendingProductsToDarazForTenant,
} from "../services/productImportService.js";
import { syncInventoryToChannelsForTenant } from "../services/inventorySyncService.js";
import { ShopifyIntegration } from "../integrations/Shopify.js";
import { DarazIntegration } from "../integrations/Daraz.js";
import { pushProductToDarazForCompany } from "../services/darazProductPush.js";
import {
  getStockAlertSummaryForTenant,
  markStockAlertsRead,
} from "../services/stockAlertService.js";
import { getDashboardAnalytics } from "../services/dashboardAnalyticsService.js";
import {
  generateProductListingFromKeywords,
  getGeminiAiConfig,
} from "../services/geminiProductService.js";

async function normalizeDarazCredentials(credentials) {
  const creds = credentials || {};
  if (creds.access_token) return creds;
  if (creds.authorization_code) {
    try {
      return await DarazIntegration.exchangeCode(creds.authorization_code);
    } catch (err) {
      console.error("[Daraz] Token exchange failed:", err.message);
      throw new Error(
        "Daraz authorization code expired or invalid. Connect Daraz again in Company Integrations."
      );
    }
  }
  return creds;
}

/** Normalize string or ObjectId to ObjectId for reliable lookups (handles both DB storage formats). */
function toObjectId(id) {
  if (id == null) return null;
  if (id instanceof ObjectId) return id;
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

const router = express.Router();
router.use(authMiddleware);
router.use(tenantOnly);

// ---------- Companies (tenant-scoped) ----------
/** Dashboard analytics: hero products, charts, stale inventory strategies */
router.get("/dashboard/analytics", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    if (!(await tenantDbExists(tenantName))) {
      return res.json({
        hero_product: null,
        hero_product_month: null,
        top_products: [],
        recent_orders: [],
        orders_by_day: [],
        revenue_by_month: [],
        stale_products: [],
        summary: { total_orders: 0, total_products: 0, orders_last_30_days: 0, revenue_this_month: 0 },
      });
    }
    const tenantDb = await getTenantDb(tenantName);
    const data = await getDashboardAnalytics(tenantDb);
    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load dashboard analytics" });
  }
});

/** List companies */
router.get("/companies", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ companies: [] });
    }
    const tenantDb = await getTenantDb(tenantName);
    const list = await tenantDb
      .collection("companies")
      .find({})
      .sort({ name: 1 })
      .toArray();
    return res.json({
      companies: list.map((c) => ({
        id: c._id.toString(),
        name: c.name,
        address: {
          address1: c.address1 || c.address?.address1 || "",
          city: c.city || c.address?.city || "",
          postal_code: c.postal_code || c.address?.postal_code || "",
          country_code: (c.country_code || c.address?.country_code || "").substring(0, 2).toUpperCase(),
        },
        created_at: c.created_at,
        updated_at: c.updated_at,
      })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Create company */
router.post("/companies", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { name, address1, city, postal_code, country_code } = req.body || {};
    const trimmed = (name || "").trim();
    if (!trimmed) {
      return res.status(400).json({ error: "name is required" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const doc = {
      name: trimmed,
      address1: (address1 || "").trim() || undefined,
      city: (city || "").trim() || undefined,
      postal_code: (postal_code || "").trim() || undefined,
      country_code: (country_code || "").trim().substring(0, 2).toUpperCase() || undefined,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const result = await tenantDb.collection("companies").insertOne(doc);
    const out = { id: result.insertedId.toString(), name: doc.name, address: { address1: doc.address1 || "", city: doc.city || "", postal_code: doc.postal_code || "", country_code: doc.country_code || "" }, created_at: doc.created_at, updated_at: doc.updated_at };
    return res.status(201).json(out);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Update company */
router.put("/companies/:id", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    const { name, address1, city, postal_code, country_code } = req.body || {};
    const trimmed = (name || "").trim();
    if (!trimmed) {
      return res.status(400).json({ error: "name is required" });
    }
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const update = {
      name: trimmed,
      updated_at: new Date(),
      ...(address1 !== undefined && { address1: (address1 || "").trim() || null }),
      ...(city !== undefined && { city: (city || "").trim() || null }),
      ...(postal_code !== undefined && { postal_code: (postal_code || "").trim() || null }),
      ...(country_code !== undefined && { country_code: (country_code || "").trim().substring(0, 2).toUpperCase() || null }),
    };
    const result = await tenantDb.collection("companies").findOneAndUpdate(
      { _id: oid },
      { $set: update },
      { returnDocument: "after" }
    );
    if (!result) {
      return res.status(404).json({ error: "Company not found" });
    }
    return res.json({
      id: result._id.toString(),
      name: result.name,
      address: { address1: result.address1 || "", city: result.city || "", postal_code: result.postal_code || "", country_code: result.country_code || "" },
      created_at: result.created_at,
      updated_at: result.updated_at,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Delete company */
router.delete("/companies/:id", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const result = await tenantDb.collection("companies").deleteOne({ _id: oid });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Company not found" });
    }
    return res.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Remove orders and products that belong to deleted companies (orphaned data) */
router.post("/cleanup-orphaned-data", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ deleted_orders: 0, deleted_products: 0, deleted_consignments: 0, deleted_company_integrations: 0 });
    }
    const tenantDb = await getTenantDb(tenantName);
    const companiesColl = tenantDb.collection("companies");
    const validCompanyIds = await companiesColl.find({}).project({ _id: 1 }).toArray();
    const validIds = new Set(validCompanyIds.map((c) => c._id.toString()));

    const ordersColl = tenantDb.collection("orders");
    const productsColl = tenantDb.collection("products");
    const consignmentsColl = tenantDb.collection("consignments");
    const companyIntegrationsColl = tenantDb.collection("company_integrations");

    const orphanedOrderIds = [];
    const orphanedProductIds = [];
    const orphanedCiIds = [];

    const ordersWithCompany = await ordersColl.find({ company_id: { $nin: [null, ""] } }).project({ company_id: 1 }).toArray();
    for (const o of ordersWithCompany) {
      const cid = o.company_id instanceof ObjectId ? o.company_id.toString() : String(o.company_id || "");
      if (cid && !validIds.has(cid)) orphanedOrderIds.push(o._id);
    }

    const productsWithCompany = await productsColl.find({ company_id: { $nin: [null, ""] } }).project({ company_id: 1 }).toArray();
    for (const p of productsWithCompany) {
      const cid = p.company_id instanceof ObjectId ? p.company_id.toString() : String(p.company_id || "");
      if (cid && !validIds.has(cid)) orphanedProductIds.push(p._id);
    }

    const cis = await companyIntegrationsColl.find({ company_id: { $nin: [null, ""] } }).project({ company_id: 1, _id: 1 }).toArray();
    for (const ci of cis) {
      const cid = ci.company_id instanceof ObjectId ? ci.company_id.toString() : String(ci.company_id || "");
      if (cid && !validIds.has(cid)) orphanedCiIds.push(ci._id);
    }

    let deletedConsignments = 0;
    let deletedOrders = 0;
    let deletedProducts = 0;
    let deletedCi = 0;
    if (orphanedOrderIds.length > 0) {
      const orphanedOrders = await ordersColl.find({ _id: { $in: orphanedOrderIds } }).toArray();
      for (const order of orphanedOrders) {
        if (order.status !== "dispatched" && Array.isArray(order.line_items) && order.line_items.length > 0) {
          await decreaseAllocatedForOrderLineItems(tenantDb, order);
        }
      }
      const consignResult = await consignmentsColl.deleteMany({ order_id: { $in: orphanedOrderIds } });
      deletedConsignments = consignResult.deletedCount;
      const r = await ordersColl.deleteMany({ _id: { $in: orphanedOrderIds } });
      deletedOrders = r.deletedCount;
    }
    if (orphanedProductIds.length > 0) {
      const r = await productsColl.deleteMany({ _id: { $in: orphanedProductIds } });
      deletedProducts = r.deletedCount;
    }
    if (orphanedCiIds.length > 0) {
      const r = await companyIntegrationsColl.deleteMany({ _id: { $in: orphanedCiIds } });
      deletedCi = r.deletedCount;
    }

    // Also remove consignments whose order no longer exists (e.g. from a previous cleanup)
    const existingOrderIds = await ordersColl.find({}).project({ _id: 1 }).toArray();
    const existingOrderIdSet = new Set(existingOrderIds.map((o) => o._id.toString()));
    const allConsignments = await consignmentsColl.find({}).project({ order_id: 1 }).toArray();
    const orphanedConsignmentIds = [];
    for (const c of allConsignments) {
      const oid = c.order_id;
      if (!oid) continue;
      const oidStr = oid instanceof ObjectId ? oid.toString() : String(oid);
      if (!existingOrderIdSet.has(oidStr)) orphanedConsignmentIds.push(c._id);
    }
    if (orphanedConsignmentIds.length > 0) {
      const r = await consignmentsColl.deleteMany({ _id: { $in: orphanedConsignmentIds } });
      deletedConsignments += r.deletedCount;
    }

    return res.json({
      deleted_orders: deletedOrders,
      deleted_products: deletedProducts,
      deleted_consignments: deletedConsignments,
      deleted_company_integrations: deletedCi,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Manually sync products, orders, and inventory for the current tenant */
router.post("/sync", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const result = {
      products_imported: 0,
      products_updated: 0,
      products_fetched: 0,
      products_pushed: 0,
      products_pushed_daraz: 0,
      orders_imported: 0,
      orders_updated: 0,
      orders_fetched: 0,
      inventory_synced: 0,
      errors: [],
    };
    const pushRes = await runPushPendingProductsForTenant(tenantName);
    result.products_pushed = pushRes.pushed || 0;
    if (Array.isArray(pushRes.errors) && pushRes.errors.length) {
      result.errors.push(
        ...pushRes.errors.map((e) => ({ scope: "products_push_shopify", error: e.error || String(e) }))
      );
    }
    const pushDarazRes = await runPushPendingProductsToDarazForTenant(tenantName);
    result.products_pushed_daraz = pushDarazRes.pushed || 0;
    if (Array.isArray(pushDarazRes.errors) && pushDarazRes.errors.length) {
      result.errors.push(
        ...pushDarazRes.errors.map((e) => ({ scope: "products_push_daraz", error: e.error || String(e) }))
      );
    }
    // Products import from channel
    const prodRes = await runProductImportForTenant(tenantName);
    result.products_imported = prodRes.imported || 0;
    result.products_updated = prodRes.updated || 0;
    result.products_fetched = prodRes.fetched || 0;
    if (Array.isArray(prodRes.errors) && prodRes.errors.length) {
      result.errors.push(
        ...prodRes.errors.map((e) => ({ scope: "products", error: e.error || String(e) }))
      );
    }
    // Orders
    const orderRes = await runOrderImportForTenant(tenantName);
    result.orders_imported = orderRes.imported || 0;
    result.orders_updated = orderRes.updated || 0;
    result.orders_fetched = orderRes.fetched || 0;
    if (Array.isArray(orderRes.errors) && orderRes.errors.length) {
      result.errors.push(
        ...orderRes.errors.map((e) => ({ scope: "orders", error: e.error || String(e) }))
      );
    }
    // Inventory sync to channels
    const invRes = await syncInventoryToChannelsForTenant(tenantName);
    result.inventory_synced = invRes.synced || 0;
    if (Array.isArray(invRes.errors) && invRes.errors.length) {
      result.errors.push(
        ...invRes.errors.map((e) => ({ scope: "inventory", error: e.error || String(e) }))
      );
    }
    return res.json(result);
  } catch (err) {
    console.error("Manual sync error:", err);
    return res.status(500).json({ error: "Sync failed" });
  }
});

/** List integration types (for dropdown) - from auth DB */
router.get("/integrations", async (req, res) => {
  try {
    const authDb = await getAuthDb();
    const list = await authDb
      .collection("integrations")
      .find({})
      .project({ _id: 1, name: 1, slug: 1, credentials_schema: 1 })
      .toArray();
    return res.json({
      integrations: list.map((i) => ({
        id: i._id.toString(),
        name: i.name,
        slug: i.slug,
        credentials_schema: i.credentials_schema || [],
      })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Normalize features array for company integrations (orders/products/inventory). */
function normalizeIntegrationFeatures(features) {
  const allowed = new Set(["orders", "products", "inventory"]);
  if (!Array.isArray(features)) {
    // Default: all enabled for backward compatibility
    return ["orders", "products", "inventory"];
  }
  const out = [];
  for (const f of features) {
    const key = typeof f === "string" ? f.toLowerCase() : "";
    if (allowed.has(key) && !out.includes(key)) out.push(key);
  }
  return out.length > 0 ? out : ["orders", "products", "inventory"];
}

/** List company integrations - from tenant DB */
router.get("/company-integrations", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ company_integrations: [] });
    }
    const tenantDb = await getTenantDb(tenantName);
    const authDb = await getAuthDb();
    const integrationsColl = authDb.collection("integrations");
    const companiesColl = tenantDb.collection("companies");
    const list = await tenantDb
      .collection("company_integrations")
      .find({})
      .sort({ created_at: -1 })
      .toArray();
    const withIntegration = await Promise.all(
      list.map(async (ci) => {
        const integration = await integrationsColl.findOne({ _id: new ObjectId(ci.integration_id) });
        let company_name = null;
        if (ci.company_id) {
          const company = await companiesColl.findOne({ _id: new ObjectId(ci.company_id) });
          company_name = company?.name || null;
        }
        const features = normalizeIntegrationFeatures(ci.features);
        return {
          id: ci._id.toString(),
          company_id: ci.company_id || null,
          company_name: company_name || null,
          integration_id: ci.integration_id,
          integration_name: integration?.name || "Unknown",
          integration_slug: integration?.slug || "",
          credentials: ci.credentials || {},
          status: ci.status === 1 ? 1 : 0,
          features,
          created_at: ci.created_at,
          updated_at: ci.updated_at,
        };
      })
    );
    return res.json({ company_integrations: withIntegration });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Create company integration */
router.post("/company-integrations", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { company_id, integration_id, credentials, status, features } = req.body || {};
    if (!integration_id) {
      return res.status(400).json({ error: "integration_id is required" });
    }
    if (!company_id) {
      return res.status(400).json({ error: "company_id is required" });
    }
    const authDb = await getAuthDb();
    const integration = await authDb.collection("integrations").findOne({ _id: new ObjectId(integration_id) });
    if (!integration) {
      return res.status(400).json({ error: "Integration not found" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const company = await tenantDb.collection("companies").findOne({ _id: new ObjectId(company_id) });
    if (!company) {
      return res.status(400).json({ error: "Company not found" });
    }
    const companyIntegrations = tenantDb.collection("company_integrations");
    const normalizedFeatures = normalizeIntegrationFeatures(features);
    const slug = (integration.slug || "shopify").toLowerCase();
    let creds = credentials || {};
    if (slug === "daraz") {
      creds = await normalizeDarazCredentials(creds);
    }
    const doc = {
      company_id,
      integration_id,
      credentials: creds,
      status: status === 1 ? 1 : 0,
      features: normalizedFeatures,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const result = await companyIntegrations.insertOne(doc);
    const ordersColl = tenantDb.collection("orders");
    const backfill = await ordersColl.updateMany(
      {
        $or: [{ company_id: null }, { company_id: { $exists: false } }],
        source: slug,
      },
      { $set: { company_id: new ObjectId(company_id), updated_at: new Date() } }
    );
    if (backfill.modifiedCount > 0) {
      console.log(`Company integration created: backfilled company_id for ${backfill.modifiedCount} orders (source=${slug})`);
    }
    const featuresList = normalizedFeatures;
    const hasProducts = featuresList.includes("products");
    if (slug === "daraz" && doc.status === 1 && hasProducts) {
      runProductImportForTenant(tenantName).catch((err) =>
        console.error("[Daraz] Product import after connect failed:", err.message)
      );
    }
    return res.status(201).json({
      id: result.insertedId.toString(),
      company_id,
      company_name: company.name,
      integration_id,
      integration_name: integration.name,
      integration_slug: integration.slug,
      credentials: doc.credentials,
      status: doc.status,
      features: normalizedFeatures,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      orders_linked: backfill.modifiedCount,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Update company integration */
router.put("/company-integrations/:id", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    const { company_id, credentials, status, features } = req.body || {};
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const companyIntegrations = tenantDb.collection("company_integrations");
    const update = { updated_at: new Date() };
    if (company_id !== undefined) {
      if (!company_id) {
        update.company_id = null;
      } else {
        const company = await tenantDb.collection("companies").findOne({ _id: new ObjectId(company_id) });
        if (!company) return res.status(400).json({ error: "Company not found" });
        update.company_id = company_id;
      }
    }
    if (credentials !== undefined) {
      let creds = credentials;
      const authDbPre = await getAuthDb();
      const existingCi = await companyIntegrations.findOne({ _id: oid });
      if (existingCi) {
        const intPre = await authDbPre.collection("integrations").findOne({
          _id: new ObjectId(existingCi.integration_id),
        });
        if ((intPre?.slug || "").toLowerCase() === "daraz") {
          creds = await normalizeDarazCredentials(creds);
        }
      }
      update.credentials = creds;
    }
    if (status !== undefined) update.status = status === 1 ? 1 : 0;
    if (features !== undefined) update.features = normalizeIntegrationFeatures(features);
    const result = await companyIntegrations.findOneAndUpdate(
      { _id: oid },
      { $set: update },
      { returnDocument: "after" }
    );
    if (!result) {
      return res.status(404).json({ error: "Company integration not found" });
    }
    const authDb = await getAuthDb();
    const integration = await authDb.collection("integrations").findOne({ _id: new ObjectId(result.integration_id) });
    let company_name = null;
    if (result.company_id) {
      const company = await tenantDb.collection("companies").findOne({ _id: new ObjectId(result.company_id) });
      company_name = company?.name || null;
    }
    const featuresOut = normalizeIntegrationFeatures(result.features);
    return res.json({
      id: result._id.toString(),
      company_id: result.company_id || null,
      company_name,
      integration_id: result.integration_id,
      integration_name: integration?.name || "Unknown",
      integration_slug: integration?.slug || "",
      credentials: result.credentials || {},
      status: result.status,
      features: featuresOut,
      created_at: result.created_at,
      updated_at: result.updated_at,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Delete company integration */
router.delete("/company-integrations/:id", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const result = await tenantDb.collection("company_integrations").deleteOne({ _id: oid });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Company integration not found" });
    }
    return res.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** List orders - optional ?company_id= & ?sort= & ?search= */
router.get("/orders", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const companyId = req.query.company_id;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const sortParam = typeof req.query.sort === "string" ? req.query.sort.trim().toLowerCase() : "newest";
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ orders: [] });
    }
    const tenantDb = await getTenantDb(tenantName);
    const companiesColl = tenantDb.collection("companies");
    const filter = {};
    if (companyId) {
      try {
        const companyOid = new ObjectId(companyId);
        filter.company_id = { $in: [companyOid, companyId] };
      } catch {
        return res.status(400).json({ error: "Invalid company_id" });
      }
    }
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const or = [
        { email: re },
        { external_id: re },
        { order_number: re },
        { "raw.name": re },
        { "raw.email": re },
      ];
      if (/^\d+$/.test(search)) {
        or.push({ order_number: Number(search) });
      }
      filter.$or = or;
    }
    const sortOrder = sortParam === "oldest" ? { created_at: 1 } : { created_at: -1 };
    const limit = search ? 50 : 500;
    const orders = await tenantDb
      .collection("orders")
      .find(filter)
      .sort(sortOrder)
      .limit(limit)
      .toArray();
    const list = await Promise.all(
      orders.map(async (o) => {
        let company_name = null;
        if (o.company_id) {
          const company = await companiesColl.findOne({ _id: o.company_id });
          company_name = company?.name || null;
        }
        const ship = o.shipping_address || o.raw?.shipping_address || o.raw?.shippingAddress || {};
        const address = {
          address1: ship.address1 || ship.address_1 || "",
          city: ship.city || "",
          postal_code: ship.postal_code || ship.zip || ship.postal_code_zip || "",
          country_code: (ship.country_code || ship.country || "").substring(0, 2).toUpperCase() || "",
          name: ship.name || [ship.first_name, ship.last_name].filter(Boolean).join(" ") || "",
          first_name: ship.first_name || "",
          last_name: ship.last_name || "",
          phone: ship.phone || "",
        };
        return {
          id: o._id.toString(),
          company_id: o.company_id ? o.company_id.toString() : null,
          company_name,
          status: o.status || "imported",
          external_id: o.external_id,
          order_number: o.order_number,
          email: o.email,
          total: o.total,
          financial_status: o.financial_status,
          fulfillment_status: o.fulfillment_status,
          source: o.source,
          created_at: o.created_at,
          address,
        };
      })
    );
    return res.json({ orders: list });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------- Products ----------

const PRODUCT_STATUSES = ["active", "draft", "archived"];
function parseProductPrice(val) {
  if (val === undefined || val === null || val === "") return null;
  const n = Number(val);
  return Number.isNaN(n) ? null : n;
}
function isChannelProductSynced(cp) {
  return !!(cp && (cp.channel_variant_id || cp.channel_product_id));
}

function channelProductsLookupMap(cpDocs) {
  const map = new Map();
  for (const c of cpDocs) {
    map.set(`${c.product_id.toString()}:${c.channel_name}`, c);
  }
  return map;
}

function normalizeProductStatus(s) {
  if (!s || typeof s !== "string") return "active";
  const t = String(s).trim().toLowerCase();
  if (PRODUCT_STATUSES.includes(t)) return t;
  if (t === "published" || t === "scheduled" || t === "hidden") {
    return t === "published" ? "active" : t === "scheduled" ? "draft" : "archived";
  }
  return "active";
}

/** List products - optional ?company_id= & ?search= & ?product_type= & ?sort= */
router.get("/products", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const companyId = req.query.company_id;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const productType = typeof req.query.product_type === "string" ? req.query.product_type.trim() : "";
    const sortParam = typeof req.query.sort === "string" ? req.query.sort.trim().toLowerCase() : "newest";
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ products: [] });
    }
    const tenantDb = await getTenantDb(tenantName);
    const companiesColl = tenantDb.collection("companies");
    const filter = {};
    if (companyId) {
      try {
        const companyOid = new ObjectId(companyId);
        filter.company_id = { $in: [companyOid, companyId] };
      } catch {
        return res.status(400).json({ error: "Invalid company_id" });
      }
    }
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { title: re },
        { sku: re },
        { product_type: re },
        { "variants.sku": re },
        { "variants.option1": re },
        { "variants.title": re },
      ];
    }
    if (productType) {
      const escaped = productType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.product_type = new RegExp(`^\\s*${escaped}\\s*$`, "i");
    }
    const sortOpts = {
      newest: { created_at: -1 },
      oldest: { created_at: 1 },
      name_asc: { title: 1 },
      name_desc: { title: -1 },
      price_asc: { price: 1 },
      price_desc: { price: -1 },
    };
    const sortOrder = sortOpts[sortParam] || sortOpts.newest;
    const products = await tenantDb
      .collection("products")
      .find(filter)
      .sort(sortOrder)
      .limit(500)
      .toArray();
    const inventoryColl = tenantDb.collection("inventory");
    const channelProductsColl = tenantDb.collection("channel_products");
    const productIds = products.map((p) => p._id);
    const inventoryProductIds = productIds.flatMap((id) => [id, id.toString()]);
    const [inventoryDocs, channelProductDocs] = await Promise.all([
      inventoryColl.find({ product_id: { $in: inventoryProductIds } }).toArray(),
      channelProductsColl
        .find({ product_id: { $in: productIds }, channel_name: { $in: ["shopify", "daraz"] } })
        .toArray(),
    ]);
    const invByProduct = new Map(inventoryDocs.map((i) => [i.product_id.toString(), i]));
    const cpByProduct = channelProductsLookupMap(channelProductDocs);
    const list = await Promise.all(
      products.map(async (p) => {
        let company_name = null;
        if (p.company_id) {
          const company = await companiesColl.findOne({ _id: p.company_id });
          company_name = company?.name || null;
        }
        const pid = p._id.toString();
        const inv = invByProduct.get(pid);
        const shopify_synced = isChannelProductSynced(cpByProduct.get(`${pid}:shopify`));
        const daraz_synced = isChannelProductSynced(cpByProduct.get(`${pid}:daraz`));
        const quantity = inv && typeof inv.quantity === "number" ? inv.quantity : 0;
        const allocated = inv && typeof inv.allocated === "number" ? inv.allocated : 0;
        return {
          id: p._id.toString(),
          company_id: p.company_id ? p.company_id.toString() : null,
          company_name,
          external_id: p.external_id || null,
          title: p.title || "",
          sku: p.sku || "",
          product_type: p.product_type || "",
          status: normalizeProductStatus(p.status),
          price: p.price,
          price_old: p.price_old,
          source: p.source,
          quantity,
          allocated,
          shopify_synced,
          daraz_synced,
          page_title: p.page_title || undefined,
          meta_description: p.meta_description || undefined,
          handle: p.handle || undefined,
          description: p.description || undefined,
          images: Array.isArray(p.images) ? p.images : undefined,
          tags: Array.isArray(p.tags) ? p.tags : undefined,
          vendor: p.vendor || undefined,
          integration_slugs: Array.isArray(p.integration_slugs) ? p.integration_slugs : [],
          variants: Array.isArray(p.variants) ? p.variants : [],
          variant_count: typeof p.variant_count === "number" ? p.variant_count : Array.isArray(p.variants) ? p.variants.length : 0,
          created_at: p.created_at,
          updated_at: p.updated_at,
        };
      })
    );
    return res.json({ products: list });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Gemini AI config: API key status, default model, available models */
router.get("/ai/config", async (req, res) => {
  try {
    const ai = await getGeminiAiConfig();
    return res.json(ai);
  } catch (err) {
    console.error("[Gemini] config:", err.message);
    return res.status(500).json({ error: "Failed to load AI config" });
  }
});

/** AI-generate product listing fields from keywords (Gemini) */
router.post("/products/ai-generate", async (req, res) => {
  try {
    const keywords = typeof req.body?.keywords === "string" ? req.body.keywords.trim() : "";
    const model = typeof req.body?.model === "string" ? req.body.model.trim() : undefined;
    if (!keywords) {
      return res.status(400).json({ error: "keywords is required" });
    }
    if (keywords.length > 500) {
      return res.status(400).json({ error: "keywords must be 500 characters or less" });
    }
    const { listing, model_used } = await generateProductListingFromKeywords(keywords, { model });
    return res.json({ listing, model_used });
  } catch (err) {
    console.error("[Gemini] ai-generate:", err.message);
    const msg = err.message || "AI generation failed";
    const status = msg.includes("not configured") ? 503 : 502;
    return res.status(status).json({ error: msg });
  }
});

/** Create product (local product managed in UniSell) */
router.post("/products", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    if (!(await tenantDbExists(tenantName))) {
      return res.status(400).json({ error: "Tenant has no data" });
    }
    const {
      title,
      sku,
      product_type,
      price,
      price_old,
      coupon,
      status,
      source,
      company_id: companyIdBody,
      page_title,
      meta_description,
      handle,
      description,
      sizes,
      shipping_country,
      images,
      tags,
      vendor,
      integration_slugs: integrationSlugsBody,
      variants: variantsBody,
      quantity: quantityBody,
    } = req.body || {};
    if (!title || typeof title !== "string" || !String(title).trim()) {
      return res.status(400).json({ error: "Title is required and cannot be empty." });
    }
    const tenantDb = await getTenantDb(tenantName);
    const productsColl = tenantDb.collection("products");
    const companiesColl = tenantDb.collection("companies");
    let company_id = null;
    if (companyIdBody && String(companyIdBody).trim()) {
      try {
        const companyOid = new ObjectId(String(companyIdBody).trim());
        const company = await companiesColl.findOne({ _id: companyOid });
        if (!company) {
          return res.status(400).json({ error: "Invalid company_id" });
        }
        company_id = companyOid;
      } catch {
        return res.status(400).json({ error: "Invalid company_id" });
      }
    }
    const titleTrimmed = title.trim();
    if (!titleTrimmed) {
      return res.status(400).json({ error: "Title is required and cannot be empty." });
    }
    const dupQuery = { title: new RegExp(`^${titleTrimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") };
    if (company_id != null) {
      dupQuery.company_id = { $in: [company_id, company_id.toString()] };
    } else {
      dupQuery.$or = [{ company_id: null }, { company_id: { $exists: false } }];
    }
    const existingSame = await productsColl.findOne(dupQuery);
    if (existingSame) {
      const msg = company_id != null
        ? "A product with this title already exists for this company. Edit it from the list or use a different title."
        : "A product with this title already exists. Edit it from the list or use a different title.";
      return res.status(409).json({ error: msg, existing_id: existingSame._id.toString() });
    }
    const initialQty =
      quantityBody !== undefined && quantityBody !== null && String(quantityBody).trim() !== ""
        ? (() => {
            const n = Number(quantityBody);
            return Number.isNaN(n) || n < 0 ? null : Math.floor(n);
          })()
        : null;
    const variants = Array.isArray(variantsBody)
      ? variantsBody.map((v) => ({
          id: v?.id != null ? String(v.id) : undefined,
          sku: v?.sku != null ? String(v.sku).trim() : undefined,
          title: v?.title != null ? String(v.title).trim() : undefined,
          option1: v?.option1 != null ? String(v.option1).trim() : undefined,
          option2: v?.option2 != null ? String(v.option2).trim() : undefined,
          price: parseProductPrice(v?.price),
          price_old: v?.price_old != null ? parseProductPrice(v.price_old) : undefined,
          inventory_quantity:
            typeof v?.inventory_quantity === "number"
              ? v.inventory_quantity
              : initialQty != null
                ? initialQty
                : undefined,
        }))
      : [];
    const now = new Date();
    const doc = {
      company_id,
      external_id: null,
      title: titleTrimmed,
      sku: sku != null ? String(sku).trim() : "",
      product_type: product_type != null ? String(product_type).trim() : "",
      status: normalizeProductStatus(status),
      price: parseProductPrice(price),
      price_old: parseProductPrice(price_old),
      coupon: coupon != null ? String(coupon).trim() : undefined,
      source: source != null ? String(source).trim() : "local",
      page_title: page_title != null ? String(page_title).trim() : undefined,
      meta_description: meta_description != null ? String(meta_description).trim() : undefined,
      handle: handle != null ? String(handle).trim() : undefined,
      description: description != null ? String(description).trim() : undefined,
      sizes: Array.isArray(sizes) ? sizes : undefined,
      shipping_country: shipping_country != null ? String(shipping_country).trim() : undefined,
      images: Array.isArray(images) ? images : undefined,
      tags: Array.isArray(tags) ? tags : undefined,
      vendor: vendor != null ? String(vendor).trim() : undefined,
      integration_slugs: Array.isArray(integrationSlugsBody) ? integrationSlugsBody.filter((s) => s && String(s).trim()) : [],
      variants,
      variant_count: variants.length,
      created_at: now,
      updated_at: now,
    };
    const result = await productsColl.insertOne(doc);
    const created = { ...doc, _id: result.insertedId };
    await ensureInventoryForProduct(tenantDb, result.insertedId);
    let company_name = null;
    if (created.company_id) {
      const company = await companiesColl.findOne({ _id: created.company_id });
      company_name = company?.name || null;
    }

    // If product is linked to a company with Shopify and is enabled for Shopify, push to store
    const integrationSlugs = Array.isArray(created.integration_slugs) ? created.integration_slugs : [];
    const pushToShopify = integrationSlugs.length === 0 || integrationSlugs.includes("shopify");
    const pushToDaraz = integrationSlugs.length === 0 || integrationSlugs.includes("daraz");
    let external_id = created.external_id || null;
    let productSource = created.source || "local";
    const authDb = await getAuthDb();
    const integrationsColl = authDb.collection("integrations");
    const companyIntegrationsColl = tenantDb.collection("company_integrations");
    if (created.company_id && pushToShopify) {
      const shopifyIntegration = await integrationsColl.findOne({ slug: "shopify" });
      if (shopifyIntegration) {
        const companyOid = created.company_id instanceof ObjectId ? created.company_id : new ObjectId(created.company_id);
        const ci = await companyIntegrationsColl.findOne({
          company_id: { $in: [companyOid, companyOid.toString()] },
          integration_id: { $in: [shopifyIntegration._id, shopifyIntegration._id.toString()] },
          status: 1,
          $or: [{ features: { $exists: false } }, { features: "products" }],
        });
        if (ci && ci.credentials) {
          try {
            const pushResult = await ShopifyIntegration.createProduct(ci.credentials, {
              title: created.title,
              description: created.description,
              product_type: created.product_type,
              status: created.status,
              handle: created.handle,
              sku: created.sku,
              price: created.price,
              price_old: created.price_old,
              page_title: created.page_title,
              tags: created.tags,
              vendor: created.vendor,
              images: created.images,
              sizes: created.sizes,
              variants: created.variants,
            });
            if (pushResult?.external_id) {
              external_id = pushResult.external_id;
              productSource = "shopify";
              await productsColl.updateOne(
                { _id: result.insertedId },
                { $set: { external_id: pushResult.external_id, source: "shopify", status: "active", updated_at: new Date() } }
              );
              const cpColl = tenantDb.collection("channel_products");
              await cpColl.updateOne(
                { product_id: result.insertedId, channel_name: "shopify" },
                {
                  $set: {
                    channel_product_id: pushResult.channel_product_id || pushResult.external_id,
                    channel_variant_id: pushResult.channel_variant_id || null,
                    channel_inventory_item_id: pushResult.channel_inventory_item_id || null,
                    updated_at: new Date(),
                  },
                },
                { upsert: true }
              );
              if (pushResult.categoryWarning) {
                created._categoryWarning = pushResult.categoryWarning;
              }
            }
          } catch (pushErr) {
            console.error("[Shopify] Push product after create failed:", pushErr.message);
          }
        }
      }
    }

    if (created.company_id && pushToDaraz) {
      const darazRes = await pushProductToDarazForCompany(
        tenantDb,
        created,
        result.insertedId,
        { integrationSlugs }
      );
      if (darazRes.warning) {
        created._darazSyncWarning = darazRes.warning;
      } else if (darazRes.darazPush?.channel_product_id) {
        external_id = darazRes.darazPush.channel_product_id;
        if (productSource !== "shopify") productSource = "daraz";
      }
    } else if (pushToDaraz && !created.company_id) {
      created._darazSyncWarning =
        "Product saved locally only. Select a company with Daraz connected to sync to Daraz.";
    }

    let savedQty = null;
    if (initialQty != null) {
      const invUpdated = await updateInventoryQuantity(tenantDb, result.insertedId, initialQty, {
        tenantName,
      });
      savedQty = invUpdated?.quantity ?? initialQty;
      const pFresh = await productsColl.findOne({ _id: result.insertedId });
      if (pFresh) {
        await syncProductInventoryToChannels(tenantDb, pFresh, savedQty);
      }
    }

    const responseStatus = productSource === "shopify" ? "active" : created.status;
    const resBody = {
      id: result.insertedId.toString(),
      company_id: created.company_id ? created.company_id.toString() : null,
      company_name,
      external_id,
      title: created.title,
      sku: created.sku,
      product_type: created.product_type,
      status: responseStatus,
      price: created.price,
      price_old: created.price_old,
      source: productSource,
      integration_slugs: created.integration_slugs || [],
      variants: created.variants,
      variant_count: created.variant_count,
      created_at: created.created_at,
      updated_at: created.updated_at,
    };
    if (created._categoryWarning) resBody.category_warning = created._categoryWarning;
    if (created._darazSyncWarning) resBody.daraz_sync_warning = created._darazSyncWarning;
    if (savedQty != null) resBody.quantity = savedQty;
    return res.status(201).json(resBody);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Update product */
router.put("/products/:id", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    if (!(await tenantDbExists(tenantName))) {
      return res.status(400).json({ error: "Tenant has no data" });
    }
    const {
      title,
      sku,
      product_type,
      price,
      price_old,
      coupon,
      status,
      company_id: companyIdBody,
      page_title,
      meta_description,
      handle,
      description,
      sizes,
      shipping_country,
      images,
      tags,
      vendor,
      integration_slugs: integrationSlugsBody,
      variants: variantsBody,
    } = req.body || {};
    const tenantDb = await getTenantDb(tenantName);
    const companiesColl = tenantDb.collection("companies");
    const update = { updated_at: new Date() };
    if (title !== undefined) {
      const t = String(title).trim();
      if (!t) return res.status(400).json({ error: "Title cannot be empty." });
      update.title = t;
    }
    if (sku !== undefined) update.sku = String(sku).trim();
    if (product_type !== undefined) update.product_type = String(product_type).trim();
    if (status !== undefined) update.status = normalizeProductStatus(status);
    if (price !== undefined) update.price = parseProductPrice(price);
    if (price_old !== undefined) update.price_old = parseProductPrice(price_old);
    if (coupon !== undefined) update.coupon = coupon == null ? undefined : String(coupon).trim();
    if (page_title !== undefined) update.page_title = page_title == null ? undefined : String(page_title).trim();
    if (meta_description !== undefined) {
      update.meta_description = meta_description == null ? undefined : String(meta_description).trim();
    }
    if (handle !== undefined) update.handle = handle == null ? undefined : String(handle).trim();
    if (description !== undefined) update.description = description == null ? undefined : String(description).trim();
    if (sizes !== undefined) update.sizes = Array.isArray(sizes) ? sizes : undefined;
    if (shipping_country !== undefined) update.shipping_country = shipping_country == null ? undefined : String(shipping_country).trim();
    if (images !== undefined) update.images = Array.isArray(images) ? images : undefined;
    if (tags !== undefined) update.tags = Array.isArray(tags) ? tags : undefined;
    if (vendor !== undefined) update.vendor = vendor == null ? undefined : String(vendor).trim();
    if (integrationSlugsBody !== undefined) update.integration_slugs = Array.isArray(integrationSlugsBody) ? integrationSlugsBody.filter((s) => s && String(s).trim()) : [];
    if (companyIdBody !== undefined) {
      if (!companyIdBody || !String(companyIdBody).trim()) {
        update.company_id = null;
      } else {
        try {
          const companyOid = new ObjectId(String(companyIdBody).trim());
          const company = await companiesColl.findOne({ _id: companyOid });
          if (!company) return res.status(400).json({ error: "Invalid company_id" });
          update.company_id = companyOid;
        } catch {
          return res.status(400).json({ error: "Invalid company_id" });
        }
      }
    }
    if (variantsBody !== undefined) {
      const variants = Array.isArray(variantsBody)
        ? variantsBody.map((v) => ({
            id: v?.id != null ? String(v.id) : undefined,
            sku: v?.sku != null ? String(v.sku).trim() : undefined,
            title: v?.title != null ? String(v.title).trim() : undefined,
            option1: v?.option1 != null ? String(v.option1).trim() : undefined,
            option2: v?.option2 != null ? String(v.option2).trim() : undefined,
            price: parseProductPrice(v?.price),
            price_old: v?.price_old != null ? parseProductPrice(v.price_old) : undefined,
            inventory_quantity: typeof v?.inventory_quantity === "number" ? v.inventory_quantity : undefined,
          }))
        : [];
      update.variants = variants;
      update.variant_count = variants.length;
    }
    const coll = tenantDb.collection("products");
    const result = await coll.updateOne({ _id: oid }, { $set: update });
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    const p = await coll.findOne({ _id: oid });
    let company_name = null;
    if (p.company_id) {
      const company = await companiesColl.findOne({ _id: p.company_id });
      company_name = company?.name || null;
    }
    const cpColl = tenantDb.collection("channel_products");
    let daraz_sync_warning = null;
    const integrationSlugs = Array.isArray(p.integration_slugs) ? p.integration_slugs : [];
    const pushToDaraz =
      integrationSlugs.length === 0 || integrationSlugs.includes("daraz");
    const darazCpBefore = await cpColl.findOne({ product_id: oid, channel_name: "daraz" });
    const darazWasSynced = isChannelProductSynced(darazCpBefore);
    if (pushToDaraz && p.company_id && !darazWasSynced) {
      const darazRes = await pushProductToDarazForCompany(tenantDb, p, oid, { integrationSlugs });
      if (darazRes.warning) daraz_sync_warning = darazRes.warning;
    }
    const cpDaraz = await cpColl.findOne({ product_id: oid, channel_name: "daraz" });
    const cpShopify = await cpColl.findOne({ product_id: oid, channel_name: "shopify" });
    const pAfter = await coll.findOne({ _id: oid });
    const body = {
      id: pAfter._id.toString(),
      company_id: pAfter.company_id ? pAfter.company_id.toString() : null,
      company_name,
      external_id: pAfter.external_id || null,
      title: pAfter.title || "",
      sku: pAfter.sku || "",
      product_type: pAfter.product_type || "",
      status: normalizeProductStatus(pAfter.status),
      price: pAfter.price,
      price_old: pAfter.price_old,
      source: pAfter.source,
      integration_slugs: integrationSlugs,
      shopify_synced: isChannelProductSynced(cpShopify),
      daraz_synced: isChannelProductSynced(cpDaraz),
      variants: pAfter.variants || [],
      variant_count:
        typeof pAfter.variant_count === "number"
          ? pAfter.variant_count
          : Array.isArray(pAfter.variants)
            ? pAfter.variants.length
            : 0,
      created_at: pAfter.created_at,
      updated_at: pAfter.updated_at,
    };
    if (daraz_sync_warning) body.daraz_sync_warning = daraz_sync_warning;
    return res.json(body);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Push a local product to Shopify (product must have company_id with active Shopify integration) */
router.post("/products/:id/push-to-shopify", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    if (!(await tenantDbExists(tenantName))) {
      return res.status(400).json({ error: "Tenant has no data" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const productsColl = tenantDb.collection("products");
    const p = await productsColl.findOne({ _id: oid });
    if (!p) return res.status(404).json({ error: "Product not found" });
    if (!p.company_id) {
      return res.status(400).json({ error: "Product has no company. Set a company on the product, then push to Shopify." });
    }
    const productTypeTrimmed = p.product_type != null ? String(p.product_type).trim() : "";
    if (!productTypeTrimmed) {
      return res.status(400).json({
        error: "Product has no category. Edit the product, set Category (e.g. Laptops, Jewellery), save, then push to Shopify so it appears in your store.",
      });
    }
    const authDb = await getAuthDb();
    const integrationsColl = authDb.collection("integrations");
    const companyIntegrationsColl = tenantDb.collection("company_integrations");
    const shopifyIntegration = await integrationsColl.findOne({ slug: "shopify" });
    if (!shopifyIntegration) {
      return res.status(400).json({ error: "Shopify integration not configured" });
    }
    const companyOid = p.company_id instanceof ObjectId ? p.company_id : new ObjectId(p.company_id);
    const ci = await companyIntegrationsColl.findOne({
      company_id: { $in: [companyOid, companyOid.toString()] },
      integration_id: { $in: [shopifyIntegration._id, shopifyIntegration._id.toString()] },
      status: 1,
      $or: [{ features: { $exists: false } }, { features: "products" }],
    });
    if (!ci || !ci.credentials) {
      return res.status(200).json({
        message: "Product saved. It will sync to Shopify when the company integration is active.",
        id: p._id.toString(),
      });
    }
    const pushResult = await ShopifyIntegration.createProduct(ci.credentials, {
      title: p.title,
      description: p.description,
      product_type: p.product_type,
      status: p.status,
      handle: p.handle,
      sku: p.sku,
      price: p.price,
      price_old: p.price_old,
      page_title: p.page_title,
      tags: p.tags,
      vendor: p.vendor,
      images: p.images,
      sizes: p.sizes,
      variants: p.variants,
    });
    if (!pushResult?.external_id) {
      return res.status(500).json({ error: "Shopify did not return product id" });
    }
    await productsColl.updateOne(
      { _id: oid },
      { $set: { external_id: pushResult.external_id, source: "shopify", status: "active", updated_at: new Date() } }
    );
    const cpColl = tenantDb.collection("channel_products");
    await cpColl.updateOne(
      { product_id: oid, channel_name: "shopify" },
      {
        $set: {
          channel_product_id: pushResult.channel_product_id || pushResult.external_id,
          channel_variant_id: pushResult.channel_variant_id || null,
          channel_inventory_item_id: pushResult.channel_inventory_item_id || null,
          updated_at: new Date(),
        },
      },
      { upsert: true }
    );
    const updated = await productsColl.findOne({ _id: oid });
    let company_name = null;
    if (updated.company_id) {
      const company = await tenantDb.collection("companies").findOne({ _id: updated.company_id });
      company_name = company?.name || null;
    }
    const resBody = {
      id: updated._id.toString(),
      company_id: updated.company_id ? updated.company_id.toString() : null,
      company_name,
      external_id: updated.external_id,
      title: updated.title,
      sku: updated.sku,
      product_type: updated.product_type,
      status: updated.status,
      price: updated.price,
      source: updated.source,
      variants: updated.variants || [],
      variant_count: Array.isArray(updated.variants) ? updated.variants.length : 0,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    };
    if (pushResult.categoryWarning) resBody.category_warning = pushResult.categoryWarning;
    return res.json(resBody);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

/** Push a local product to Daraz (create listing or update stock/price). */
router.post("/products/:id/push-to-daraz", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    if (!(await tenantDbExists(tenantName))) {
      return res.status(400).json({ error: "Tenant has no data" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const p = await tenantDb.collection("products").findOne({ _id: oid });
    if (!p) return res.status(404).json({ error: "Product not found" });
    const productTypeTrimmed = p.product_type != null ? String(p.product_type).trim() : "";
    if (!productTypeTrimmed) {
      return res.status(400).json({
        error:
          "Product has no category. Set Category (e.g. Jewellery, T-Shirts) so Daraz can pick the right listing category.",
      });
    }
    const darazRes = await pushProductToDarazForCompany(tenantDb, p, oid);
    if (darazRes.warning) {
      return res.status(400).json({ error: darazRes.warning });
    }
    const updated = await tenantDb.collection("products").findOne({ _id: oid });
    const cpColl = tenantDb.collection("channel_products");
    const cpAfter = await cpColl.findOne({ product_id: oid, channel_name: "daraz" });
    let company_name = null;
    if (updated.company_id) {
      const company = await tenantDb.collection("companies").findOne({ _id: updated.company_id });
      company_name = company?.name || null;
    }
    const invAfter = await tenantDb.collection("inventory").findOne({ product_id: oid });
    return res.json({
      id: updated._id.toString(),
      company_id: updated.company_id ? updated.company_id.toString() : null,
      company_name,
      external_id: updated.external_id || null,
      title: updated.title,
      sku: updated.sku,
      product_type: updated.product_type,
      status: updated.status,
      price: updated.price,
      source: updated.source,
      quantity: invAfter && typeof invAfter.quantity === "number" ? invAfter.quantity : 0,
      shopify_synced: isChannelProductSynced(
        await cpColl.findOne({ product_id: oid, channel_name: "shopify" })
      ),
      daraz_synced: isChannelProductSynced(cpAfter),
      variants: updated.variants || [],
      variant_count: Array.isArray(updated.variants) ? updated.variants.length : 0,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
      message: darazRes.message || "Synced to Daraz.",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Daraz push failed" });
  }
});

/** Delete product */
router.delete("/products/:id", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    if (!(await tenantDbExists(tenantName))) {
      return res.status(400).json({ error: "Tenant has no data" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const result = await tenantDb.collection("products").deleteOne({ _id: oid });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    await tenantDb.collection("inventory").deleteMany({ product_id: oid });
    await tenantDb.collection("channel_products").deleteMany({ product_id: oid });
    return res.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** List all inventory with product info (for Inventory screen); optional ?company_id= & ?search= & ?product_type= & ?sort= */
router.get("/inventory", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const companyId = req.query.company_id;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const productType = typeof req.query.product_type === "string" ? req.query.product_type.trim() : "";
    const sortParam = typeof req.query.sort === "string" ? req.query.sort.trim().toLowerCase() : "newest";
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ inventory: [] });
    }
    const tenantDb = await getTenantDb(tenantName);
    const filter = {};
    if (companyId) {
      try {
        const companyOid = new ObjectId(companyId);
        filter.company_id = { $in: [companyOid, companyId] };
      } catch {
        return res.status(400).json({ error: "Invalid company_id" });
      }
    }
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { title: re },
        { sku: re },
        { product_type: re },
        { "variants.sku": re },
        { "variants.option1": re },
        { "variants.title": re },
      ];
    }
    if (productType) {
      const escaped = productType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.product_type = new RegExp(`^\\s*${escaped}\\s*$`, "i");
    }
    const sortOpts = {
      newest: { created_at: -1 },
      oldest: { created_at: 1 },
      name_asc: { title: 1 },
      name_desc: { title: -1 },
    };
    const sortOrder = sortOpts[sortParam] || { created_at: -1 };
    const products = await tenantDb
      .collection("products")
      .find(filter)
      .sort(sortOrder)
      .limit(500)
      .toArray();
    const productIds = products.map((p) => p._id);
    const inventoryProductIds = productIds.flatMap((id) => [id, id.toString()]);
    const inventoryDocs = await tenantDb
      .collection("inventory")
      .find({ product_id: { $in: inventoryProductIds } })
      .toArray();
    const invByProduct = new Map(inventoryDocs.map((i) => [i.product_id.toString(), i]));
    const cpDocs = await tenantDb
      .collection("channel_products")
      .find({ product_id: { $in: productIds }, channel_name: { $in: ["shopify", "daraz"] } })
      .toArray();
    const cpByProduct = channelProductsLookupMap(cpDocs);
    const inventory = products.map((p) => {
      const pid = p._id.toString();
      const inv = invByProduct.get(pid);
      return {
        product_id: pid,
        title: p.title || "",
        sku: p.sku || "",
        source: p.source || null,
        quantity: inv && typeof inv.quantity === "number" ? inv.quantity : 0,
        allocated: inv && typeof inv.allocated === "number" ? inv.allocated : 0,
        shopify_synced: isChannelProductSynced(cpByProduct.get(`${pid}:shopify`)),
        daraz_synced: isChannelProductSynced(cpByProduct.get(`${pid}:daraz`)),
      };
    });
    return res.json({ inventory });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Get inventory for a product */
router.get("/inventory/:product_id", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { product_id } = req.params;
    let pid;
    try {
      pid = new ObjectId(product_id);
    } catch {
      return res.status(400).json({ error: "Invalid product id" });
    }
    if (!(await tenantDbExists(tenantName))) {
      return res.status(400).json({ error: "Tenant has no data" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const inv = await getInventoryByProductId(tenantDb, pid);
    if (!inv) {
      await ensureInventoryForProduct(tenantDb, pid);
      const created = await getInventoryByProductId(tenantDb, pid);
      return res.json(created);
    }
    return res.json(inv);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Update inventory quantity for a product; syncs to Shopify if mapped */
router.patch("/inventory/:product_id", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { product_id } = req.params;
    const { quantity } = req.body || {};
    let pid;
    try {
      pid = new ObjectId(product_id);
    } catch {
      return res.status(400).json({ error: "Invalid product id" });
    }
    if (!(await tenantDbExists(tenantName))) {
      return res.status(400).json({ error: "Tenant has no data" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const product = await tenantDb.collection("products").findOne({ _id: pid });
    if (!product) return res.status(404).json({ error: "Product not found" });
    const updated = await updateInventoryQuantity(tenantDb, pid, quantity, { tenantName });
    if (!updated) return res.status(500).json({ error: "Failed to update inventory" });
    const cpColl = tenantDb.collection("channel_products");
    const shopifyCp = await cpColl.findOne({
      product_id: pid,
      channel_name: "shopify",
      channel_inventory_item_id: { $nin: [null, ""] },
    });
    const darazCp = await cpColl.findOne({
      product_id: pid,
      channel_name: "daraz",
    });
    if (product.company_id) {
      const authDbInv = await getAuthDb();
      const companyOid = product.company_id instanceof ObjectId ? product.company_id : new ObjectId(product.company_id);
      const ciColl = tenantDb.collection("company_integrations");

      if (shopifyCp) {
        const shopifyIntegration = await authDbInv.collection("integrations").findOne({ slug: "shopify" });
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
                updated.quantity
              );
              if (!setResult.success) console.error("[Shopify] Inventory sync after PATCH failed:", setResult.error);
            } catch (e) {
              console.error("[Shopify] Inventory sync after PATCH failed:", e?.message);
            }
          }
        }
      }

      if (darazCp && (darazCp.channel_seller_sku || darazCp.channel_variant_id || product.sku)) {
        const darazIntegration = await authDbInv.collection("integrations").findOne({ slug: "daraz" });
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
                quantity: updated.quantity,
                price: product.price != null ? product.price : undefined,
              });
              if (!setResult.success) console.error("[Daraz] Inventory sync after PATCH failed:", setResult.error);
            } catch (e) {
              console.error("[Daraz] Inventory sync after PATCH failed:", e?.message);
            }
          }
        }
      }
    }
    return res.json({ quantity: updated.quantity, allocated: updated.allocated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Out-of-stock alerts (quantity 0) for login banner and notifications */
router.get("/stock-alerts", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ count: 0, alerts: [], email_configured: false });
    }
    const tenantDb = await getTenantDb(tenantName);
    const summary = await getStockAlertSummaryForTenant(tenantDb);
    return res.json(summary);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Mark stock alerts as read / dismissed */
router.post("/stock-alerts/dismiss", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ ok: true });
    }
    const tenantDb = await getTenantDb(tenantName);
    const alertIds = Array.isArray(req.body?.alert_ids) ? req.body.alert_ids : null;
    await markStockAlertsRead(tenantDb, { alertIds });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Backfill company_id on orders that have no company (e.g. imported before company was set) */
router.post("/orders/backfill-company", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { company_id, source } = req.body || {};
    if (!company_id || !source || typeof source !== "string") {
      return res.status(400).json({ error: "company_id and source are required" });
    }
    if (!(await tenantDbExists(tenantName))) {
      return res.status(400).json({ error: "Tenant has no data" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const company = await tenantDb.collection("companies").findOne({ _id: new ObjectId(company_id) });
    if (!company) {
      return res.status(400).json({ error: "Company not found" });
    }
    const ordersColl = tenantDb.collection("orders");
    const result = await ordersColl.updateMany(
      {
        $or: [{ company_id: null }, { company_id: { $exists: false } }],
        source: source.trim(),
      },
      { $set: { company_id: new ObjectId(company_id), updated_at: new Date() } }
    );
    return res.json({ updated: result.modifiedCount });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Dispatch orders: fulfill on channel (e.g. Shopify) with tracking, mark as dispatched */
router.post("/orders/dispatch", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { order_ids } = req.body || {};
    if (!Array.isArray(order_ids) || order_ids.length === 0) {
      return res.status(400).json({ error: "order_ids array is required" });
    }
    const result = await dispatchOrders(tenantName, order_ids);
    return res.json({ dispatched: result.dispatched, errors: result.errors });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// ---------- Consignments ----------
/** List consignments; optional ?order_id= or ?company_id= */
router.get("/consignments", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const orderId = req.query.order_id;
    const companyId = req.query.company_id;
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ consignments: [] });
    }
    const tenantDb = await getTenantDb(tenantName);
    const authDb = await getAuthDb();
    let filter = orderId ? { order_id: new ObjectId(orderId) } : {};
    if (companyId && !orderId) {
      try {
        const companyOid = new ObjectId(companyId);
        const orderIds = await tenantDb
          .collection("orders")
          .find({ company_id: { $in: [companyOid, companyOid.toString()] } })
          .project({ _id: 1 })
          .toArray();
        const ids = orderIds.map((o) => o._id);
        if (ids.length === 0) {
          return res.json({ consignments: [] });
        }
        filter = { order_id: { $in: ids } };
      } catch {
        return res.status(400).json({ error: "Invalid company_id" });
      }
    }
    const list = await tenantDb
      .collection("consignments")
      .find(filter)
      .sort({ created_at: -1 })
      .limit(500)
      .toArray();
    const carriersColl = authDb.collection("carriers");
    const servicesColl = authDb.collection("carrier_services");
    const withDetails = await Promise.all(
      list.map(async (c) => {
        const ciOid = toObjectId(c.carrier_integration_id);
        const carrier = ciOid ? await tenantDb.collection("carrier_integrations").findOne({ _id: ciOid }) : null;
        const carrierOid = carrier ? toObjectId(carrier.carrier_id) : null;
        const authCarrier = carrierOid ? await carriersColl.findOne({ _id: carrierOid }) : null;
        const svcOid = toObjectId(c.carrier_service_id);
        const svc = svcOid ? await servicesColl.findOne({ _id: svcOid }) : null;
        return {
          id: c._id.toString(),
          order_id: c.order_id.toString(),
          carrier_name: authCarrier?.name ?? "Unknown",
          carrier_service_name: svc?.name ?? "Unknown",
          tracking_number: c.tracking_number,
          label_url: c.label_url,
          tracking_url: c.tracking_url,
          status: c.status || "consigned",
          created_at: c.created_at,
          updated_at: c.updated_at,
        };
      })
    );
    return res.json({ consignments: withDetails });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Create consignments for selected orders */
router.post("/consignments", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { order_ids, carrier_integration_id, carrier_service_id } = req.body || {};
    if (!Array.isArray(order_ids) || order_ids.length === 0) {
      return res.status(400).json({ error: "order_ids array is required" });
    }
    if (!carrier_integration_id || !carrier_service_id) {
      return res.status(400).json({ error: "carrier_integration_id and carrier_service_id are required" });
    }
    const result = await createConsignments(tenantName, order_ids, carrier_integration_id, carrier_service_id);
    return res.json({ created: result.created, errors: result.errors });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

/** Get consignment by id (for label) */
router.get("/consignments/:id", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    if (!(await tenantDbExists(tenantName))) {
      return res.status(404).json({ error: "Not found" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const c = await tenantDb.collection("consignments").findOne({ _id: oid });
    if (!c) {
      return res.status(404).json({ error: "Consignment not found" });
    }
    return res.json({
      id: c._id.toString(),
      order_id: c.order_id.toString(),
      tracking_number: c.tracking_number,
      label_url: c.label_url,
      tracking_url: c.tracking_url,
      status: c.status,
      created_at: c.created_at,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

function escapeHtml(s) {
  if (s == null) return "";
  const str = String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Get label for printing: serve data URL as binary, redirect to http(s) URL, or serve printable HTML fallback */
router.get("/consignments/:id/label", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    if (!tenantName) {
      return res.status(403).json({ error: "Tenant context required" });
    }
    if (!(await tenantDbExists(tenantName))) {
      return res.status(404).json({ error: "Tenant not found" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const c = await tenantDb.collection("consignments").findOne({ _id: oid });
    if (!c) {
      return res.status(404).json({ error: "Consignment not found" });
    }
    const labelUrl = c.label_url && typeof c.label_url === "string" ? c.label_url.trim() : "";
    if (labelUrl.startsWith("data:")) {
      const match = labelUrl.match(/^data:([^;]+)(;base64)?,(.+)$/);
      if (match) {
        let mime = (match[1] || "").trim().toLowerCase();
        if (mime === "pdf" || mime === "application/pdf") mime = "application/pdf";
        else if (!mime.startsWith("image/") && ["png", "jpeg", "jpg", "gif"].includes(mime)) mime = `image/${mime === "jpg" ? "jpeg" : mime}`;
        else if (!mime || mime === "base64" || !mime.includes("/")) mime = "application/pdf";
        const base64 = match[3] || "";
        try {
          const buf = Buffer.from(base64, "base64");
          res.setHeader("Content-Type", mime);
          res.setHeader("Content-Disposition", 'inline; filename="shipping-label.pdf"');
          return res.send(buf);
        } catch {
          return res.status(500).json({ error: "Invalid label data" });
        }
      }
    }
    const isHttpLabel = labelUrl && (labelUrl.startsWith("http://") || labelUrl.startsWith("https://")) && !labelUrl.toLowerCase().includes("tracking");
    if (isHttpLabel) {
      const isApiUrl =
        /api_key|api_key_secure|leopardscourier\.com/i.test(labelUrl);
      if (isApiUrl) {
        try {
          const labelRes = await fetch(labelUrl, { redirect: "follow" });
          if (labelRes.ok) {
            const contentType = labelRes.headers.get("content-type") || "application/pdf";
            const buf = Buffer.from(await labelRes.arrayBuffer());
            res.setHeader("Content-Type", contentType);
            res.setHeader("Content-Disposition", 'inline; filename="shipping-label.pdf"');
            return res.send(buf);
          }
        } catch (e) {
          console.warn("[label] proxy fetch failed, falling back to HTML:", e?.message);
        }
      } else {
        return res.redirect(302, labelUrl);
      }
    }
    if (!c.tracking_number) {
      return res.status(404).json({ error: "No label or tracking for this consignment" });
    }

    const fs = "12px";
    const fwBold = "700";
    const color = "#1a1a1a";
    const row = (label, value) =>
      value
        ? `<div style="margin:3px 0;font-size:${fs};line-height:1.4;"><span style="font-weight:${fwBold};min-width:5em;color:${color}">${escapeHtml(label)}:</span> <span style="color:${color}">${escapeHtml(value)}</span></div>`
        : "";

    let fromName = "Shipper";
    let fromAddress = "";
    let fromCity = "";
    let fromPostal = "";
    let fromCountry = "";
    let toName = "Recipient";
    let toAddress = "";
    let toCity = "";
    let toPostal = "";
    let toCountry = "";
    try {
      const order = await tenantDb.collection("orders").findOne({ _id: c.order_id });
      let company = null;
      if (order?.company_id) {
        company = await tenantDb.collection("companies").findOne({ _id: order.company_id });
      }
      const raw = order?.raw || {};
      const shipping = order?.shipping_address || raw.shipping_address || raw.shippingAddress || {};
      toName = [shipping.first_name, shipping.last_name].filter(Boolean).join(" ") || shipping.name || "Recipient";
      toAddress = shipping.address1 || shipping.address_1 || "";
      toCity = shipping.city || "";
      toPostal = shipping.zip || shipping.postal_code || shipping.postal_code_zip || "";
      toCountry = (shipping.country_code || shipping.country || "").toString().toUpperCase().slice(0, 2) || "";
      fromName = company?.name || "Shipper";
      fromAddress = company?.address1 || company?.address?.address1 || "";
      fromCity = company?.city || company?.address?.city || "";
      fromPostal = company?.postal_code || company?.address?.postal_code || "";
      fromCountry = (company?.country_code || company?.address?.country_code || "").toString().toUpperCase().slice(0, 2) || "";
    } catch (e) {
      console.warn("[label] order/company lookup failed, using defaults:", e?.message);
    }

    const trackingUrl = (c.tracking_url && typeof c.tracking_url === "string" ? c.tracking_url.trim() : "") || "";
    const trackLink =
      trackingUrl && (trackingUrl.startsWith("http://") || trackingUrl.startsWith("https://"))
        ? `<div style="margin-top:6px;"><a href="${escapeHtml(trackingUrl)}" target="_blank" rel="noopener" style="font-size:${fs};color:#2563eb;">Track package</a></div>`
        : "";

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Shipping Label</title>
<style>@media print{body{margin:0;padding:.5in;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style>
</head><body style="font-family:Arial,Helvetica,sans-serif;font-size:${fs};line-height:1.4;color:${color};max-width:4in;margin:.5in;padding:0;background:#fff">
  <div style="font-size:${fs};font-weight:${fwBold};margin:0 0 10px 0;color:${color}">Shipping label</div>
  <div style="margin-bottom:14px">
    <div style="font-size:${fs};font-weight:${fwBold};margin:0 0 5px 0;color:${color}">From</div>
    ${row("Name", fromName)}${row("Address", fromAddress)}${row("City", fromCity)}${row("Postcode", fromPostal)}${row("Country", fromCountry)}
  </div>
  <div style="margin-bottom:14px">
    <div style="font-size:${fs};font-weight:${fwBold};margin:0 0 5px 0;color:${color}">To</div>
    ${row("Name", toName)}${row("Address", toAddress)}${row("City", toCity)}${row("Postcode", toPostal)}${row("Country", toCountry)}
  </div>
  <div style="margin-top:14px;padding-top:8px;border-top:1px solid ${color}">
    <div style="font-size:${fs};font-weight:${fwBold};margin:0 0 3px 0;color:${color}">Tracking</div>
    <div style="font-size:${fs};font-weight:${fwBold};letter-spacing:.04em;color:${color}">${escapeHtml(String(c.tracking_number || ""))}</div>
    ${trackLink}
  </div>
</body></html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (err) {
    console.error("[label] consignment label error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// ---------- Carriers (from auth DB, read-only) ----------
/** List carriers - from auth DB */
router.get("/carriers", async (req, res) => {
  try {
    const authDb = await getAuthDb();
    const list = await authDb
      .collection("carriers")
      .find({})
      .sort({ name: 1 })
      .toArray();
    return res.json({
      carriers: list.map((c) => ({
        id: c._id.toString(),
        name: c.name,
        slug: c.slug,
        credentials_schema: c.credentials_schema || [],
        created_at: c.created_at,
        updated_at: c.updated_at,
      })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------- Carrier integrations (tenant-scoped) ----------
/** List carrier integrations */
router.get("/carrier-integrations", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ carrier_integrations: [] });
    }
    const tenantDb = await getTenantDb(tenantName);
    const authDb = await getAuthDb();
    const carriersColl = authDb.collection("carriers");
    const list = await tenantDb
      .collection("carrier_integrations")
      .find({})
      .sort({ created_at: -1 })
      .toArray();
    const withCarrier = await Promise.all(
      list.map(async (ci) => {
        const carrierOid = toObjectId(ci.carrier_id);
        const carrier = carrierOid ? await carriersColl.findOne({ _id: carrierOid }) : null;
        return {
          id: ci._id.toString(),
          carrier_id: ci.carrier_id?.toString ? ci.carrier_id.toString() : String(ci.carrier_id ?? ""),
          carrier_name: carrier?.name ?? "Unknown",
          carrier_slug: carrier?.slug || "",
          credentials_schema: carrier?.credentials_schema || [],
          credentials: ci.credentials || {},
          status: ci.status === 1 ? 1 : 0,
          created_at: ci.created_at,
          updated_at: ci.updated_at,
        };
      })
    );
    return res.json({ carrier_integrations: withCarrier });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Create carrier integration */
router.post("/carrier-integrations", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { carrier_id, credentials, status } = req.body || {};
    if (!carrier_id) {
      return res.status(400).json({ error: "carrier_id is required" });
    }
    const authDb = await getAuthDb();
    const carrier = await authDb.collection("carriers").findOne({ _id: new ObjectId(carrier_id) });
    if (!carrier) {
      return res.status(400).json({ error: "Carrier not found" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const carrierIntegrations = tenantDb.collection("carrier_integrations");
    const doc = {
      carrier_id,
      credentials: credentials || {},
      status: status === 1 ? 1 : 0,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const result = await carrierIntegrations.insertOne(doc);
    return res.status(201).json({
      id: result.insertedId.toString(),
      carrier_id,
      carrier_name: carrier.name,
      carrier_slug: carrier.slug,
      credentials_schema: carrier.credentials_schema || [],
      credentials: doc.credentials,
      status: doc.status,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Update carrier integration */
router.put("/carrier-integrations/:id", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    const { credentials, status } = req.body || {};
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const carrierIntegrations = tenantDb.collection("carrier_integrations");
    const update = { updated_at: new Date() };
    if (credentials !== undefined) update.credentials = credentials;
    if (status !== undefined) update.status = status === 1 ? 1 : 0;
    const result = await carrierIntegrations.findOneAndUpdate(
      { _id: oid },
      { $set: update },
      { returnDocument: "after" }
    );
    if (!result) {
      return res.status(404).json({ error: "Carrier integration not found" });
    }
    const authDb = await getAuthDb();
    const carrierOid = toObjectId(result.carrier_id);
    const carrier = carrierOid ? await authDb.collection("carriers").findOne({ _id: carrierOid }) : null;
    return res.json({
      id: result._id.toString(),
      carrier_id: result.carrier_id?.toString ? result.carrier_id.toString() : String(result.carrier_id ?? ""),
      carrier_name: carrier?.name ?? "Unknown",
      carrier_slug: carrier?.slug || "",
      credentials_schema: carrier?.credentials_schema || [],
      credentials: result.credentials || {},
      status: result.status,
      created_at: result.created_at,
      updated_at: result.updated_at,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Delete carrier integration */
router.delete("/carrier-integrations/:id", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const result = await tenantDb.collection("carrier_integrations").deleteOne({ _id: oid });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Carrier integration not found" });
    }
    return res.status(204).send();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------- Carrier services (from auth DB, read-only; optional ?carrier_id=) ----------
router.get("/carrier-services", async (req, res) => {
  try {
    const authDb = await getAuthDb();
    const carrierId = req.query.carrier_id;
    let filter = {};
    if (carrierId) {
      try {
        filter.carrier_id = new ObjectId(carrierId);
      } catch {
        return res.status(400).json({ error: "Invalid carrier_id" });
      }
    }
    const list = await authDb
      .collection("carrier_services")
      .find(filter)
      .sort({ name: 1 })
      .toArray();
    return res.json({
      carrier_services: list.map((s) => ({
        id: s._id.toString(),
        carrier_id: s.carrier_id.toString(),
        name: s.name,
        code: s.code || "",
        created_at: s.created_at,
        updated_at: s.updated_at,
      })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------- Carrier integration services (tenant-scoped; services linked to a carrier integration) ----------
/** List carrier integration services; optional ?carrier_integration_id= */
router.get("/carrier-integration-services", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const carrierIntegrationId = req.query.carrier_integration_id;
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ carrier_integration_services: [] });
    }
    const tenantDb = await getTenantDb(tenantName);
    const authDb = await getAuthDb();
    const servicesColl = authDb.collection("carrier_services");
    const filter = carrierIntegrationId ? { carrier_integration_id: carrierIntegrationId } : {};
    const list = await tenantDb
      .collection("carrier_integration_services")
      .find(filter)
      .sort({ created_at: -1 })
      .toArray();
    const withService = await Promise.all(
      list.map(async (cis) => {
        const svcOid = toObjectId(cis.carrier_service_id);
        const svc = svcOid ? await servicesColl.findOne({ _id: svcOid }) : null;
        return {
          id: cis._id.toString(),
          carrier_integration_id: cis.carrier_integration_id?.toString ? cis.carrier_integration_id.toString() : String(cis.carrier_integration_id ?? ""),
          carrier_service_id: cis.carrier_service_id?.toString ? cis.carrier_service_id.toString() : String(cis.carrier_service_id ?? ""),
          carrier_service_name: svc?.name ?? "Unknown",
          carrier_service_code: svc?.code || "",
          created_at: cis.created_at,
          updated_at: cis.updated_at,
        };
      })
    );
    return res.json({ carrier_integration_services: withService });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Create carrier integration service */
router.post("/carrier-integration-services", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { carrier_integration_id, carrier_service_id } = req.body || {};
    if (!carrier_integration_id || !carrier_service_id) {
      return res.status(400).json({ error: "carrier_integration_id and carrier_service_id are required" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const ci = await tenantDb.collection("carrier_integrations").findOne({ _id: new ObjectId(carrier_integration_id) });
    if (!ci) {
      return res.status(400).json({ error: "Carrier integration not found" });
    }
    const authDb = await getAuthDb();
    const svc = await authDb.collection("carrier_services").findOne({ _id: new ObjectId(carrier_service_id) });
    if (!svc) {
      return res.status(400).json({ error: "Carrier service not found" });
    }
    const coll = tenantDb.collection("carrier_integration_services");
    const existing = await coll.findOne({ carrier_integration_id, carrier_service_id });
    if (existing) {
      return res.status(400).json({ error: "This service is already linked to this carrier integration" });
    }
    const doc = {
      carrier_integration_id,
      carrier_service_id,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const result = await coll.insertOne(doc);
    return res.status(201).json({
      id: result.insertedId.toString(),
      carrier_integration_id,
      carrier_service_id,
      carrier_service_name: svc.name,
      carrier_service_code: svc.code || "",
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Update carrier integration service (e.g. extra config later) */
router.put("/carrier-integration-services/:id", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const coll = tenantDb.collection("carrier_integration_services");
    const result = await coll.findOneAndUpdate(
      { _id: oid },
      { $set: { updated_at: new Date() } },
      { returnDocument: "after" }
    );
    if (!result) {
      return res.status(404).json({ error: "Carrier integration service not found" });
    }
    const authDb = await getAuthDb();
    const svcOid = toObjectId(result.carrier_service_id);
    const svc = svcOid ? await authDb.collection("carrier_services").findOne({ _id: svcOid }) : null;
    return res.json({
      id: result._id.toString(),
      carrier_integration_id: result.carrier_integration_id?.toString ? result.carrier_integration_id.toString() : String(result.carrier_integration_id ?? ""),
      carrier_service_id: result.carrier_service_id?.toString ? result.carrier_service_id.toString() : String(result.carrier_service_id ?? ""),
      carrier_service_name: svc?.name ?? "Unknown",
      carrier_service_code: svc?.code || "",
      created_at: result.created_at,
      updated_at: result.updated_at,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Delete carrier integration service */
router.delete("/carrier-integration-services/:id", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const { id } = req.params;
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid id" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const result = await tenantDb.collection("carrier_integration_services").deleteOne({ _id: oid });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Carrier integration service not found" });
    }
    return res.status(204).send();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
