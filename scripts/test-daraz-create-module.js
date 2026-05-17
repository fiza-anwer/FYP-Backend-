import "../src/loadEnv.js";
import { DarazIntegration } from "../src/integrations/Daraz.js";
import { getTenantDb } from "../src/db/tenantDb.js";

const tenantDb = await getTenantDb("Zee_Store");
const ci = await tenantDb.collection("company_integrations").findOne({
  integration_id: "6a08607ac2091870bb5d529a",
});
const creds = await DarazIntegration.ensureAccessToken(ci.credentials);

const img = "https://picsum.photos/500/500.jpg";

try {
  const r = await DarazIntegration.createProduct(creds, {
    title: "UniSell Module Test " + Date.now(),
    sku: "UNISELL-MOD-" + Date.now(),
    product_type: "Mobile Accessories",
    description: "<p>Test listing from UniSell module.</p>",
    vendor: "No Brand",
    price: 1999,
    quantity: 3,
    images: [img],
  });
  console.log("SUCCESS", r);
} catch (e) {
  console.log("FAIL", e.message);
}
