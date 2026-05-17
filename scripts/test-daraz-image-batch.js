import "../src/loadEnv.js";
import { darazGet, darazPost } from "../src/integrations/darazApi.js";
import { DarazIntegration } from "../src/integrations/Daraz.js";
import { getTenantDb } from "../src/db/tenantDb.js";

const tenantDb = await getTenantDb("Zee_Store");
const ci = await tenantDb.collection("company_integrations").findOne({
  integration_id: "6a08607ac2091870bb5d529a",
});
const token = (await DarazIntegration.ensureAccessToken(ci.credentials)).access_token;

const imgUrl = "https://picsum.photos/500/500.jpg";
const xml = `<?xml version="1.0" encoding="UTF-8"?><Request><Images><Url>${imgUrl}</Url></Images></Request>`;

const r = await darazPost("/images/migrate", { payload: xml }, token);
console.log("migrate", r);
const batchId = r.batch_id;
for (let i = 0; i < 5; i++) {
  await new Promise((res) => setTimeout(res, 1000));
  try {
    const poll = await darazGet("/image/response/get", { batch_id: batchId }, token);
    console.log("poll attempt", i + 1, JSON.stringify(poll, null, 2));
    const urls = poll?.data?.images?.map((x) => x.url).filter(Boolean);
    if (urls?.length) break;
  } catch (e) {
    console.log("poll attempt", i + 1, e.message);
  }
}
