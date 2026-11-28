import { createHash } from "node:crypto";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function invalidImage(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function detectImageType(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") {
    throw invalidImage("Choose a PNG, JPEG, or WebP image to upload.");
  }

  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || !IMAGE_TYPES.has(match[1])) {
    throw invalidImage("Choose a PNG, JPEG, or WebP image to upload.");
  }

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES || buffer.toString("base64") !== match[2]) {
    throw invalidImage("Image must be smaller than 5 MB and have valid encoding.");
  }

  const contentType = detectImageType(buffer);
  if (!contentType) throw invalidImage("The selected file is not a valid PNG, JPEG, or WebP image.");
  return { buffer, contentType };
}

export async function uploadProductImage(dataUrl) {
  const { buffer, contentType } = decodeImageDataUrl(dataUrl);
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) {
    const error = new Error("Cloudinary image upload is not configured on the backend.");
    error.status = 503;
    throw error;
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const folder = "unisell/products";
  const signatureBase = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = createHash("sha1").update(signatureBase).digest("hex");
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
  const body = new FormData();
  body.append("file", new Blob([buffer], { type: contentType }), `product-image.${extension}`);
  body.append("api_key", apiKey);
  body.append("folder", folder);
  body.append("timestamp", timestamp);
  body.append("signature", signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`,
    { method: "POST", body }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result?.error?.message;
    throw new Error(
      typeof message === "string" && message.trim()
        ? `Cloudinary upload failed: ${message}`
        : `Cloudinary upload failed (${response.status}).`
    );
  }

  const secureUrl = typeof result?.secure_url === "string" ? result.secure_url : "";
  if (!/^https:\/\/res\.cloudinary\.com\//i.test(secureUrl)) {
    throw new Error("Cloudinary did not return a valid HTTPS image URL.");
  }
  return secureUrl;
}
