import "../src/loadEnv.js";
import { getTenantDb } from "../src/db/tenantDb.js";
import { getAuthDb } from "../src/db/authDb.js";
import { ObjectId } from "mongodb";

const tenantName = process.argv[2] || "Zee_Store";
const skuSearch = process.argv[3] || "RNG-GG";

const tdb = await getTenantDb(tenantName);
const adb = await getAuthDb();
const daraz = await adb.collection("integrations").findOne({ slug: "daraz" });
if (!daraz) {
  console.log("No daraz integration in auth DB");
  process.exit(1);
}

const cis = await tdb
  .collection("company_integrations")
  .find({ integration_id: { $in: [daraz._id, daraz._id.toString()] } })
  .toArray();

console.log("Daraz company integrations:");
for (const c of cis) {
  console.log({
    id: c._id.toString(),
    company_id: String(c.company_id),
    status: c.status,
    features: c.features,
    hasAccessToken: !!c.credentials?.access_token,
  });
}

const products = await tdb
  .collection("products")
  .find({ $or: [{ sku: new RegExp(skuSearch, "i") }, { title: /ring/i }] })
  .sort({ created_at: -1 })
  .limit(5)
  .toArray();

for (const p of products) {
  const cp = await tdb.collection("channel_products").find({ product_id: p._id }).toArray();
  const inv = await tdb.collection("inventory").findOne({ product_id: p._id });
  console.log("\n--- Product ---");
  console.log({
    id: p._id.toString(),
    title: p.title,
    sku: p.sku,
    company_id: p.company_id ? String(p.company_id) : null,
    source: p.source,
    integration_slugs: p.integration_slugs,
    product_type: p.product_type,
    imageCount: Array.isArray(p.images) ? p.images.length : 0,
    images: p.images,
    external_id: p.external_id,
    inventory_qty: inv?.quantity,
    channel_products: cp,
  });
}
