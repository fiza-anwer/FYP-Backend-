import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProductIntegrationScope,
  shouldSyncProductToPlatform,
} from "./productIntegrationScope.js";

test("selected platform scope only allows the selected platforms", () => {
  const product = { integration_scope: "selected", integration_slugs: ["shopify"] };
  assert.equal(shouldSyncProductToPlatform(product, "shopify"), true);
  assert.equal(shouldSyncProductToPlatform(product, "daraz"), false);
});

test("selected scope with no platforms does not publish to any channel", () => {
  const product = { integration_scope: "selected", integration_slugs: [] };
  assert.equal(shouldSyncProductToPlatform(product, "shopify"), false);
  assert.equal(shouldSyncProductToPlatform(product, "daraz"), false);
});

test("both selected platforms are allowed and legacy products retain all-platform behavior", () => {
  const both = { integration_scope: "selected", integration_slugs: ["shopify", "daraz"] };
  const legacy = { integration_slugs: [] };
  assert.equal(shouldSyncProductToPlatform(both, "shopify"), true);
  assert.equal(shouldSyncProductToPlatform(both, "daraz"), true);
  assert.equal(shouldSyncProductToPlatform(legacy, "shopify"), true);
  assert.equal(shouldSyncProductToPlatform(legacy, "daraz"), true);
  assert.equal(normalizeProductIntegrationScope(undefined, ["daraz"]), "selected");
});
