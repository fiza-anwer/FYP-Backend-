import test from "node:test";
import assert from "node:assert/strict";
import { withShopifyChannelSkus } from "./channelSkus.js";

test("uses the product SKU unchanged for the Shopify variant", () => {
  const channelProduct = withShopifyChannelSkus({
    sku: "INTERNAL-1",
    variants: [{ sku: "INTERNAL-1-BLUE" }],
  });
  assert.equal(channelProduct.variants[0].internal_sku, "INTERNAL-1-BLUE");
  assert.equal(channelProduct.variants[0].sku, channelProduct.variants[0].internal_sku);
});

test("uses the product SKU unchanged when Shopify has no variants", () => {
  const channelProduct = withShopifyChannelSkus({ sku: "LP789-EDP50ML" });

  assert.equal(channelProduct.internal_sku, "LP789-EDP50ML");
  assert.equal(channelProduct.sku, "LP789-EDP50ML");
});
