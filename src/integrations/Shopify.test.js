import test from "node:test";
import assert from "node:assert/strict";
import { ShopifyIntegration } from "./Shopify.js";

test("updates mapped Shopify variants by saved IDs without replacing channel SKUs", async () => {
  const originalFetch = globalThis.fetch;
  let updateBody;
  globalThis.fetch = async (url, options) => {
    if (options.method === "GET") {
      return {
        ok: true,
        json: async () => ({
          product: {
            variants: [
              { id: 22, sku: "US-B", option1: "Blue" },
              { id: 11, sku: "US-A", option1: "Red" },
            ],
          },
        }),
      };
    }

    updateBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ product: { id: 100 } }),
    };
  };

  try {
    await ShopifyIntegration.updateProduct(
      { shop_domain: "example.myshopify.com", access_token: "test-token" },
      "100",
      {
        title: "Updated product",
        variants: [
          { sku: "INTERNAL-B", option1: "Blue Updated" },
          { sku: "INTERNAL-A", option1: "Red Updated" },
        ],
      },
      {
        channel_variants: [
          {
            internal_sku: "INTERNAL-A",
            channel_sku: "US-A",
            channel_variant_id: "11",
          },
          {
            internal_sku: "INTERNAL-B",
            channel_sku: "US-B",
            channel_variant_id: "22",
          },
        ],
      }
    );

    assert.deepEqual(updateBody.product.variants, [
      { id: 22, option1: "Blue Updated" },
      { id: 11, option1: "Red Updated" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
