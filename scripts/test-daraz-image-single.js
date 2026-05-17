import "../src/loadEnv.js";
import { darazGet, darazPost } from "../src/integrations/darazApi.js";
import { DarazIntegration } from "../src/integrations/Daraz.js";
import { getTenantDb } from "../src/db/tenantDb.js";

const tenantDb = await getTenantDb("Zee_Store");
const ci = await tenantDb.collection("company_integrations").findOne({
  integration_id: "6a08607ac2091870bb5d529a",
});
const token = (await DarazIntegration.ensureAccessToken(ci.credentials)).access_token;

const imgUrl =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/320px-PNG_transparency_demonstration_1.png";
const xml = `<?xml version="1.0" encoding="UTF-8"?><Request><Image><Url>${imgUrl}</Url></Image></Request>`;

for (const path of ["/image/migrate", "/images/migrate"]) {
  try {
    const r = await darazPost(path, { payload: xml }, token);
    console.log(path, JSON.stringify(r, null, 2));
    const batchId = r.batch_id || r.data?.batch_id;
    if (batchId) {
      await new Promise((r) => setTimeout(r, 800));
      const poll = await darazGet("/image/response/get", { batch_id: batchId }, token);
      console.log("poll", JSON.stringify(poll, null, 2).slice(0, 800));
    }
  } catch (e) {
    console.log(path, "ERR", e.message);
  }
}
