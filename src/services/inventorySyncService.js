import { ObjectId } from "mongodb";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb, tenantDbExists } from "../db/tenantDb.js";
import { ShopifyIntegration } from "../integrations/Shopify.js";
import { DarazIntegration } from "../integrations/Daraz.js";

const BATCH_LIMIT = 200;
const MAX_RETRIES = 3;

async function syncOneChannelMapping({
  channelName,
  cp,
  product,
  inv,
  activeCis,
  integrationsBySlug,
  inventoryInterfacesColl,
  interfaceByCiId,
  logsColl,
}) {
  const productId = cp.product_id instanceof ObjectId ? cp.product_id : new ObjectId(cp.product_id);
  if (!product?.company_id) return { synced: false, error: null };

  const companyIdStr = product.company_id.toString();
  const intDoc = integrationsBySlug.get(channelName);
  if (!intDoc) return { synced: false, error: null };

  const ci = activeCis.find((c) => {
    const cid = c.company_id instanceof ObjectId ? c.company_id.toString() : String(c.company_id || "");
    const intId = c.integration_id instanceof ObjectId ? c.integration_id : new ObjectId(c.integration_id);
    return (
      cid === companyIdStr &&
      (intId.equals(intDoc._id) || intId.toString() === intDoc._id.toString()) &&
      c.credentials
    );
  });
  if (!ci) return { synced: false, error: null };

  const ciId = ci._id.toString();
  const iface = interfaceByCiId.get(ciId);
  if (channelName === "shopify" && !iface) return { synced: false, error: null };

  const quantity = inv && typeof inv.quantity === "number" ? inv.quantity : 0;

  let attempt = 0;
  let lastError = null;
  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      let result;
      if (channelName === "shopify") {
        if (!cp.channel_inventory_item_id) {
          return { synced: false, error: "Missing Shopify inventory item id" };
        }
        result = await ShopifyIntegration.setInventory(
          ci.credentials,
          cp.channel_inventory_item_id,
          quantity
        );
      } else if (channelName === "daraz") {
        let credentials = ci.credentials;
        credentials = await DarazIntegration.ensureAccessToken(credentials);
        result = await DarazIntegration.setInventory(credentials, {
          sellerSku: cp.channel_seller_sku || product.sku || "",
          skuId: cp.channel_variant_id || "",
          quantity,
          price: product.price != null ? product.price : undefined,
        });
      } else {
        return { synced: false, error: `Unsupported channel: ${channelName}` };
      }

      if (result.success) {
        if (iface) {
          await inventoryInterfacesColl.updateOne(
            { _id: iface._id },
            { $set: { last_synced_at: new Date() } }
          );
        }
        await logsColl.insertOne({
          product_id: productId,
          channel_name: channelName,
          status: "success",
          message: null,
          created_at: new Date(),
        });
        return { synced: true, error: null };
      }
      lastError = result.error || "Unknown inventory sync error";
    } catch (err) {
      lastError = err?.message || String(err);
    }
  }

  await logsColl.insertOne({
    product_id: productId,
    channel_name: channelName,
    status: "error",
    message: lastError,
    created_at: new Date(),
  });
  return { synced: false, error: lastError };
}

/**
 * Sync inventory from tenant DB to Shopify and Daraz for mapped products.
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

  const integrationsBySlug = new Map();
  for (const slug of ["shopify", "daraz"]) {
    const doc = await integrationsColl.findOne({ slug });
    if (doc) integrationsBySlug.set(slug, doc);
  }
  if (integrationsBySlug.size === 0) return { synced: 0, errors: [] };

  const activeCis = await companyIntegrationsColl
    .find({
      status: 1,
      $or: [{ features: { $exists: false } }, { features: "inventory" }],
    })
    .toArray();

  const interfaces = await inventoryInterfacesColl.find({ is_connected: true }).toArray();
  const interfaceByCiId = new Map();
  for (const ii of interfaces) {
    const ciId =
      ii.company_integration_id instanceof ObjectId
        ? ii.company_integration_id.toString()
        : String(ii.company_integration_id || "");
    if (ciId) interfaceByCiId.set(ciId, ii);
  }

  const mappings = await channelProductsColl
    .find({
      channel_name: { $in: ["shopify", "daraz"] },
    })
    .limit(BATCH_LIMIT)
    .toArray();

  let synced = 0;
  const errors = [];

  for (const cp of mappings) {
    if (cp.channel_name === "shopify" && !cp.channel_inventory_item_id) continue;
    if (
      cp.channel_name === "daraz" &&
      !cp.channel_seller_sku &&
      !cp.channel_variant_id &&
      !cp.channel_product_id
    ) {
      continue;
    }

    const productId = cp.product_id instanceof ObjectId ? cp.product_id : new ObjectId(cp.product_id);
    const product = await productsColl.findOne({ _id: productId });
    if (!product) continue;

    const inv = await inventoryColl.findOne({ product_id: productId });
    const { synced: ok, error } = await syncOneChannelMapping({
      channelName: cp.channel_name,
      cp,
      product,
      inv,
      activeCis,
      integrationsBySlug,
      inventoryInterfacesColl,
      interfaceByCiId,
      logsColl,
    });
    if (ok) synced++;
    else if (error) errors.push({ product_id: productId.toString(), channel: cp.channel_name, error });
  }

  return { synced, errors };
}

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
