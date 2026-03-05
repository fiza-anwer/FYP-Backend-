import express from "express";
import { ObjectId } from "mongodb";
import { authMiddleware, tenantOnly } from "../middleware/auth.js";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb, tenantDbExists } from "../db/tenantDb.js";
import { createConsignments } from "../services/consignmentService.js";
import { dispatchOrders } from "../services/dispatchService.js";

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
        return {
          id: ci._id.toString(),
          company_id: ci.company_id || null,
          company_name: company_name || null,
          integration_id: ci.integration_id,
          integration_name: integration?.name || "Unknown",
          integration_slug: integration?.slug || "",
          credentials: ci.credentials || {},
          status: ci.status === 1 ? 1 : 0,
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
    const { company_id, integration_id, credentials, status } = req.body || {};
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
    const doc = {
      company_id,
      integration_id,
      credentials: credentials || {},
      status: status === 1 ? 1 : 0,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const result = await companyIntegrations.insertOne(doc);
    const slug = (integration.slug || "shopify").toLowerCase();
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
    return res.status(201).json({
      id: result.insertedId.toString(),
      company_id,
      company_name: company.name,
      integration_id,
      integration_name: integration.name,
      integration_slug: integration.slug,
      credentials: doc.credentials,
      status: doc.status,
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
    const { company_id, credentials, status } = req.body || {};
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
    if (credentials !== undefined) update.credentials = credentials;
    if (status !== undefined) update.status = status === 1 ? 1 : 0;
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
    return res.json({
      id: result._id.toString(),
      company_id: result.company_id || null,
      company_name,
      integration_id: result.integration_id,
      integration_name: integration?.name || "Unknown",
      integration_slug: integration?.slug || "",
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

/** List orders - for frontend orders screen; optional ?company_id= filter */
router.get("/orders", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const companyId = req.query.company_id;
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ orders: [] });
    }
    const tenantDb = await getTenantDb(tenantName);
    const companiesColl = tenantDb.collection("companies");
    const filter = {};
    if (companyId) {
      try {
        filter.company_id = new ObjectId(companyId);
      } catch {
        return res.status(400).json({ error: "Invalid company_id" });
      }
    }
    const orders = await tenantDb
      .collection("orders")
      .find(filter)
      .sort({ created_at: -1 })
      .limit(500)
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

/** List products - optional ?company_id= filter */
router.get("/products", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const companyId = req.query.company_id;
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ products: [] });
    }
    const tenantDb = await getTenantDb(tenantName);
    const companiesColl = tenantDb.collection("companies");
    const filter = {};
    if (companyId) {
      try {
        filter.company_id = new ObjectId(companyId);
      } catch {
        return res.status(400).json({ error: "Invalid company_id" });
      }
    }
    const products = await tenantDb
      .collection("products")
      .find(filter)
      .sort({ created_at: -1 })
      .limit(500)
      .toArray();
    const list = await Promise.all(
      products.map(async (p) => {
        let company_name = null;
        if (p.company_id) {
          const company = await companiesColl.findOne({ _id: p.company_id });
          company_name = company?.name || null;
        }
        return {
          id: p._id.toString(),
          company_id: p.company_id ? p.company_id.toString() : null,
          company_name,
          external_id: p.external_id || null,
          title: p.title || "",
          sku: p.sku || "",
          product_type: p.product_type || "",
          status: p.status || "active",
          price: p.price,
          source: p.source,
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

/** Create product (local product managed in UniSell) */
router.post("/products", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    if (!(await tenantDbExists(tenantName))) {
      return res.status(400).json({ error: "Tenant has no data" });
    }
    const { title, sku, product_type, price, status, source } = req.body || {};
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "title is required" });
    }
    const tenantDb = await getTenantDb(tenantName);
    const now = new Date();
    const doc = {
      company_id: null,
      external_id: null,
      title: title.trim(),
      sku: sku ? String(sku).trim() : "",
      product_type: product_type ? String(product_type).trim() : "",
      status: status ? String(status).trim() : "active",
      price: typeof price === "number" ? price : price ? Number(price) || null : null,
      source: source ? String(source).trim() : "local",
      variants: [],
      variant_count: 0,
      created_at: now,
      updated_at: now,
    };
    const result = await tenantDb.collection("products").insertOne(doc);
    const created = { ...doc, id: result.insertedId.toString() };
    return res.status(201).json({
      id: created.id,
      company_id: created.company_id,
      company_name: null,
      external_id: created.external_id,
      title: created.title,
      sku: created.sku,
      product_type: created.product_type,
      status: created.status,
      price: created.price,
      source: created.source,
      variant_count: created.variant_count,
      created_at: created.created_at,
      updated_at: created.updated_at,
    });
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
    const { title, sku, product_type, price, status } = req.body || {};
    const update = { updated_at: new Date() };
    if (title !== undefined) update.title = String(title).trim();
    if (sku !== undefined) update.sku = String(sku).trim();
    if (product_type !== undefined) update.product_type = String(product_type).trim();
    if (status !== undefined) update.status = String(status).trim();
    if (price !== undefined) {
      update.price = typeof price === "number" ? price : Number(price) || null;
    }
    const tenantDb = await getTenantDb(tenantName);
    const coll = tenantDb.collection("products");
    const result = await coll.updateOne({ _id: oid }, { $set: update });
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    const p = await coll.findOne({ _id: oid });
    const companiesColl = tenantDb.collection("companies");
    let company_name = null;
    if (p.company_id) {
      const company = await companiesColl.findOne({ _id: p.company_id });
      company_name = company?.name || null;
    }
    return res.json({
      id: p._id.toString(),
      company_id: p.company_id ? p.company_id.toString() : null,
      company_name,
      external_id: p.external_id || null,
      title: p.title || "",
      sku: p.sku || "",
      product_type: p.product_type || "",
      status: p.status || "active",
      price: p.price,
      source: p.source,
      variant_count: typeof p.variant_count === "number" ? p.variant_count : Array.isArray(p.variants) ? p.variants.length : 0,
      created_at: p.created_at,
      updated_at: p.updated_at,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
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
    return res.json({ message: "Deleted" });
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
/** List consignments; optional ?order_id= */
router.get("/consignments", async (req, res) => {
  try {
    const tenantName = req.tenantName;
    const orderId = req.query.order_id;
    if (!(await tenantDbExists(tenantName))) {
      return res.json({ consignments: [] });
    }
    const tenantDb = await getTenantDb(tenantName);
    const authDb = await getAuthDb();
    const filter = orderId ? { order_id: new ObjectId(orderId) } : {};
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
