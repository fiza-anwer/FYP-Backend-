import "../src/loadEnv.js";
import { darazGet, darazPost } from "../src/integrations/darazApi.js";
import { DarazIntegration } from "../src/integrations/Daraz.js";
import { getTenantDb } from "../src/db/tenantDb.js";

const tenantDb = await getTenantDb("Zee_Store");
const ci = await tenantDb.collection("company_integrations").findOne({
  integration_id: "6a08607ac2091870bb5d529a",
});
const creds = await DarazIntegration.ensureAccessToken(ci.credentials);
const token = creds.access_token;

const imgUrl =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/320px-PNG_transparency_demonstration_1.png";
const xml = `<?xml version="1.0" encoding="UTF-8"?><Request><Image><Url>${imgUrl}</Url></Image></Request>`;

const r = await darazPost("/images/migrate", { payload: xml }, token);
console.log("migrate", JSON.stringify(r, null, 2));

// poll batch if needed
if (r.batch_id) {
  try {
    const poll = await darazGet("/image/response/get", { batch_id: r.batch_id }, token);
    console.log("poll", JSON.stringify(poll, null, 2).slice(0, 800));
  } catch (e) {
    console.log("poll err", e.message);
  }
}
