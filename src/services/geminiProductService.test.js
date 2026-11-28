import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEnglishProductName } from "./geminiProductService.js";

test("normalizes the suggested English product name", () => {
  assert.equal(
    normalizeEnglishProductName({ title: "  Classic   Cotton Shirt  " }),
    "Classic Cotton Shirt"
  );
});

test("rejects an empty or non-English suggestion", () => {
  assert.throws(() => normalizeEnglishProductName({ title: "" }), /did not return an English/);
  assert.throws(() => normalizeEnglishProductName({ title: "خوبصورت قمیض" }), /not in English/);
});
