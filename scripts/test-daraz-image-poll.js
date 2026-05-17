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

const r = await darazPost("/images/migrate", { payload: xml }, token);
const batchId = r.batch_id || r.data?.batch_id;
console.log("batch_id", batchId);

const paths = [
  "/image/response/get",
  "/images/response/get",
  "/image/get",
  "/images/get",
  "/image/migrate/response/get",
];

for (const path of paths) {
  for (const params of [
    { batch_id: batchId },
    { BatchId: batchId },
    { batch_id: batchId, request_id: r.request_id },
  ]) {
    try {
      const p = await darazGet(path, params, token);
      console.log(path, params, "OK", JSON.stringify(p).slice(0, 600));
    } catch (e) {
      console.log(path, Object.keys(params).join(","), e.message.slice(0, 100));
    }
  }
}
