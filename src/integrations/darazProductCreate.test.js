import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDarazCreateProductXml,
  resolveDarazCategoryId,
} from "./darazProductCreate.js";

test("omits a category size-chart attribute instead of requiring a chart URL", () => {
  const xml = buildDarazCreateProductXml(
    {
      title: "Test shirt",
      sku: "TSH-001",
    },
    "123",
    [{ name: "size_chart", is_mandatory: 1 }]
  );

  assert.doesNotMatch(xml, /size_chart/i);
});

test("uses the seller SKU for the Daraz outer ID attribute", () => {
  const xml = buildDarazCreateProductXml(
    { title: "Test shirt", sku: "TSH-001", daraz_attributes: { outer_id: "Other" } },
    "123",
    [
      {
        name: "outer_id",
        label: "Outer ID",
        attribute_type: "sku",
        is_mandatory: 1,
        options: [{ name: "Other" }],
      },
    ]
  );

  assert.match(xml, /<outer_id>TSH-001<\/outer_id>/);
  assert.doesNotMatch(xml, /<outer_id>Other<\/outer_id>/);
});

test("uses selected Daraz category attribute values instead of generic defaults", () => {
  const xml = buildDarazCreateProductXml(
    {
      title: "Test accessory",
      sku: "ACC-003",
      daraz_attributes: { brand: "Acme", color_family: "Red" },
    },
    "123",
    [
      { name: "brand", label: "Brand", is_mandatory: 1, options: [{ name: "Acme" }] },
      { name: "color_family", label: "Color Family", is_mandatory: 1 },
    ]
  );

  assert.match(xml, /<brand>Acme<\/brand>/);
  assert.match(xml, /<color_family>Red<\/color_family>/);
});

test("uses the Daraz enum value rather than its display label in the create payload", () => {
  const xml = buildDarazCreateProductXml(
    {
      title: "Test phone",
      sku: "PHONE-001",
      daraz_attributes: { brand: "BRAND-123" },
    },
    "123",
    [
      {
        name: "brand",
        label: "Brand",
        is_mandatory: 1,
        options: [{ name: "Samsung", value: "BRAND-123" }],
      },
    ]
  );

  assert.match(xml, /<brand>BRAND-123<\/brand>/);
  assert.doesNotMatch(xml, /<brand>Samsung<\/brand>/);
});

test("rejects a Daraz enum value not present in the selected category metadata", () => {
  assert.throws(
    () =>
      buildDarazCreateProductXml(
        {
          title: "Test phone",
          sku: "PHONE-002",
          daraz_attributes: { brand: "Unknown brand" },
        },
        "123",
        [
          {
            name: "brand",
            label: "Brand",
            is_mandatory: 1,
            options: [{ name: "Samsung", value: "BRAND-123" }],
          },
        ]
      ),
    /must use one of the options returned/
  );
});

test("includes the outer ID when Daraz does not mark the attribute mandatory", () => {
  const xml = buildDarazCreateProductXml(
    { title: "Test accessory", sku: "ACC-002" },
    "123",
    [
      {
        name: "outer_id",
        label: "Outer ID",
        attribute_type: "sku",
        is_mandatory: 0,
        options: [{ name: "Other" }],
      },
    ]
  );

  assert.match(xml, /<outer_id>ACC-002<\/outer_id>/);
  assert.doesNotMatch(xml, /<outer_id>Other<\/outer_id>/);
});

test("uses the seller SKU when Daraz exposes Outer ID as an English attribute label", () => {
  const xml = buildDarazCreateProductXml(
    { title: "Test accessory", sku: "ACC-001" },
    "123",
    [
      {
        name: "p-20000",
        en_name: "Outer ID",
        attribute_type: "sku",
        is_mandatory: 1,
        options: [{ name: "Other" }],
      },
    ]
  );

  assert.match(xml, /<p-20000>ACC-001<\/p-20000>/);
  assert.doesNotMatch(xml, /<p-20000>Other<\/p-20000>/);
});

test("resolves product categories before the configured default category", async () => {
  const originalFetch = globalThis.fetch;
  const originalAppKey = process.env.DARAZ_APP_KEY;
  const originalAppSecret = process.env.DARAZ_APP_SECRET;
  const originalDefaultCategory = process.env.DARAZ_DEFAULT_CATEGORY_ID;
  process.env.DARAZ_APP_KEY = "test-app-key";
  process.env.DARAZ_APP_SECRET = "test-app-secret";
  process.env.DARAZ_DEFAULT_CATEGORY_ID = "999";
  globalThis.fetch = async () => ({
    status: 200,
    text: async () =>
      JSON.stringify({
        code: "0",
        data: [
          { name: "Clothing", category_id: "999", leaf: true },
          {
            name: "Health & Beauty",
            children: [
              { name: "Fragrances", category_id: "123", leaf: true },
            ],
          },
        ],
      }),
  });

  try {
    assert.equal(
      await resolveDarazCategoryId("test-access-token", "Health & Beauty > Fragrances"),
      "123"
    );
    assert.equal(await resolveDarazCategoryId("test-access-token", "Attar"), "123");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAppKey === undefined) delete process.env.DARAZ_APP_KEY;
    else process.env.DARAZ_APP_KEY = originalAppKey;
    if (originalAppSecret === undefined) delete process.env.DARAZ_APP_SECRET;
    else process.env.DARAZ_APP_SECRET = originalAppSecret;
    if (originalDefaultCategory === undefined) delete process.env.DARAZ_DEFAULT_CATEGORY_ID;
    else process.env.DARAZ_DEFAULT_CATEGORY_ID = originalDefaultCategory;
  }
});
