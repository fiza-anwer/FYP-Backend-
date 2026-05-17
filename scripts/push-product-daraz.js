import "../src/loadEnv.js";
import { DarazIntegration } from "../src/integrations/Daraz.js";
import { getTenantDb } from "../src/db/tenantDb.js";
import { getAuthDb } from "../src/db/authDb.js";
import { ObjectId } from "mongodb";

const productId = process.argv[2] || "6a0897457125295b3b22d22b";
const tenantName = process.argv[3] || "Zee_Store";

const tdb = await getTenantDb(tenantName);
const adb = await getAuthDb();
const p = await tdb.collection("products").findOne({ _id: new ObjectId(productId) });
if (!p) {
  console.log("Product not found");
  process.exit(1);
}
const daraz = await adb.collection("integrations").findOne({ slug: "daraz" });
const companyOid = p.company_id instanceof ObjectId ? p.company_id : new ObjectId(p.company_id);
const ci = await tdb.collection("company_integrations").findOne({
  company_id: { $in: [companyOid, companyOid.toString()] },
  integration_id: { $in: [daraz._id, daraz._id.toString()] },
  status: 1,
});
const inv = await tdb.collection("inventory").findOne({ product_id: p._id });
const creds = await DarazIntegration.ensureAccessToken(ci.credentials);
console.log("Pushing", p.title, "images:", p.images);
try {
  const r = await DarazIntegration.pushProduct(
    creds,
    { ...p, quantity: inv?.quantity ?? 0, inventory_quantity: inv?.quantity ?? 0 },
    {}
  );
  console.log("OK", r);
} catch (e) {
  console.log("FAIL", e.message);
}
