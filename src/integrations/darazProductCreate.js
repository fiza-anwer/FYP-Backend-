import { darazGet, darazPost } from "./darazApi.js";

function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isMandatory(attr) {
  return attr?.is_mandatory === 1 || attr?.is_mandatory === true || attr?.is_mandatory === "1";
}

function walkCategoryTree(nodes, path = []) {
  const out = [];
  for (const n of nodes || []) {
    const p = [...path, n.name];
    if (n.leaf) out.push({ id: String(n.category_id), path: p.join(" > ") });
    if (n.children?.length) out.push(...walkCategoryTree(n.children, p));
  }
  return out;
}

let categoryTreeCache = { at: 0, leaves: null };

async function getCategoryLeaves(accessToken) {
  const now = Date.now();
  if (categoryTreeCache.leaves && now - categoryTreeCache.at < 60 * 60 * 1000) {
    return categoryTreeCache.leaves;
  }
  const json = await darazGet("/category/tree/get", {}, accessToken);
  const leaves = walkCategoryTree(json.data);
  categoryTreeCache = { at: now, leaves };
  return leaves;
}

/**
 * Resolve Daraz PrimaryCategory id from product_type, env default, or fallback leaf.
 */
export async function resolveDarazCategoryId(accessToken, productType = "") {
  const envDefault = (process.env.DARAZ_DEFAULT_CATEGORY_ID || "").trim();
  if (envDefault) return envDefault;

  const leaves = await getCategoryLeaves(accessToken);
  const type = String(productType || "").trim().toLowerCase();
  if (type) {
    const words = type.split(/[\s,/>|-]+/).filter((w) => w.length > 2);
    let best = null;
    let bestScore = 0;
    for (const leaf of leaves) {
      const pathLower = leaf.path.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (pathLower.includes(w)) score += w.length;
      }
      if (score > bestScore) {
        bestScore = score;
        best = leaf;
      }
    }
    if (best && bestScore > 0) return best.id;
  }

  const typeHint = String(productType || "").toLowerCase();
  if (/jewell|ring|necklace|earring|locket|bracelet/i.test(typeHint)) {
    const jewellery = leaves.find((l) => /jewell/i.test(l.path));
    if (jewellery) return jewellery.id;
  }
  if (/shirt|tee|apparel|clothing|fashion/i.test(typeHint)) {
    const apparel = leaves.find((l) => /fashion|clothing|apparel|wear/i.test(l.path));
    if (apparel) return apparel.id;
  }
  const fashion =
    leaves.find((l) => /fashion|jewell|accessories|women.*wear/i.test(l.path)) ||
    leaves.find((l) => /mobile accessories/i.test(l.path));
  return fashion?.id || leaves[0]?.id || "";
}

export async function fetchCategoryAttributes(accessToken, categoryId) {
  const json = await darazGet(
    "/category/attributes/get",
    { primary_category_id: String(categoryId) },
    accessToken
  );
  const data = json.data;
  return Array.isArray(data) ? data : data?.attributes || [];
}

function pickAttributeValue(attr, product) {
  const tag = attr.name;
  const title = String(product.title || "").trim() || "Product";
  const desc =
    String(product.description || product.meta_description || "").trim() ||
    `<p>${title}</p>`;
  const shortDesc = desc.replace(/<[^>]+>/g, " ").trim().slice(0, 500) || title;
  const brand = String(product.vendor || product.brand || "").trim() || "No Brand";

  const byName = {
    name: title.slice(0, 255),
    name_en: title.slice(0, 255),
    title: title.slice(0, 255),
    description: desc.slice(0, 25000),
    description_en: desc.slice(0, 25000),
    short_description: shortDesc.slice(0, 2500),
    short_description_en: shortDesc.slice(0, 2500),
    brand,
    warranty_type: "No Warranty",
    warranty: "No Warranty",
    color_family: "Multicolor",
    Hazmat: "None",
    delivery_option_sof: "No",
  };

  if (byName[tag]) return byName[tag];

  if (Array.isArray(attr.options) && attr.options.length > 0) {
    const opt = attr.options.find(
      (o) =>
        String(o.name || o.en_name || "")
          .toLowerCase()
          .includes(brand.toLowerCase()) && brand.toLowerCase() !== "no brand"
    );
    return opt?.name || opt?.en_name || attr.options[0].name || attr.options[0].en_name || "Other";
  }

  if (attr.input_type === "numeric" || attr.input_type === "number") return "1";
  return "Other";
}

function productImages(product) {
  const urls = [];
  if (Array.isArray(product.images)) {
    for (const img of product.images) {
      const u = typeof img === "string" ? img.trim() : img?.src?.trim?.() || img?.url?.trim?.() || "";
      if (u && /^https?:\/\//i.test(u)) urls.push(u);
    }
  }
  return urls;
}

function isDarazCdnUrl(url) {
  return /slatic\.net/i.test(String(url || ""));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Migrate external image URLs to Daraz/Lazada CDN (required for new listings).
 */
export async function migrateDarazImageUrls(accessToken, urls) {
  const list = (Array.isArray(urls) ? urls : []).map((u) => String(u || "").trim()).filter(Boolean);
  if (list.length === 0) return [];

  const alreadyOnCdn = list.filter(isDarazCdnUrl);
  const external = list.filter((u) => !isDarazCdnUrl(u));
  if (external.length === 0) return alreadyOnCdn;

  const urlNodes = external.map((u) => `<Url>${escapeXml(u)}</Url>`).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Request><Images>${urlNodes}</Images></Request>`;
  const json = await darazPost("/images/migrate", { payload: xml }, accessToken);
  const batchId = json.batch_id || json.data?.batch_id;
  if (!batchId) {
    throw new Error("Daraz image migrate did not return batch_id");
  }

  const migrated = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    await sleep(attempt === 0 ? 600 : 1000);
    try {
      const poll = await darazGet("/image/response/get", { batch_id: batchId }, accessToken);
      const images = poll?.data?.images;
      if (Array.isArray(images)) {
        for (const img of images) {
          if (img?.url) migrated.push(String(img.url));
        }
      }
      if (migrated.length >= external.length) break;
    } catch (err) {
      if (attempt >= 11) throw err;
    }
  }

  if (migrated.length === 0) {
    throw new Error(
      "Daraz could not import product images. Use public HTTPS links (JPG/PNG, at least 330×330px)."
    );
  }

  return [...alreadyOnCdn, ...migrated];
}

/**
 * Build XML payload for POST /product/create
 */
export function buildDarazCreateProductXml(product, categoryId, attributes) {
  const productAttrs = [];
  const skuAttrs = [];
  for (const a of attributes) {
    if (!a?.name) continue;
    if (!isMandatory(a) && a.name !== "description") continue;
    if (a.attribute_type === "sku" || a.is_sale_prop === 1 || a.is_sale_prop === true) {
      skuAttrs.push(a);
    } else {
      productAttrs.push(a);
    }
  }

  const title = String(product.title || "").trim() || "Product";
  const ensureNames = ["name", "name_en"];
  for (const n of ensureNames) {
    if (!productAttrs.some((a) => a.name === n)) {
      productAttrs.unshift({ name: n, input_type: "text" });
    }
  }

  const pXml = productAttrs
    .map((a) => `<${a.name}>${escapeXml(pickAttributeValue(a, product))}</${a.name}>`)
    .join("");

  const sAttr = skuAttrs
    .map((a) => `<${a.name}>${escapeXml(pickAttributeValue(a, product))}</${a.name}>`)
    .join("");

  const sellerSku = String(product.sku || product.variants?.[0]?.sku || "").trim();
  if (!sellerSku) throw new Error("SKU is required to create a product on Daraz");

  const qty =
    typeof product.inventory_quantity === "number"
      ? Math.max(0, Math.floor(product.inventory_quantity))
      : typeof product.quantity === "number"
        ? Math.max(0, Math.floor(product.quantity))
        : 1;

  const priceRaw = product.price ?? product.variants?.[0]?.price;
  const price = priceRaw != null && !Number.isNaN(Number(priceRaw)) ? Number(priceRaw) : 1;

  const imgs = productImages(product);
  const imagesXml = imgs.map((u) => `<Image>${escapeXml(u)}</Image>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?><Request><Product><PrimaryCategory>${escapeXml(
    categoryId
  )}</PrimaryCategory><Attributes>${pXml}</Attributes><Skus><Sku><SellerSku>${escapeXml(
    sellerSku
  )}</SellerSku><quantity>${qty}</quantity><price>${price}</price><package_height>10</package_height><package_length>12</package_length><package_width>8</package_width><package_weight>0.2</package_weight>${sAttr}<Images>${imagesXml}</Images></Sku></Skus></Product></Request>`;
}

/**
 * Create a new product listing on Daraz.
 * @returns {{ item_id: string, sku_id?: string, seller_sku: string }}
 */
export async function createDarazProduct(accessToken, product) {
  const categoryId = await resolveDarazCategoryId(accessToken, product.product_type);
  if (!categoryId) {
    throw new Error(
      "Could not resolve Daraz category. Set DARAZ_DEFAULT_CATEGORY_ID in .env or set product type."
    );
  }

  const rawImages = productImages(product);
  if (rawImages.length === 0) {
    throw new Error(
      "At least one public image URL (https://…) is required to list a new product on Daraz"
    );
  }
  const darazImages = await migrateDarazImageUrls(accessToken, rawImages);
  const productForXml = { ...product, images: darazImages };

  const attributes = await fetchCategoryAttributes(accessToken, categoryId);
  const xml = buildDarazCreateProductXml(productForXml, categoryId, attributes);
  const json = await darazPost("/product/create", { payload: xml }, accessToken);
  const data = json.data || json;

  const sellerSku = String(product.sku || product.variants?.[0]?.sku || "").trim();
  let itemId =
    data?.item_id != null
      ? String(data.item_id)
      : data?.product_id != null
        ? String(data.product_id)
        : "";

  const skuList = data?.sku_list || data?.skus || [];
  const firstSku = Array.isArray(skuList) ? skuList[0] : null;
  const skuId =
    firstSku?.sku_id != null
      ? String(firstSku.sku_id)
      : firstSku?.SkuId != null
        ? String(firstSku.SkuId)
        : data?.sku_id != null
          ? String(data.sku_id)
          : "";

  if (!itemId && data?.detail) {
    const detail = Array.isArray(data.detail) ? data.detail[0] : data.detail;
    itemId = detail?.item_id != null ? String(detail.item_id) : "";
  }

  return {
    item_id: itemId,
    sku_id: skuId,
    seller_sku: sellerSku,
    primary_category_id: categoryId,
  };
}
