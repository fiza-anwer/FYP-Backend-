import { ObjectId } from "mongodb";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb, tenantDbExists } from "../db/tenantDb.js";
import { ensureInventoryForProduct } from "./inventoryService.js";
import { onInventoryQuantityChanged } from "./stockAlertService.js";
import { ShopifyIntegration } from "../integrations/Shopify.js";
import { DarazIntegration } from "../integrations/Daraz.js";

const INTEGRATION_CLASSES = {
  shopify: ShopifyIntegration,
  daraz: DarazIntegration,
};

/** Apply channel stock without wiping a higher local quantity when the channel reports 0. */
async function applyImportedInventoryQuantity(
  tenantDb,
  tenantName,
  inventoryColl,
  productId,
  newQty,
  prevQty
) {
  if (prevQty > 0 && newQty === 0) {
    return;
  }
  await inventoryColl.updateOne(
    { product_id: productId },
    {
      $set: { quantity: newQty, updated_at: new Date() },
      $setOnInsert: { product_id: productId, allocated: 0 },
    },
    { upsert: true }
  );
  await onInventoryQuantityChanged(tenantDb, tenantName, productId, prevQty, newQty);
}

/**
 * Run product import for a single tenant: find active company_integrations, fetch products, save to products collection.
 * Creates inventory and channel_products (Shopify mapping) when creating or linking products.
 */
export async function runProductImportForTenant(tenantName) {
  if (!(await tenantDbExists(tenantName))) return { imported: 0, errors: [] };
  const tenantDb = await getTenantDb(tenantName);
  const authDb = await getAuthDb();
  const integrationsColl = authDb.collection("integrations");
  const companyIntegrations = tenantDb.collection("company_integrations");
  const productsColl = tenantDb.collection("products");
  const inventoryColl = tenantDb.collection("inventory");
  const channelProductsColl = tenantDb.collection("channel_products");

  // Only integrations that have products feature (or no features field = all)
  const active = await companyIntegrations
    .find({
      status: 1,
      $or: [{ features: { $exists: false } }, { features: "products" }],
    })
    .toArray();
  let totalImported = 0;
  let totalUpdated = 0;
  let totalFetched = 0;
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
      const products = await Klass.fetchProducts(credentials);
      totalFetched += products.length;
      const companyOid = ci.company_id
        ? typeof ci.company_id === "string"
          ? new ObjectId(ci.company_id)
          : ci.company_id
        : null;
      for (const product of products) {
        const extId = product.external_id;
        const raw = product.raw || {};
        const variants = Array.isArray(product.variants) ? product.variants : [];
        const firstVariant = variants[0];
        const skuTrim = product.sku != null ? String(product.sku).trim() : "";
        let existing = extId ? await productsColl.findOne({ external_id: extId }) : null;
        if (!existing && skuTrim && companyOid) {
          existing = await productsColl.findOne({
            company_id: { $in: [companyOid, companyOid.toString()] },
            $or: [{ sku: skuTrim }, { "variants.sku": skuTrim }],
          });
        }
        if (!existing && skuTrim) {
          existing = await productsColl.findOne({
            $or: [{ sku: skuTrim }, { "variants.sku": skuTrim }],
          });
        }
        const docBase = {
          company_id: companyOid,
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
        let productId;
        if (!existing) {
          const now = new Date();
          const insertResult = await productsColl.insertOne({
            ...docBase,
            created_at: now,
            updated_at: now,
          });
          productId = insertResult.insertedId;
          totalImported++;
        } else {
          productId = existing._id;
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
          totalUpdated++;
        }
        if (firstVariant && typeof firstVariant.inventory_quantity === "number") {
          const prevInv = await inventoryColl.findOne({ product_id: productId });
          const prevQty = typeof prevInv?.quantity === "number" ? prevInv.quantity : 0;
          const newQty = firstVariant.inventory_quantity;
          await applyImportedInventoryQuantity(
            tenantDb,
            tenantName,
            inventoryColl,
            productId,
            newQty,
            prevQty
          );
        }
        const channelProductId = String(extId || raw.id || "");
        const channelVariantId = firstVariant?.id ? String(firstVariant.id) : null;
        const channelSellerSku =
          slug === "daraz"
            ? String(product.seller_sku || firstVariant?.sku || product.sku || "").trim()
            : "";
        const channelInventoryItemId =
          firstVariant?.inventory_item_id != null
            ? String(firstVariant.inventory_item_id)
            : raw.variants?.[0]?.inventory_item_id != null
              ? String(raw.variants[0].inventory_item_id)
              : null;
        if ((slug === "shopify" || slug === "daraz") && channelProductId) {
          const cpSet = {
            channel_product_id: channelProductId,
            channel_variant_id: channelVariantId,
            channel_inventory_item_id: channelInventoryItemId,
            updated_at: new Date(),
          };
          if (channelSellerSku) cpSet.channel_seller_sku = channelSellerSku;
          await channelProductsColl.updateOne(
            { product_id: productId, channel_name: slug },
            { $set: cpSet },
            { upsert: true }
          );
        }
        if (slug === "daraz" && firstVariant && typeof firstVariant.inventory_quantity === "number") {
          await ensureInventoryForProduct(tenantDb, productId);
          const prevInvDaraz = await inventoryColl.findOne({ product_id: productId });
          const prevQtyDaraz = typeof prevInvDaraz?.quantity === "number" ? prevInvDaraz.quantity : 0;
          const newQtyDaraz = firstVariant.inventory_quantity;
          await applyImportedInventoryQuantity(
            tenantDb,
            tenantName,
            inventoryColl,
            productId,
            newQtyDaraz,
            prevQtyDaraz
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

  return { imported: totalImported, updated: totalUpdated, fetched: totalFetched, errors };
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

/**
 * Push pending (not-yet-pushed) local products to Shopify for a single tenant.
 * Products with company_id where the company has active Shopify integration (products feature)
 * but no channel_products row for shopify (or source !== 'shopify') get pushed.
 * Cron will run this so when integration becomes active, products sync within 5 minutes.
 */
export async function runPushPendingProductsForTenant(tenantName) {
  if (!(await tenantDbExists(tenantName))) return { pushed: 0, errors: [] };
  const tenantDb = await getTenantDb(tenantName);
  const authDb = await getAuthDb();
  const integrationsColl = authDb.collection("integrations");
  const companyIntegrationsColl = tenantDb.collection("company_integrations");
  const productsColl = tenantDb.collection("products");
  const channelProductsColl = tenantDb.collection("channel_products");

  const shopifyIntegration = await integrationsColl.findOne({ slug: "shopify" });
  if (!shopifyIntegration) return { pushed: 0, errors: [] };

  const activeCis = await companyIntegrationsColl
    .find({
      status: 1,
      integration_id: { $in: [shopifyIntegration._id, shopifyIntegration._id.toString()] },
      $or: [{ features: { $exists: false } }, { features: "products" }],
    })
    .toArray();
  const companyIds = activeCis
    .filter((ci) => ci.credentials)
    .map((ci) => (ci.company_id instanceof ObjectId ? ci.company_id : new ObjectId(ci.company_id)));
  if (companyIds.length === 0) return { pushed: 0, errors: [] };

  const productIdsWithChannel = await channelProductsColl
    .find({ channel_name: "shopify" })
    .project({ product_id: 1 })
    .toArray();
  const productIdsPushed = productIdsWithChannel.map((r) =>
    r.product_id instanceof ObjectId ? r.product_id : new ObjectId(r.product_id)
  );

  const pending = await productsColl
    .find({
      company_id: { $in: companyIds },
      _id: { $nin: productIdsPushed },
    })
    .toArray();

  let pushed = 0;
  const errors = [];

  for (const p of pending) {
    const productTypeTrimmed = p.product_type != null ? String(p.product_type).trim() : "";
    if (!productTypeTrimmed) continue;

    const companyOid = p.company_id instanceof ObjectId ? p.company_id : new ObjectId(p.company_id);
    const ci = activeCis.find(
      (c) =>
        (c.company_id instanceof ObjectId ? c.company_id : new ObjectId(c.company_id)).equals(companyOid) && c.credentials
    );
    if (!ci) continue;

    try {
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
        errors.push({ product_id: p._id.toString(), error: "Shopify did not return product id" });
        continue;
      }
      await productsColl.updateOne(
        { _id: p._id },
        { $set: { external_id: pushResult.external_id, source: "shopify", status: "active", updated_at: new Date() } }
      );
      await channelProductsColl.updateOne(
        { product_id: p._id, channel_name: "shopify" },
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
      pushed++;
    } catch (err) {
      errors.push({ product_id: p._id.toString(), error: err.message || String(err) });
    }
  }

  return { pushed, errors };
}

/**
 * Push local product stock/price to Daraz for products linked or matching by Seller SKU.
 */
export async function runPushPendingProductsToDarazForTenant(tenantName) {
  if (!(await tenantDbExists(tenantName))) return { pushed: 0, errors: [] };
  const tenantDb = await getTenantDb(tenantName);
  const authDb = await getAuthDb();
  const integrationsColl = authDb.collection("integrations");
  const companyIntegrationsColl = tenantDb.collection("company_integrations");
  const productsColl = tenantDb.collection("products");
  const channelProductsColl = tenantDb.collection("channel_products");
  const inventoryColl = tenantDb.collection("inventory");

  const darazIntegration = await integrationsColl.findOne({ slug: "daraz" });
  if (!darazIntegration) return { pushed: 0, errors: [] };

  const activeCis = await companyIntegrationsColl
    .find({
      status: 1,
      integration_id: { $in: [darazIntegration._id, darazIntegration._id.toString()] },
      $or: [{ features: { $exists: false } }, { features: "products" }],
    })
    .toArray();
  if (activeCis.length === 0) return { pushed: 0, errors: [] };

  const companyIds = activeCis
    .filter((ci) => ci.credentials)
    .map((ci) => (ci.company_id instanceof ObjectId ? ci.company_id : new ObjectId(ci.company_id)));

  const products = await productsColl
    .find({ company_id: { $in: companyIds } })
    .limit(500)
    .toArray();

  let pushed = 0;
  const errors = [];

  for (const p of products) {
    const sku = (p.sku || "").trim();
    if (!sku) continue;

    const companyOid = p.company_id instanceof ObjectId ? p.company_id : new ObjectId(p.company_id);
    const ci = activeCis.find((c) => {
      const cid = c.company_id instanceof ObjectId ? c.company_id : new ObjectId(c.company_id);
      return cid.equals(companyOid) && c.credentials;
    });
    if (!ci) continue;

    const cp =
      (await channelProductsColl.findOne({ product_id: p._id, channel_name: "daraz" })) || {};

    try {
      let credentials = await DarazIntegration.ensureAccessToken(ci.credentials);
      if (credentials.access_token !== ci.credentials?.access_token) {
        await companyIntegrationsColl.updateOne(
          { _id: ci._id },
          { $set: { credentials, updated_at: new Date() } }
        );
      }
      const inv = await inventoryColl.findOne({ product_id: p._id });
      const qty = inv && typeof inv.quantity === "number" ? inv.quantity : 0;

      const darazPush = await DarazIntegration.pushProduct(
        credentials,
        {
          ...p,
          quantity: qty,
          inventory_quantity: qty,
          description: p.description,
          images: p.images,
          vendor: p.vendor,
          product_type: p.product_type,
        },
        cp
      );

      await channelProductsColl.updateOne(
        { product_id: p._id, channel_name: "daraz" },
        {
          $set: {
            channel_product_id:
              darazPush.channel_product_id || cp.channel_product_id || p.external_id || null,
            channel_variant_id: darazPush.channel_variant_id || cp.channel_variant_id || null,
            channel_seller_sku: darazPush.channel_seller_sku || cp.channel_seller_sku || sku,
            updated_at: new Date(),
          },
        },
        { upsert: true }
      );

      if (darazPush.channel_product_id && darazPush.created) {
        await productsColl.updateOne(
          { _id: p._id },
          {
            $set: {
              external_id: darazPush.channel_product_id,
              source: p.source === "shopify" ? "shopify" : "daraz",
              updated_at: new Date(),
            },
          }
        );
      }

      if (p.source !== "daraz") {
        await productsColl.updateOne(
          { _id: p._id },
          { $set: { source: p.source === "shopify" ? p.source : "local", updated_at: new Date() } }
        );
      }
      pushed++;
    } catch (err) {
      errors.push({ product_id: p._id.toString(), error: err.message || String(err) });
    }
  }

  return { pushed, errors };
}

export async function runPushPendingProductsToDarazForAllTenants() {
  const authDb = await getAuthDb();
  const tenants = await authDb.collection("tenants").find({ status: "approved" }).toArray();
  const results = {};
  for (const t of tenants) {
    const name = t.tenant_name;
    try {
      results[name] = await runPushPendingProductsToDarazForTenant(name);
    } catch (err) {
      results[name] = { pushed: 0, errors: [err.message] };
    }
  }
  return results;
}

/**
 * Push pending products to Shopify for all approved tenants (for cron).
 */
export async function runPushPendingProductsForAllTenants() {
  const authDb = await getAuthDb();
  const tenants = await authDb.collection("tenants").find({ status: "approved" }).toArray();
  const results = {};
  for (const t of tenants) {
    const name = t.tenant_name;
    try {
      results[name] = await runPushPendingProductsForTenant(name);
    } catch (err) {
      results[name] = { pushed: 0, errors: [err.message || String(err)] };
    }
  }
  return results;
}

