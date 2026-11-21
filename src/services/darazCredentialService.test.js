import test from "node:test";
import assert from "node:assert/strict";
import {
  decryptStoredCredentials,
  encryptCredentialTree,
} from "../db/credentialEncryption.js";
import { persistDarazCredentialsIfChanged } from "./darazCredentialService.js";

test("persists rotated Daraz tokens encrypted and skips unchanged tokens", async () => {
  const originalKey = process.env.FIELD_ENCRYPTION_KEY;
  process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  let updateCount = 0;
  const integration = {
    _id: "company-integration-id",
    credentials: encryptCredentialTree({
      access_token: "expired-token",
      refresh_token: "old-refresh-token",
    }),
  };
  const collection = {
    async updateOne(filter, update) {
      assert.deepEqual(filter, { _id: integration._id });
      updateCount += 1;
      integration.credentials = update.$set.credentials;
      return { matchedCount: 1 };
    },
  };

  try {
    const refreshedCredentials = {
      access_token: "new-token",
      refresh_token: "rotated-refresh-token",
    };
    assert.equal(
      await persistDarazCredentialsIfChanged(collection, integration, refreshedCredentials),
      true
    );
    assert.deepEqual(decryptStoredCredentials(integration.credentials), refreshedCredentials);
    assert.equal(
      await persistDarazCredentialsIfChanged(collection, integration, refreshedCredentials),
      false
    );
    assert.equal(updateCount, 1);
  } finally {
    if (originalKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
    else process.env.FIELD_ENCRYPTION_KEY = originalKey;
  }
});
