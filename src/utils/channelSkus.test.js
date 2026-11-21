import test from "node:test";
import assert from "node:assert/strict";
import { generateShopifyChannelSku, withShopifyChannelSkus } from "./channelSkus.js";

test("generates stable, distinct Shopify SKUs without changing internal SKUs", () => {
  const productId = "6a1234567890abcdef123456";
  const first = generateShopifyChannelSku(productId, "shirt / navy", 0);
  const repeated = generateShopifyChannelSku(productId, "shirt / navy", 0);
  const secondVariant = generateShopifyChannelSku(productId, "shirt / navy", 1);

  assert.equal(first, repeated);
  assert.notEqual(first, secondVariant);
  assert.match(first, /^US-SH-SHIRT-NAVY-/);
  assert.ok(first.length <= 100);

  const channelProduct = withShopifyChannelSkus({
    sku: "INTERNAL-1",
    variants: [{ sku: "INTERNAL-1-BLUE" }],
  }, productId);
  assert.equal(channelProduct.variants[0].internal_sku, "INTERNAL-1-BLUE");
  assert.notEqual(channelProduct.variants[0].sku, channelProduct.variants[0].internal_sku);
});
