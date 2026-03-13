import { ObjectId } from "mongodb";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb, tenantDbExists } from "../db/tenantDb.js";
import { ShopifyIntegration } from "../integrations/Shopify.js";

const BATCH_LIMIT = 200;
const MAX_RETRIES = 3;

/**
 * Sync inventory from tenant DB to Shopify for products that have channel_products mapping,
 * active company integration, and an inventory interface marked as connected. Runs per tenant.
 */
export async function syncInventoryToChannelsForTenant(tenantName) {
  if (!(await tenantDbExists(tenantName))) return { synced: 0, errors: [] };
  const tenantDb = await getTenantDb(tenantName);
  const authDb = await getAuthDb();
  const productsColl = tenantDb.collection("products");
  const inventoryColl = tenantDb.collection("inventory");
  const channelProductsColl = tenantDb.collection("channel_products");
  const companyIntegrationsColl = tenantDb.collection("company_integrations");
  const inventoryInterfacesColl = tenantDb.collection("inventory_interfaces");
  const logsColl = tenantDb.collection("inventory_sync_logs");
  const integrationsColl = authDb.collection("integrations");

  const shopifyIntegration = await integrationsColl.findOne({ slug: "shopify" });
  if (!shopifyIntegration) return { synced: 0, errors: [] };

  // Only integrations that have inventory feature (or no features field = all)
  const activeCis = await companyIntegrationsColl
    .find({
      status: 1,
      $or: [{ features: { $exists: false } }, { features: "inventory" }],
    })
    .toArray();
  const shopifyCiIds = new Set();
  for (const ci of activeCis) {
    const intId = ci.integration_id instanceof ObjectId ? ci.integration_id : new ObjectId(ci.integration_id);
    if (intId.equals(shopifyIntegration._id) && ci.credentials) {
      shopifyCiIds.add(ci._id.toString());
    }
  }
  if (shopifyCiIds.size === 0) return { synced: 0, errors: [] };

  // Only sync for company integrations that have an inventory interface connected
  const interfaces = await inventoryInterfacesColl.find({ is_connected: true }).toArray();
  const interfaceByCiId = new Map();
  const connectedCiIds = new Set();
  for (const ii of interfaces) {
    const ciId =
      ii.company_integration_id instanceof ObjectId
        ? ii.company_integration_id.toString()
        : String(ii.company_integration_id || "");
    if (!ciId) continue;
    interfaceByCiId.set(ciId, ii);
    connectedCiIds.add(ciId);
  }

  const mappings = await channelProductsColl
    .find({
      channel_name: "shopify",
      channel_inventory_item_id: { $nin: [null, ""] },
    })
    .limit(BATCH_LIMIT)
    .toArray();

  let synced = 0;
  const errors = [];

  for (const cp of mappings) {
    const productId = cp.product_id instanceof ObjectId ? cp.product_id : new ObjectId(cp.product_id);
    const product = await productsColl.findOne({ _id: productId });
    if (!product || !product.company_id) continue;
    const companyIdStr = product.company_id.toString();
    const ci = activeCis.find(
      (c) =>
        (c.company_id instanceof ObjectId ? c.company_id.toString() : c.company_id) === companyIdStr &&
        shopifyCiIds.has(c._id.toString()) &&
        connectedCiIds.has(c._id.toString())
    );
    if (!ci || !ci.credentials) continue;

    const inv = await inventoryColl.findOne({ product_id: productId });
    const quantity = inv && typeof inv.quantity === "number" ? inv.quantity : 0;
    const inventoryItemId = cp.channel_inventory_item_id;

    let attempt = 0;
    let lastError = null;
    let success = false;
    while (attempt < MAX_RETRIES && !success) {
      attempt++;
      try {
        const result = await ShopifyIntegration.setInventory(ci.credentials, inventoryItemId, quantity);
        if (result.success) {
          success = true;
          synced++;
          const iface = interfaceByCiId.get(ci._id.toString());
          if (iface) {
            await inventoryInterfacesColl.updateOne(
              { _id: iface._id },
              { $set: { last_synced_at: new Date() } }
            );
          }
          await logsColl.insertOne({
            product_id: productId,
            channel_name: "shopify",
            status: "success",
            message: null,
            created_at: new Date(),
          });
        } else {
          lastError = result.error || "Unknown inventory sync error";
        }
      } catch (err) {
        lastError = err?.message || String(err);
      }
    }
    if (!success && lastError) {
      errors.push({ product_id: productId.toString(), error: lastError });
      await logsColl.insertOne({
        product_id: productId,
        channel_name: "shopify",
        status: "error",
        message: lastError,
        created_at: new Date(),
      });
    }
  }

  return { synced, errors };
}

/**
 * Run inventory sync for all approved tenants (for cron).
 */
export async function syncInventoryToChannelsForAllTenants() {
  const authDb = await getAuthDb();
  const tenants = await authDb.collection("tenants").find({ status: "approved" }).toArray();
  const results = {};
  for (const t of tenants) {
    const name = t.tenant_name;
    try {
      results[name] = await syncInventoryToChannelsForTenant(name);
    } catch (err) {
      results[name] = { synced: 0, errors: [err?.message || String(err)] };
    }
  }
  return results;
}
