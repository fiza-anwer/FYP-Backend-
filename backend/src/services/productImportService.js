import { ObjectId } from "mongodb";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb, tenantDbExists } from "../db/tenantDb.js";
import { ShopifyIntegration } from "../integrations/Shopify.js";

const INTEGRATION_CLASSES = {
  shopify: ShopifyIntegration,
};

/**
 * Run product import for a single tenant: find active company_integrations, fetch products, save to products collection.
 */
export async function runProductImportForTenant(tenantName) {
  if (!(await tenantDbExists(tenantName))) return { imported: 0, errors: [] };
  const tenantDb = await getTenantDb(tenantName);
  const authDb = await getAuthDb();
  const integrationsColl = authDb.collection("integrations");
  const companyIntegrations = tenantDb.collection("company_integrations");
  const productsColl = tenantDb.collection("products");

  const active = await companyIntegrations.find({ status: 1 }).toArray();
  let totalImported = 0;
  const errors = [];

  for (const ci of active) {
    const integrationId =
      typeof ci.integration_id === "string" ? new ObjectId(ci.integration_id) : ci.integration_id;
    const integration = await integrationsColl.findOne({ _id: integrationId });
    const slug = integration?.slug || String(ci.integration_id);
    const Klass = INTEGRATION_CLASSES[slug];
    if (!Klass || !Klass.fetchProducts) {
      errors.push({
        company_integration_id: ci._id.toString(),
        error: `Unknown integration for products: ${slug}`,
      });
      continue;
    }
    try {
      const products = await Klass.fetchProducts(ci.credentials || {});
      for (const product of products) {
        const existing = await productsColl.findOne({
          external_id: product.external_id,
          source: product.source || slug,
        });
        const raw = product.raw || {};
        const variants = Array.isArray(product.variants) ? product.variants : [];
        const docBase = {
          company_id: ci.company_id
            ? typeof ci.company_id === "string"
              ? new ObjectId(ci.company_id)
              : ci.company_id
            : null,
          external_id: product.external_id,
          title: product.title || "",
          sku: product.sku || "",
          product_type: product.product_type || "",
          status: product.status || "active",
          price: typeof product.price === "number" ? product.price : null,
          source: product.source || slug,
          variants,
          variant_count: variants.length,
          raw,
        };
        if (!existing) {
          await productsColl.insertOne({
            ...docBase,
            created_at: new Date(),
            updated_at: new Date(),
          });
          totalImported++;
        } else {
          await productsColl.updateOne(
            { _id: existing._id },
            {
              $set: {
                ...docBase,
                created_at: existing.created_at || new Date(),
                updated_at: new Date(),
              },
            }
          );
        }
      }
    } catch (err) {
      errors.push({
        company_integration_id: ci._id.toString(),
        error: err.message || String(err),
      });
    }
  }

  return { imported: totalImported, errors };
}

/**
 * Run product import for all approved tenants (for cron).
 */
export async function runProductImportForAllTenants() {
  const authDb = await getAuthDb();
  const tenants = await authDb.collection("tenants").find({ status: "approved" }).toArray();
  const results = {};
  for (const t of tenants) {
    const name = t.tenant_name;
    try {
      results[name] = await runProductImportForTenant(name);
    } catch (err) {
      results[name] = { imported: 0, errors: [err.message || String(err)] };
    }
  }
  return results;
}

