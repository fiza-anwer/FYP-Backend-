import test from "node:test";
import assert from "node:assert/strict";
import { darazPost, signRequest } from "./darazApi.js";

test("sends signed Daraz POST business parameters in a multipart form body", async () => {
  const originalFetch = globalThis.fetch;
  const originalAppKey = process.env.DARAZ_APP_KEY;
  const originalAppSecret = process.env.DARAZ_APP_SECRET;
  process.env.DARAZ_APP_KEY = "test-app-key";
  process.env.DARAZ_APP_SECRET = "test-app-secret";

  let request;
  globalThis.fetch = async (input, options) => {
    request = { url: new URL(String(input)), options };
    return { status: 200, text: async () => JSON.stringify({ code: "0", data: {} }) };
  };

  try {
    const payload = "<Request><Product /></Request>";
    await darazPost("/product/price_quantity/update", { payload }, "test-access-token");

    assert.equal(request.options.method, "POST");
    assert.ok(request.options.body instanceof FormData);
    assert.equal(request.options.body.get("payload"), payload);
    assert.equal(request.options.body.get("app_key"), null);
    assert.equal(request.url.searchParams.get("payload"), null);

    const signedParams = {
      app_key: "test-app-key",
      sign_method: "sha256",
      timestamp: request.url.searchParams.get("timestamp"),
      access_token: "test-access-token",
      payload,
    };
    assert.equal(
      request.url.searchParams.get("sign"),
      signRequest("/product/price_quantity/update", signedParams, "test-app-secret")
    );
    assert.deepEqual(
      [...request.url.searchParams.keys()].sort(),
      ["access_token", "app_key", "sign", "sign_method", "timestamp"]
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAppKey === undefined) delete process.env.DARAZ_APP_KEY;
    else process.env.DARAZ_APP_KEY = originalAppKey;
    if (originalAppSecret === undefined) delete process.env.DARAZ_APP_SECRET;
    else process.env.DARAZ_APP_SECRET = originalAppSecret;
  }
});
