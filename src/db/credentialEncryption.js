import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENCRYPTION_MARKER = "__unisell_secret_encryption";
const ENCRYPTED_FIELD_NAMES = new Set([
  "account",
  "account_num",
  "account_number",
  "access_token",
  "api_key",
  "api_password",
  "api_secret",
  "app_secret",
  "authorization_code",
  "carrier_integration_id",
  "carrier_service_id",
  "client_secret",
  "password",
  "refresh_token",
  "shop",
  "shop_domain",
  "store",
  "store_url",
  "token",
  "username",
  "x_shopify_token",
]);

function decodeBase64(value, fieldName) {
  if (typeof value !== "string" || !value) {
    throw new Error(`Encrypted credential has an invalid ${fieldName}.`);
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error(`Encrypted credential has an invalid ${fieldName}.`);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new Error(`Encrypted credential has an invalid ${fieldName}.`);
  }
  return decoded;
}

export function getFieldEncryptionKey(encodedKey = process.env.FIELD_ENCRYPTION_KEY) {
  if (!encodedKey) {
    throw new Error("FIELD_ENCRYPTION_KEY is required to encrypt or decrypt stored credentials.");
  }
  const key = decodeBase64(encodedKey, "FIELD_ENCRYPTION_KEY");
  if (key.length !== 32) {
    throw new Error("FIELD_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return key;
}

function encryptEnvelope(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    [ENCRYPTION_MARKER]: true,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEncryptedEnvelope(value) {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, ENCRYPTION_MARKER);
}

function isEncryptedFieldName(field) {
  return ENCRYPTED_FIELD_NAMES.has(field.toLowerCase().replace(/-/g, "_"));
}

export function encryptCredentialTree(value, key, stats = { encryptedValues: 0 }) {
  let encryptionKey = key;
  const encrypt = (item) => {
    if (Array.isArray(item)) return item.map(encrypt);
    if (!isPlainObject(item) || isEncryptedEnvelope(item)) return item;

    return Object.fromEntries(
      Object.entries(item).map(([field, fieldValue]) => {
        if (
          isEncryptedFieldName(field) &&
          (typeof fieldValue === "string" || typeof fieldValue === "number") &&
          String(fieldValue) !== ""
        ) {
          encryptionKey = encryptionKey || getFieldEncryptionKey();
          stats.encryptedValues += 1;
          return [field, encryptEnvelope(String(fieldValue), encryptionKey)];
        }
        return [field, encrypt(fieldValue)];
      })
    );
  };
  return encrypt(value);
}

function getPayload(value) {
  if (!Object.prototype.hasOwnProperty.call(value, ENCRYPTION_MARKER)) return null;
  const nested = value[ENCRYPTION_MARKER];
  if (isPlainObject(nested) && nested.iv && nested.tag && nested.data) return nested;
  return value;
}

function decryptEnvelope(payload, key) {
  if (!payload || !payload.iv || !payload.tag || typeof payload.data !== "string") {
    throw new Error("Encrypted credential has an unsupported envelope format.");
  }
  const iv = decodeBase64(payload.iv, "initialization vector");
  const tag = decodeBase64(payload.tag, "authentication tag");
  const data = decodeBase64(payload.data, "ciphertext");
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("Encrypted credential has an unsupported AES-GCM envelope.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function decryptCredentialTree(value, key, stats = { decryptedValues: 0 }) {
  if (Array.isArray(value)) {
    return value.map((item) => decryptCredentialTree(item, key, stats));
  }
  if (!isPlainObject(value)) return value;

  const payload = getPayload(value);
  if (payload) {
    const plaintext = decryptEnvelope(payload, key);
    stats.decryptedValues += 1;
    return plaintext;
  }

  return Object.fromEntries(
    Object.entries(value).map(([field, fieldValue]) => [
      field,
      decryptCredentialTree(fieldValue, key, stats),
    ])
  );
}

export function decryptCredentialTreeWithKeys(
  value,
  keys,
  stats = { decryptedValues: 0, decryptedByKey: [] }
) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("At least one source key is required to decrypt stored credentials.");
  }
  if (!Array.isArray(stats.decryptedByKey) || stats.decryptedByKey.length !== keys.length) {
    stats.decryptedByKey = Array(keys.length).fill(0);
  }

  if (Array.isArray(value)) {
    return value.map((item) => decryptCredentialTreeWithKeys(item, keys, stats));
  }
  if (!isPlainObject(value)) return value;

  const payload = getPayload(value);
  if (payload) {
    for (let index = 0; index < keys.length; index += 1) {
      try {
        const plaintext = decryptEnvelope(payload, keys[index]);
        stats.decryptedValues += 1;
        stats.decryptedByKey[index] += 1;
        return plaintext;
      } catch {
        // Try the next candidate key; authenticated decryption rejects incorrect keys.
      }
    }
    throw new Error("Encrypted credential could not be authenticated with any configured source key.");
  }

  return Object.fromEntries(
    Object.entries(value).map(([field, fieldValue]) => [
      field,
      decryptCredentialTreeWithKeys(fieldValue, keys, stats),
    ])
  );
}

export function decryptStoredCredentials(value, key) {
  const containsEncryptedEnvelope = (item) => {
    if (Array.isArray(item)) return item.some(containsEncryptedEnvelope);
    if (!isPlainObject(item)) return false;
    return isEncryptedEnvelope(item) || Object.values(item).some(containsEncryptedEnvelope);
  };
  if (!containsEncryptedEnvelope(value)) return value;
  return decryptCredentialTree(value, key || getFieldEncryptionKey());
}
