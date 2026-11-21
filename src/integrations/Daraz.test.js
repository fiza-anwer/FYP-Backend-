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
