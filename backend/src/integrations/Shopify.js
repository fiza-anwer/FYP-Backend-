/**
 * Shopify integration: fetch orders from store via Admin API.
 * credentials: { shop_domain, access_token } or { shop, x_shopify_token } etc.
 * Shop domain should be e.g. "your-store.myshopify.com" (without https).
 */
const SHOPIFY_API_VERSION = "2024-04";

/**
 * Run a GraphQL request against Shopify Admin API.
 */
async function shopifyGraphQL(shop_domain, access_token, query, variables = {}) {
  const url = `https://${shop_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": access_token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL error ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

/**
 * Build search-term variants so we can match Shopify taxonomy (e.g. "Laptop" -> "Laptops", "jewellery" -> "Jewellery").
 */
function categorySearchVariants(productTypeStr) {
  const s = String(productTypeStr).trim();
  if (!s) return [];
  const lower = s.toLowerCase();
  const variants = [s];
  if (!lower.endsWith("s") && s.length > 1) variants.push(s + "s");
  if (lower.endsWith("s") && s.length > 2) variants.push(s.slice(0, -1));
  if (s.charAt(0) !== s.charAt(0).toUpperCase()) variants.push(s.charAt(0).toUpperCase() + s.slice(1));
  if (lower === "jewellery") variants.push("Jewelry");
  if (lower === "jewelry") variants.push("Jewellery");
  return [...new Set(variants)];
}

/**
 * Set product's Standard Product Category (taxonomy) so it shows in Shopify's "Category" column.
 * Searches taxonomy by product type (e.g. "jewellery", "Laptops") and assigns the first matching category.
 * Tries multiple search variants and both mutation field names (category vs productCategory).
 */
async function setProductCategoryViaGraphQL(shop_domain, access_token, shopifyProductId, productTypeStr) {
  const searchQuery = `
    query taxonomySearch($query: String!) {
      taxonomy {
        categories(search: $query, first: 10) {
          nodes {
            id
            name
            fullName
          }
        }
      }
    }
  `;
  const searchVariants = categorySearchVariants(productTypeStr);
  // Also try first word only (e.g. "T-Shirts" -> "Shirts", "T") and without hyphen
  const trimmed = String(productTypeStr).trim();
  if (trimmed.includes("-")) searchVariants.push(trimmed.replace(/-/g, " "));
  if (trimmed.includes(" ")) {
    const firstWord = trimmed.split(/\s+/)[0];
    if (firstWord && firstWord.length > 1) searchVariants.push(firstWord);
  }
  let nodes = [];
  for (const query of [...new Set(searchVariants)]) {
    const data = await shopifyGraphQL(shop_domain, access_token, searchQuery, { query });
    nodes = data?.taxonomy?.categories?.nodes ?? [];
    if (nodes.length > 0) break;
  }
  // If search still empty, try fetching top-level categories and match by name
  if (nodes.length === 0) {
    const topLevelQuery = `
      query taxonomyTopLevel {
        taxonomy {
          categories(first: 100) {
            nodes { id name fullName }
          }
        }
      }
    `;
    const topData = await shopifyGraphQL(shop_domain, access_token, topLevelQuery, {});
    const allNodes = topData?.taxonomy?.categories?.nodes ?? [];
    const lower = trimmed.toLowerCase();
    const match = allNodes.find(
      (n) => n?.name && (n.name.toLowerCase() === lower || n.name.toLowerCase().includes(lower) || lower.includes(n.name.toLowerCase()))
    );
    if (match) nodes = [match];
  }
  const categoryNode = nodes[0];
  if (!categoryNode?.id) {
    console.warn("[Shopify] No taxonomy category found for product type:", productTypeStr, "(tried:", searchVariants.join(", ") + ")");
    throw new Error(`No matching Shopify category for "${productTypeStr}". Try a standard name like Laptops, Jewellery, Trousers, or T-Shirts.`);
  }
  const productGid = `gid://shopify/Product/${shopifyProductId}`;
  const categoryId = categoryNode.id;

  const tryUpdate = async (input) => {
    const updateMutation = `
      mutation productUpdateCategory($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id }
          userErrors { field message }
        }
      }
    `;
    const updateData = await shopifyGraphQL(shop_domain, access_token, updateMutation, { input });
    const errors = updateData?.productUpdate?.userErrors ?? [];
    if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
  };

  try {
    await tryUpdate({ id: productGid, productCategory: { productTaxonomyNodeId: categoryId } });
  } catch (e1) {
    try {
      await tryUpdate({ id: productGid, category: categoryId });
    } catch (e2) {
      throw new Error(e1.message || e2.message);
    }
  }
}

/** Normalize credentials so we accept various keys used in UI/DB (access_token, x-shopify-token, shop_domain, shop, etc.). */
function normalizeShopifyCredentials(credentials) {
  if (!credentials || typeof credentials !== "object") {
    return { shop_domain: "", access_token: "" };
  }
  const shop_domain = (
    credentials.shop_domain ??
    credentials.shop ??
    credentials.store_url ??
    credentials.store ??
    ""
  )
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const access_token = (
    credentials.access_token ??
    credentials.x_shopify_token ??
    credentials["x-shopify-token"] ??
    credentials.token ??
    ""
  ).trim();
  return { shop_domain, access_token };
}

export class ShopifyIntegration {
  static slug = "shopify";

  /**
   * Fetch orders from Shopify store. Returns array of normalized order objects.
   * @param {Object} credentials - { shop_domain, access_token } or { shop, x_shopify_token } etc.
   * @returns {Promise<Array<{ external_id: string, order_number: string|number, email: string, total: number, financial_status: string, fulfillment_status: string, raw: object }>>}
   */
  static async fetchOrders(credentials) {
    const { shop_domain, access_token } = normalizeShopifyCredentials(credentials);
    if (!shop_domain || !access_token) {
      throw new Error("Shopify credentials missing: need shop_domain (or shop) and access_token (or x-shopify-token)");
    }
    const url = `https://${shop_domain}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&limit=250`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": access_token,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify API error ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const orders = data.orders || [];
    return orders.map((o) => ({
      external_id: String(o.id),
      order_number: o.order_number || o.name || o.id,
      email: o.email || "",
      total: parseFloat(o.total_price) || 0,
      financial_status: o.financial_status || "",
      fulfillment_status: o.fulfillment_status || "unfulfilled",
      raw: o,
      source: "shopify",
    }));
  }

  /**
   * Fetch products from Shopify store. Returns array of normalized product objects.
   * @param {Object} credentials - { shop_domain, access_token } or similar.
   * @returns {Promise<Array<{ external_id: string, title: string, sku?: string, price?: number, product_type?: string, status?: string, source?: string, raw: object, variants?: Array<{ id: string, sku?: string, title?: string, price?: number, inventory_quantity?: number }> }>>}
   */
  static async fetchProducts(credentials) {
    const { shop_domain, access_token } = normalizeShopifyCredentials(credentials);
    if (!shop_domain || !access_token) {
      throw new Error(
        "Shopify credentials missing: need shop_domain (or shop) and access_token (or x-shopify-token)"
      );
    }
    const url = `https://${shop_domain}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": access_token,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify products API error ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const products = data.products || [];
    return products.map((p) => {
      const variants = Array.isArray(p.variants) ? p.variants : [];
      const first = variants[0] || {};
      return {
        external_id: String(p.id),
        title: p.title || "",
        sku: first.sku || "",
        price: first.price ? parseFloat(first.price) || 0 : undefined,
        product_type: p.product_type || "",
        status: p.status || "active",
        source: "shopify",
        raw: p,
        variants: variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          title: v.title,
          price: v.price ? parseFloat(v.price) || 0 : undefined,
          inventory_quantity: v.inventory_quantity,
        })),
      };
    });
  }

  /**
   * Create a product in the Shopify store.
   * @param {Object} credentials - { shop_domain, access_token }
   * @param {Object} product - { title, description?, product_type?, status?, variants: [{ price, sku?, title? }] }
   * @returns {Promise<{ external_id: string, raw?: object }>}
   */
  static async createProduct(credentials, product) {
    const { shop_domain, access_token } = normalizeShopifyCredentials(credentials);
    if (!shop_domain || !access_token) {
      throw new Error(
        "Shopify credentials missing: need shop_domain (or shop) and access_token (or x-shopify-token)"
      );
    }
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const compareAtPrice = product.price_old != null ? Number(product.price_old) : null;
    const shopifyVariants =
      variants.length > 0
        ? variants.map((v) => {
            const price = typeof v?.price === "number" ? v.price : v?.price != null ? Number(v.price) : 0;
            const vCompare = v?.price_old != null ? Number(v.price_old) : compareAtPrice;
            return {
              title: v?.title && String(v.title).trim() ? String(v.title).trim() : v?.option1 || "Default Title",
              price: String(price),
              compare_at_price: vCompare != null ? String(vCompare) : undefined,
              sku: v?.sku && String(v.sku).trim() ? String(v.sku).trim() : undefined,
              option1: v?.option1 && String(v.option1).trim() ? String(v.option1).trim() : undefined,
              option2: v?.option2 && String(v.option2).trim() ? String(v.option2).trim() : undefined,
            };
          })
        : [{
            title: "Default Title",
            price: String(product.price != null ? Number(product.price) : 0),
            compare_at_price: compareAtPrice != null ? String(compareAtPrice) : undefined,
            sku: product.sku && String(product.sku).trim() ? String(product.sku).trim() : undefined,
          }];

    const productTypeStr =
      product.product_type && String(product.product_type).trim() ? String(product.product_type).trim() : "";
    const tagsStr = product.tags && Array.isArray(product.tags)
      ? product.tags.filter((t) => t && String(t).trim()).join(", ")
      : productTypeStr
        ? productTypeStr
        : "";
    const images = Array.isArray(product.images) ? product.images : [];
    const shopifyImages = images
      .filter((src) => src && String(src).trim())
      .map((src) => ({ src: String(src).trim() }));

    const body = {
      product: {
        title: product.title || "Unnamed Product",
        body_html: product.description && String(product.description).trim() ? String(product.description).trim() : "",
        status: product.status === "draft" || product.status === "archived" ? product.status : "active",
        variants: shopifyVariants,
      },
    };
    if (productTypeStr) body.product.product_type = productTypeStr;
    if (product.handle && String(product.handle).trim()) body.product.handle = String(product.handle).trim();
    if (tagsStr) body.product.tags = tagsStr;
    if (product.vendor && String(product.vendor).trim()) body.product.vendor = String(product.vendor).trim();
    if (shopifyImages.length > 0) body.product.images = shopifyImages;
    if (product.sizes && product.sizes.length > 0) {
      body.product.options = [{ name: "Size", values: product.sizes }];
    }

    const url = `https://${shop_domain}/admin/api/${SHOPIFY_API_VERSION}/products.json`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": access_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify create product error ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const created = data.product;
    if (!created || !created.id) {
      throw new Error("Shopify did not return the created product");
    }
    let categoryWarning = null;
    if (productTypeStr) {
      try {
        await setProductCategoryViaGraphQL(shop_domain, access_token, String(created.id), productTypeStr);
      } catch (err) {
        console.warn("[Shopify] Set product category (GraphQL) failed:", err.message);
        categoryWarning = err.message || "Category could not be set in Shopify.";
      }
    }
    return { external_id: String(created.id), raw: created, categoryWarning };
  }

  /**
   * Create a fulfillment for an order with tracking (dispatch to channel).
   * @param {Object} credentials - { shop_domain: string, access_token: string }
   * @param {string} shopifyOrderId - Shopify order id (external_id)
   * @param {string} trackingNumber - Tracking number
   * @param {string} [trackingUrl] - Optional tracking URL
   * @returns {Promise<{ success: boolean, fulfillment_id?: string }>}
   */
  static async fulfillOrder(credentials, shopifyOrderId, trackingNumber, trackingUrl) {
    const { shop_domain, access_token } = normalizeShopifyCredentials(credentials);
    if (!shop_domain || !access_token) {
      throw new Error("Shopify credentials missing: need shop_domain (or shop) and access_token (or x-shopify-token). Check the company integration has the correct Shopify token.");
    }
    if (!shopifyOrderId || !trackingNumber) {
      throw new Error("shopifyOrderId and trackingNumber are required");
    }

    const base = `https://${shop_domain}/admin/api/${SHOPIFY_API_VERSION}`;
    const headers = {
      "X-Shopify-Access-Token": access_token,
      "Content-Type": "application/json",
    };

    // Get fulfillment orders for this order
    const forRes = await fetch(
      `${base}/orders/${shopifyOrderId}/fulfillment_orders.json`,
      { method: "GET", headers }
    );
    if (!forRes.ok) {
      const text = await forRes.text();
      throw new Error(`Shopify fulfillment_orders error ${forRes.status}: ${text.slice(0, 300)}`);
    }
    const forData = await forRes.json();
    const fulfillmentOrders = forData.fulfillment_orders || [];
    const toFulfill = fulfillmentOrders.filter((fo) => fo.status === "open" || fo.status === "scheduled");
    if (toFulfill.length === 0) {
      const statuses = [...new Set(fulfillmentOrders.map((fo) => fo.status).filter(Boolean))];
      if (statuses.length > 0) {
        if (statuses.every((s) => s === "closed" || s === "cancelled")) {
          throw new Error("This order is already fulfilled or cancelled in Shopify. No open fulfillment to update.");
        }
        throw new Error(`Shopify has no open fulfillment for this order (statuses: ${statuses.join(", ")}). It may already be fulfilled.`);
      }
      throw new Error("Shopify returned no fulfillment orders. The order may be a draft, cancelled, or already fulfilled in your store.");
    }

    const fo = toFulfill[0];
    const lineItems = (fo.line_items || [])
      .map((li) => {
        const qty = Math.max(1, parseInt(li.fulfillable_quantity ?? li.quantity ?? 1, 10) || 1);
        return { id: li.id, quantity: qty };
      })
      .filter((li) => li.quantity > 0);
    if (lineItems.length === 0) {
      throw new Error("No fulfillable line items in this fulfillment order");
    }

    const payload = {
      fulfillment: {
        line_items_by_fulfillment_order: [
          { fulfillment_order_id: fo.id, fulfillment_order_line_items: lineItems },
        ],
        tracking_info: {
          number: trackingNumber,
          company: "DHL",
          ...(trackingUrl && { url: trackingUrl }),
        },
        notify_customer: true,
      },
    };

    const createRes = await fetch(`${base}/fulfillments.json`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`Shopify create fulfillment error ${createRes.status}: ${text.slice(0, 300)}`);
    }
    const createData = await createRes.json();
    return { success: true, fulfillment_id: createData.fulfillment?.id };
  }
}
