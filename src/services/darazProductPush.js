import { ObjectId } from "mongodb";
import { getAuthDb } from "../db/authDb.js";
import { DarazIntegration } from "../integrations/Daraz.js";
import { validateProductImagesForDaraz } from "../utils/productImageUrls.js";

function darazPushEnabled(integrationSlugs) {
  const slugs = Array.isArray(integrationSlugs) ? integrationSlugs : [];
  return slugs.length === 0 || slugs.includes("daraz");
}

/**
 * Push one product to Daraz (create or update). Returns warning text if skipped or failed softly.
 */
export async function pushProductToDarazForCompany(tenantDb, product, productId, options = {}) {
  const { integrationSlugs, requireImages = true } = options;
  if (!product?.company_id) {
    return { warning: "No company on product — assign a company with Daraz connected." };
  }
  if (!darazPushEnabled(integrationSlugs ?? product.integration_slugs)) {
    return { warning: null, skipped: true, reason: "daraz_not_selected" };
  }
  const sku = (product.sku || product.variants?.[0]?.sku || "").trim();
  if (!sku) {
    return { warning: "SKU is required to sync this product to Daraz." };
  }
  if (requireImages) {
    const imgErr = validateProductImagesForDaraz(product.images);
    if (imgErr) return { warning: imgErr };
  }

  const adb = await getAuthDb();
  const integrationsColl = adb.collection("integrations");
  const companyIntegrationsColl = tenantDb.collection("company_integrations");
  const darazIntegration = await integrationsColl.findOne({ slug: "daraz" });
  if (!darazIntegration) {
    return { warning: "Daraz integration is not configured on this server." };
  }

  const companyOid =
    product.company_id instanceof ObjectId ? product.company_id : new ObjectId(product.company_id);
  const darazCi = await companyIntegrationsColl.findOne({
    company_id: { $in: [companyOid, companyOid.toString()] },
    integration_id: { $in: [darazIntegration._id, darazIntegration._id.toString()] },
    status: 1,
    $or: [
      { features: { $exists: false } },
      { features: "products" },
      { features: { $in: ["products"] } },
    ],
  });

  if (!darazCi?.credentials) {
    return {
      warning:
        "Daraz is not connected for this company. Open Setup → Company Integrations and connect Daraz.",
    };
  }

  const pid = productId instanceof ObjectId ? productId : new ObjectId(productId);
  const invDoc = await tenantDb.collection("inventory").findOne({ product_id: pid });
  const qty = invDoc && typeof invDoc.quantity === "number" ? invDoc.quantity : 0;

  let darazCreds = await DarazIntegration.ensureAccessToken(darazCi.credentials);
  if (darazCreds.access_token !== darazCi.credentials?.access_token) {
    await companyIntegrationsColl.updateOne(
      { _id: darazCi._id },
      { $set: { credentials: darazCreds, updated_at: new Date() } }
    );
  }

  const cpColl = tenantDb.collection("channel_products");
  const existingCp = (await cpColl.findOne({ product_id: pid, channel_name: "daraz" })) || {};

  try {
    const darazPush = await DarazIntegration.pushProduct(
      darazCreds,
      {
        ...product,
        sku,
        quantity: qty,
        inventory_quantity: qty,
      },
      existingCp
    );

    await cpColl.updateOne(
      { product_id: pid, channel_name: "daraz" },
      {
        $set: {
          channel_seller_sku: darazPush.channel_seller_sku || sku,
          channel_variant_id: darazPush.channel_variant_id || null,
          channel_product_id: darazPush.channel_product_id || null,
          updated_at: new Date(),
        },
      },
      { upsert: true }
    );

    if (!darazPush.channel_product_id) {
      return {
        warning:
          "Daraz did not return a product id. Try Push to Daraz from the product list again in a minute.",
        darazPush,
      };
    }

    await tenantDb.collection("products").updateOne(
      { _id: pid },
      {
        $set: {
          external_id: darazPush.channel_product_id,
          source: product.source === "shopify" ? "shopify" : "daraz",
          status: "active",
          updated_at: new Date(),
        },
      }
    );

    return { darazPush, message: darazPush.created ? "Product created on Daraz." : "Daraz stock/price updated." };
  } catch (err) {
    return { warning: err.message || String(err) };
  }
}
