import test from "node:test";
import assert from "node:assert/strict";
import { DarazIntegration } from "./Daraz.js";

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

test("refreshes and retains Daraz credentials after an expired access token", async () => {
  const originalFetch = globalThis.fetch;
  const originalAppKey = process.env.DARAZ_APP_KEY;
  const originalAppSecret = process.env.DARAZ_APP_SECRET;
  const refreshToken = `refresh-${Date.now()}`;
  const requestedAccessTokens = [];
  process.env.DARAZ_APP_KEY = "test-app-key";
  process.env.DARAZ_APP_SECRET = "test-app-secret";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/auth/token/refresh")) {
      return jsonResponse({
        code: "0",
        data: { access_token: "new-access-token", refresh_token: "rotated-refresh-token" },
      });
    }

    requestedAccessTokens.push(url.searchParams.get("access_token"));
    if (url.searchParams.get("access_token") === "expired-access-token") {
      return jsonResponse({
        code: "IllegalAccessToken",
        message: "The specified access token is invalid or expired",
      });
    }
    return jsonResponse({ code: "0", data: { products: [], total_products: 0 } });
  };

  try {
    const credentials = {
      access_token: "expired-access-token",
      refresh_token: refreshToken,
    };
    const products = await DarazIntegration.fetchProducts(credentials);

    assert.deepEqual(products, []);
    assert.deepEqual(requestedAccessTokens, ["expired-access-token", "new-access-token"]);
    assert.equal(credentials.access_token, "new-access-token");
    assert.equal(credentials.refresh_token, "rotated-refresh-token");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAppKey === undefined) delete process.env.DARAZ_APP_KEY;
    else process.env.DARAZ_APP_KEY = originalAppKey;
    if (originalAppSecret === undefined) delete process.env.DARAZ_APP_SECRET;
    else process.env.DARAZ_APP_SECRET = originalAppSecret;
  }
});

test("reports when Daraz rejects the refreshed token and asks for reconnection", async () => {
  const originalFetch = globalThis.fetch;
  const originalAppKey = process.env.DARAZ_APP_KEY;
  const originalAppSecret = process.env.DARAZ_APP_SECRET;
  process.env.DARAZ_APP_KEY = "test-app-key";
  process.env.DARAZ_APP_SECRET = "test-app-secret";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/auth/token/refresh")) {
      return jsonResponse({
        code: "0",
        data: { access_token: "still-rejected-token", refresh_token: "rotated-refresh-token" },
      });
    }
    return jsonResponse({
      code: "IllegalAccessToken",
      message: "The specified access token is invalid or expired",
    });
  };

  try {
    await assert.rejects(
      DarazIntegration.fetchProducts({
        access_token: "expired-access-token",
        refresh_token: `refresh-rejected-${Date.now()}`,
      }),
      /Daraz rejected its refreshed access token\. Reconnect Daraz in Company Integrations\./
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAppKey === undefined) delete process.env.DARAZ_APP_KEY;
    else process.env.DARAZ_APP_KEY = originalAppKey;
    if (originalAppSecret === undefined) delete process.env.DARAZ_APP_SECRET;
    else process.env.DARAZ_APP_SECRET = originalAppSecret;
  }
});

test("asks to reconnect when an expired token has no refresh token", async () => {
  await assert.rejects(
    DarazIntegration.withRefreshedAccess(
      { access_token: "expired-access-token" },
      async () => {
        throw new Error("Daraz API error (IllegalAccessToken): expired");
      }
    ),
    /Daraz access token is invalid or expired and no refresh token is available\. Reconnect Daraz in Company Integrations\./
  );
});

test("shares an in-flight Daraz token refresh for concurrent requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalAppKey = process.env.DARAZ_APP_KEY;
  const originalAppSecret = process.env.DARAZ_APP_SECRET;
  process.env.DARAZ_APP_KEY = "test-app-key";
  process.env.DARAZ_APP_SECRET = "test-app-secret";
  let refreshRequests = 0;
  globalThis.fetch = async () => {
    refreshRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return jsonResponse({
      code: "0",
      data: { access_token: "shared-access-token", refresh_token: "shared-refresh-token" },
    });
  };

  try {
    const refreshToken = `shared-refresh-${Date.now()}`;
    const [first, second] = await Promise.all([
      DarazIntegration.refreshToken({ refresh_token: refreshToken }),
      DarazIntegration.refreshToken({ refresh_token: refreshToken }),
    ]);

    assert.equal(refreshRequests, 1);
    assert.deepEqual(first, second);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAppKey === undefined) delete process.env.DARAZ_APP_KEY;
    else process.env.DARAZ_APP_KEY = originalAppKey;
    if (originalAppSecret === undefined) delete process.env.DARAZ_APP_SECRET;
    else process.env.DARAZ_APP_SECRET = originalAppSecret;
  }
});

test("creates a Daraz listing when a Shopify product has an external ID", async () => {
  const originalCreateProduct = DarazIntegration.createProduct;
  const originalSetInventory = DarazIntegration.setInventory;
  let createdProduct;
  let inventoryUpdated = false;
  DarazIntegration.createProduct = async (_credentials, product) => {
    createdProduct = product;
    return { item_id: "daraz-item-1", sku_id: "daraz-sku-1", seller_sku: product.sku };
  };
  DarazIntegration.setInventory = async () => {
    inventoryUpdated = true;
    return { success: true };
  };

  try {
    const result = await DarazIntegration.pushProduct(
      {},
      { source: "shopify", external_id: "shopify-product-1", sku: "SKU-1" }
    );

    assert.equal(createdProduct.sku, "SKU-1");
    assert.equal(inventoryUpdated, false);
    assert.equal(result.channel_product_id, "daraz-item-1");
    assert.equal(result.created, true);
  } finally {
    DarazIntegration.createProduct = originalCreateProduct;
    DarazIntegration.setInventory = originalSetInventory;
  }
});

test("uses the product SKU when creating despite a stale Daraz SKU mapping", async () => {
  const originalCreateProduct = DarazIntegration.createProduct;
  let createdProduct;
  DarazIntegration.createProduct = async (_credentials, product) => {
    createdProduct = product;
    return { item_id: "daraz-item-2", sku_id: "daraz-sku-2", seller_sku: product.sku };
  };

  try {
    await DarazIntegration.pushProduct(
      {},
      { source: "shopify", sku: "LP789-EDP50ML" },
      { channel_seller_sku: "Other" }
    );

    assert.equal(createdProduct.sku, "LP789-EDP50ML");
  } finally {
    DarazIntegration.createProduct = originalCreateProduct;
  }
});

test("loads Daraz categories and category-specific attributes for the product form", async () => {
  const originalFetch = globalThis.fetch;
  const originalAppKey = process.env.DARAZ_APP_KEY;
  const originalAppSecret = process.env.DARAZ_APP_SECRET;
  const requestedPaths = [];
  process.env.DARAZ_APP_KEY = "test-app-key";
  process.env.DARAZ_APP_SECRET = "test-app-secret";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    if (url.pathname.endsWith("/category/tree/get")) {
      return jsonResponse({
        code: "0",
        data: [
          {
            name: "Electronics",
            children: [{ name: "Audio", category_id: "123", leaf: true }],
          },
        ],
      });
    }
    if (url.pathname.endsWith("/category/attributes/get")) {
      return jsonResponse({
        code: "0",
        data: [
          {
            name: "brand",
            label: "Brand",
            is_mandatory: 1,
            options: [{ name: "Samsung", value: "BRAND-123" }],
          },
        ],
      });
    }
    throw new Error(`Unexpected Daraz request: ${url.pathname}`);
  };

  try {
    const credentials = { access_token: "test-access-token" };
    const categories = await DarazIntegration.getCategories(credentials);
    const attributes = await DarazIntegration.getCategoryAttributes(credentials, "123");

    assert.deepEqual(categories, [{ id: "123", path: "Electronics > Audio" }]);
    assert.deepEqual(attributes, [
      {
        name: "brand",
        label: "Brand",
        is_mandatory: 1,
        options: [{ name: "Samsung", value: "BRAND-123" }],
      },
    ]);
    assert.deepEqual(
      requestedPaths.map((path) => path.slice(path.lastIndexOf("/category/"))),
      ["/category/tree/get", "/category/attributes/get"]
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAppKey === undefined) delete process.env.DARAZ_APP_KEY;
    else process.env.DARAZ_APP_KEY = originalAppKey;
    if (originalAppSecret === undefined) delete process.env.DARAZ_APP_SECRET;
    else process.env.DARAZ_APP_SECRET = originalAppSecret;
  }
});

test("resolves legacy SellerSku mappings to Daraz SkuId before updating inventory", async () => {
  const originalFetch = globalThis.fetch;
  const originalAppKey = process.env.DARAZ_APP_KEY;
  const originalAppSecret = process.env.DARAZ_APP_SECRET;
  process.env.DARAZ_APP_KEY = "test-app-key";
  process.env.DARAZ_APP_SECRET = "test-app-secret";
  let updatePayload = "";

  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/products/get")) {
      return jsonResponse({
        code: "0",
        data: {
          products: [
            {
              item_id: "item-1",
              attributes: { name: "Test product" },
              skus: [
                {
                  SellerSku: "SELLER-1",
                  SkuId: "90001",
                  ShopSku: "SHOP-1",
                  price: "12.5",
                  quantity: "3",
                },
              ],
            },
          ],
          total_products: 1,
        },
      });
    }
    if (url.pathname.endsWith("/product/price_quantity/update")) {
      updatePayload = options.body.get("payload");
      return jsonResponse({ code: "0", data: {} });
    }
    throw new Error(`Unexpected Daraz request: ${url.pathname}`);
  };

  try {
    const result = await DarazIntegration.setInventory(
      { access_token: "test-access-token" },
      {
        sellerSku: "SELLER-1",
        skuId: "SELLER-1",
        quantity: 2,
        price: 10,
      }
    );

    assert.deepEqual(result, { success: true });
    assert.match(updatePayload, /<SkuId>90001<\/SkuId>/);
    assert.doesNotMatch(updatePayload, /SellerSku/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAppKey === undefined) delete process.env.DARAZ_APP_KEY;
    else process.env.DARAZ_APP_KEY = originalAppKey;
    if (originalAppSecret === undefined) delete process.env.DARAZ_APP_SECRET;
    else process.env.DARAZ_APP_SECRET = originalAppSecret;
  }
});

test("retries inventory updates with the SkuId resolved from SellerSku after a stale ID error", async () => {
  const originalFetch = globalThis.fetch;
  const originalAppKey = process.env.DARAZ_APP_KEY;
  const originalAppSecret = process.env.DARAZ_APP_SECRET;
  process.env.DARAZ_APP_KEY = "test-app-key";
  process.env.DARAZ_APP_SECRET = "test-app-secret";
  const updateSkuIds = [];

  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/product/price_quantity/update")) {
      const payload = options.body.get("payload");
      updateSkuIds.push(payload.match(/<SkuId>(.*?)<\/SkuId>/)?.[1] || "");
      if (updateSkuIds.length === 1) {
        return jsonResponse({
          code: "E4185",
          message: "Update product failed",
        });
      }
      return jsonResponse({ code: "0", data: {} });
    }
    if (url.pathname.endsWith("/products/get")) {
      return jsonResponse({
        code: "0",
        data: {
          products: [
            {
              item_id: "item-1",
              skus: [{ SellerSku: "SELLER-1", SkuId: "90001" }],
            },
          ],
          total_products: 1,
        },
      });
    }
    throw new Error(`Unexpected Daraz request: ${url.pathname}`);
  };

  try {
    const result = await DarazIntegration.setInventory(
      { access_token: "test-access-token" },
      {
        sellerSku: "SELLER-1",
        skuId: "STALE-1",
        quantity: 2,
      }
    );

    assert.deepEqual(result, { success: true });
    assert.deepEqual(updateSkuIds, ["STALE-1", "90001"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAppKey === undefined) delete process.env.DARAZ_APP_KEY;
    else process.env.DARAZ_APP_KEY = originalAppKey;
    if (originalAppSecret === undefined) delete process.env.DARAZ_APP_SECRET;
    else process.env.DARAZ_APP_SECRET = originalAppSecret;
  }
});
