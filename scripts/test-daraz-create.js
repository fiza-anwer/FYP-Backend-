import "../src/loadEnv.js";
import { darazGet, darazPost } from "../src/integrations/darazApi.js";
import { DarazIntegration } from "../src/integrations/Daraz.js";
import { getTenantDb } from "../src/db/tenantDb.js";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function walk(nodes, path = []) {
  const out = [];
  for (const n of nodes || []) {
    const p = [...path, n.name];
    if (n.leaf) out.push({ id: String(n.category_id), path: p.join(" > ") });
    if (n.children) out.push(...walk(n.children, p));
  }
  return out;
}

const tenantDb = await getTenantDb("Zee_Store");
const ci = await tenantDb.collection("company_integrations").findOne({
  integration_id: "6a08607ac2091870bb5d529a",
});
const creds = await DarazIntegration.ensureAccessToken(ci.credentials);
const token = creds.access_token;

// Use category from an existing Daraz product if we can find primary_category in tree by name
const tree = await darazGet("/category/tree/get", {}, token);
const leaves = walk(tree.data);
const cat = leaves.find((l) => /jewell|fashion|women/i.test(l.path)) || leaves[0];
console.log("Category:", cat.id, cat.path);

const attrs = (await darazGet("/category/attributes/get", { primary_category_id: cat.id }, token)).data;
const productAttrs = [];
const skuAttrs = [];
for (const a of attrs) {
  const mandatory = a.is_mandatory === 1 || a.is_mandatory === true || a.is_mandatory === "1";
  if (!mandatory) continue;
  if (!a.name) continue;
  if (a.attribute_type === "sku" || a.is_sale_prop) skuAttrs.push(a);
  else productAttrs.push(a);
}

function pickVal(a) {
  const tag = a.name;
  const defaults = {
    name: "UniSell Test Product",
    name_en: "UniSell Test Product",
    description: "<p>Quality product listing from UniSell.</p>",
    description_en: "<p>Quality product listing from UniSell.</p>",
    short_description: "Quality product from UniSell",
    short_description_en: "Quality product from UniSell",
    brand: "No Brand",
    warranty_type: "No Warranty",
    color_family: "Gold",
  };
  if (defaults[tag]) return defaults[tag];
  if (a.options?.length) return a.options[0].name || a.options[0].en_name || "Other";
  return "Other";
}

const img =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/320px-PNG_transparency_demonstration_1.png";
const pXml = productAttrs.map((a) => `<${a.name}>${esc(pickVal(a))}</${a.name}>`).join("");
const sAttr = skuAttrs.map((a) => `<${a.name}>${esc(pickVal(a))}</${a.name}>`).join("");
const sku = `UNISELL-${Date.now()}`;
const xml = `<?xml version="1.0" encoding="UTF-8"?><Request><Product><PrimaryCategory>${cat.id}</PrimaryCategory><Attributes>${pXml}</Attributes><Skus><Sku><SellerSku>${sku}</SellerSku><quantity>5</quantity><price>1999</price><package_height>10</package_height><package_length>12</package_length><package_width>8</package_width><package_weight>0.2</package_weight>${sAttr}<Images><Image>${img}</Image></Images></Sku></Skus></Product></Request>`;

try {
  const r = await darazPost("/product/create", { payload: xml }, token);
  console.log("SUCCESS", JSON.stringify(r).slice(0, 500));
} catch (e) {
  console.log("FAIL", e.message);
}
