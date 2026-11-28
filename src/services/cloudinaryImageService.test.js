import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createHash } from "node:crypto";
import { uploadProductImage } from "./cloudinaryImageService.js";

const originalFetch = globalThis.fetch;
const originalEnv = {
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("uploads a validated image using a signed Cloudinary request", async () => {
  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
  process.env.CLOUDINARY_API_KEY = "test-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  let requestUrl;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestBody = options.body;
    return {
      ok: true,
      json: async () => ({ secure_url: "https://res.cloudinary.com/test-cloud/image/upload/product.png" }),
    };
  };

  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const dataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;
  const imageUrl = await uploadProductImage(dataUrl);
  const timestamp = requestBody.get("timestamp");
  const expectedSignature = createHash("sha1")
    .update(`folder=unisell/products&timestamp=${timestamp}test-secret`)
    .digest("hex");

  assert.equal(imageUrl, "https://res.cloudinary.com/test-cloud/image/upload/product.png");
  assert.equal(requestUrl, "https://api.cloudinary.com/v1_1/test-cloud/image/upload");
  assert.equal(requestBody.get("api_key"), "test-key");
  assert.equal(requestBody.get("signature"), expectedSignature);
  assert.equal(requestBody.get("folder"), "unisell/products");
});

test("rejects data that is not a supported image", async () => {
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("Fetch should not run for invalid image data");
  };

  await assert.rejects(
    uploadProductImage("data:image/png;base64,SGVsbG8="),
    { message: "The selected file is not a valid PNG, JPEG, or WebP image.", status: 400 }
  );
  assert.equal(fetchCalled, false);
});

test("detects the actual format when the declared MIME type differs", async () => {
  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
  process.env.CLOUDINARY_API_KEY = "test-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  let uploadedFile;
  globalThis.fetch = async (_url, options) => {
    uploadedFile = options.body.get("file");
    return {
      ok: true,
      json: async () => ({ secure_url: "https://res.cloudinary.com/test-cloud/image/upload/product.jpg" }),
    };
  };

  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const dataUrl = `data:image/png;base64,${jpegBytes.toString("base64")}`;
  await uploadProductImage(dataUrl);

  assert.equal(uploadedFile.type, "image/jpeg");
  assert.equal(uploadedFile.name, "product-image.jpg");
});
