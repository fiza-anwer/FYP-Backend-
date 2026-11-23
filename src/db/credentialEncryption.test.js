import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  decryptCredentialTree,
  decryptCredentialTreeWithKeys,
  decryptStoredCredentials,
  encryptCredentialTree,
  getFieldEncryptionKey,
} from "./credentialEncryption.js";

function encryptFixture(plaintext, key, nestedMarker = false) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const payload = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return nestedMarker
    ? { __unisell_secret_encryption: payload }
    : { __unisell_secret_encryption: true, ...payload };
}

test("decrypts marked credentials recursively and preserves plaintext fields", () => {
  const key = randomBytes(32);
  const stats = { decryptedValues: 0 };
  const credentials = {
    access_token: encryptFixture("token-value", key),
    refresh_token: encryptFixture("refresh-value", key, true),
    shop_name: "Store",
  };

  assert.deepEqual(decryptCredentialTree(credentials, key, stats), {
    access_token: "token-value",
    refresh_token: "refresh-value",
    shop_name: "Store",
  });
  assert.equal(stats.decryptedValues, 2);
});

test("rejects invalid keys and authenticated ciphertext", () => {
  assert.throws(() => getFieldEncryptionKey("invalid"), /invalid FIELD_ENCRYPTION_KEY/);
  assert.throws(() => getFieldEncryptionKey(randomBytes(31).toString("base64")), /32 bytes/);

  const key = randomBytes(32);
  const envelope = encryptFixture("secret", key);
  envelope.data = Buffer.from("tampered").toString("base64");
  assert.throws(() => decryptCredentialTree(envelope, key));
});

test("decrypts mixed-key credential trees with a keyring", () => {
  const firstKey = randomBytes(32);
  const secondKey = randomBytes(32);
  const credentials = {
    access_token: encryptFixture("token-value", firstKey),
    password: encryptFixture("password-value", secondKey, true),
    shop_name: "Store",
  };
  const stats = { decryptedValues: 0, decryptedByKey: [] };

  assert.deepEqual(
    decryptCredentialTreeWithKeys(credentials, [firstKey, secondKey], stats),
    {
      access_token: "token-value",
      password: "password-value",
      shop_name: "Store",
    }
  );
  assert.deepEqual(stats.decryptedByKey, [1, 1]);
  assert.throws(
    () => decryptCredentialTreeWithKeys(credentials, [firstKey]),
    /any configured source key/
  );
});

test("encrypts requested credential fields and relation IDs while preserving other values", () => {
  const key = randomBytes(32);
  const credentials = {
    username: "merchant",
    password: "pass-value",
    account_number: "12345",
    api_key: "key-value",
    api_password: "api-pass",
    shop_domain: "example.myshopify.com",
    access_token: "shop-token",
    shop_name: "Store",
  };
  const encrypted = encryptCredentialTree({
    credentials,
    carrier_integration_id: "integration-id",
    carrier_service_id: "service-id",
  }, key);

  for (const field of [
    "username",
    "password",
    "account_number",
    "api_key",
    "api_password",
    "shop_domain",
    "access_token",
  ]) {
    assert.equal(encrypted.credentials[field].__unisell_secret_encryption, true);
  }
  assert.equal(encrypted.carrier_integration_id.__unisell_secret_encryption, true);
  assert.equal(encrypted.carrier_service_id.__unisell_secret_encryption, true);
  assert.equal(encrypted.credentials.shop_name, credentials.shop_name);
  assert.deepEqual(decryptStoredCredentials(encrypted, key), {
    credentials,
    carrier_integration_id: "integration-id",
    carrier_service_id: "service-id",
  });
});
