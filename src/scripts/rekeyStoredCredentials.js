import "../loadEnv.js";
import dns from "node:dns";
import { mkdir, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMongo } from "../db/mongo.js";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb } from "../db/tenantDb.js";
import {
  decryptCredentialTreeWithKeys,
  encryptCredentialTree,
  getFieldEncryptionKey,
} from "../db/credentialEncryption.js";

dns.setServers(["8.8.8.8", "8.8.4.4"]);

const APPLY = process.argv.includes("--apply");
const CREDENTIAL_COLLECTIONS = ["company_integrations", "carrier_integrations"];
const SERVICE_LINK_FIELDS = ["carrier_integration_id", "carrier_service_id"];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function getSourceKeys(targetKey) {
  const encodedKeys = (process.env.FIELD_ENCRYPTION_SOURCE_KEYS || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (encodedKeys.length === 0) {
    throw new Error("FIELD_ENCRYPTION_SOURCE_KEYS must contain the old key or keys.");
  }

  const keys = [targetKey];
  for (const encodedKey of encodedKeys) {
    const key = getFieldEncryptionKey(encodedKey);
    if (!keys.some((existingKey) => existingKey.equals(key))) keys.push(key);
  }
  return keys;
}

function reencryptTree(value, sourceKeys, targetKey) {
  const decryptStats = { decryptedValues: 0, decryptedByKey: [] };
  const plaintext = decryptCredentialTreeWithKeys(value, sourceKeys, decryptStats);
  if (decryptStats.decryptedValues === 0) {
    return { value, decryptedValues: 0, decryptedByKey: decryptStats.decryptedByKey };
  }

  const encryptStats = { encryptedValues: 0 };
  const encrypted = encryptCredentialTree(plaintext, targetKey, encryptStats);
  if (encryptStats.encryptedValues < decryptStats.decryptedValues) {
    throw new Error("Rekeying did not cover every encrypted credential value.");
  }

  const verified = decryptCredentialTreeWithKeys(encrypted, [targetKey]);
  if (!isDeepStrictEqual(verified, plaintext)) {
    throw new Error("Rekey verification failed; no database changes were made.");
  }
  return {
    value: encrypted,
    decryptedValues: decryptStats.decryptedValues,
    decryptedByKey: decryptStats.decryptedByKey,
  };
}

async function collectRekeyPlan(targetKey, sourceKeys) {
  const authDb = await getAuthDb();
  const tenants = await authDb.collection("tenants")
    .find({ tenant_name: { $type: "string", $ne: "" } })
    .project({ tenant_name: 1 })
    .toArray();
  const plan = [];
  let scannedDocuments = 0;
  let rekeyedValues = 0;
  const sourceKeyMatches = Array(sourceKeys.length).fill(0);

  for (const tenant of tenants) {
    const tenantDb = await getTenantDb(tenant.tenant_name);
    for (const collectionName of CREDENTIAL_COLLECTIONS) {
      const documents = await tenantDb.collection(collectionName)
        .find({ credentials: { $type: "object" } })
        .toArray();
      for (const document of documents) {
        scannedDocuments += 1;
        const result = reencryptTree(document.credentials, sourceKeys, targetKey);
        if (result.decryptedValues === 0) continue;
        rekeyedValues += result.decryptedValues;
        result.decryptedByKey.forEach((count, index) => {
          sourceKeyMatches[index] += count;
        });
        plan.push({
          tenantName: tenant.tenant_name,
          collectionName,
          id: document._id,
          original: document.credentials,
          encrypted: result.value,
        });
      }
    }

    const collectionName = "carrier_integration_services";
    const documents = await tenantDb.collection(collectionName).find({}).toArray();
    for (const document of documents) {
      scannedDocuments += 1;
      const original = Object.fromEntries(
        SERVICE_LINK_FIELDS
          .filter((field) => Object.prototype.hasOwnProperty.call(document, field))
          .map((field) => [field, document[field]])
      );
      const input = Object.fromEntries(
        Object.entries(original).map(([field, value]) => [
          field,
          value == null ||
            (typeof value === "object" &&
              Object.prototype.hasOwnProperty.call(value, "__unisell_secret_encryption"))
            ? value
            : String(value),
        ])
      );
      const result = reencryptTree(input, sourceKeys, targetKey);
      if (result.decryptedValues === 0) continue;
      rekeyedValues += result.decryptedValues;
      result.decryptedByKey.forEach((count, index) => {
        sourceKeyMatches[index] += count;
      });
      plan.push({
        tenantName: tenant.tenant_name,
        collectionName,
        id: document._id,
        original,
        encrypted: result.value,
        isServiceLink: true,
      });
    }
  }

  return {
    tenantsScanned: tenants.length,
    scannedDocuments,
    rekeyedValues,
    sourceKeyMatches,
    plan,
  };
}

async function saveEncryptedBackup(plan) {
  const backupDirectory = resolve(projectRoot, ".credential-recovery-backups");
  await mkdir(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = resolve(backupDirectory, `rekey-${timestamp}.json`);
  const backup = await Promise.all(plan.map(async (item) => ({
    tenant_name: item.tenantName,
    database: (await getTenantDb(item.tenantName)).databaseName,
    collection: item.collectionName,
    id: item.id.toString(),
    ...(item.isServiceLink
      ? { fields: item.original }
      : { credentials: item.original }),
  })));
  await writeFile(backupPath, JSON.stringify(backup, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return backupPath;
}

async function applyRekeyPlan(plan) {
  const backupPath = await saveEncryptedBackup(plan);
  let updatedDocuments = 0;
  for (const item of plan) {
    const collection = (await getTenantDb(item.tenantName)).collection(item.collectionName);
    let filter;
    let update;
    if (item.isServiceLink) {
      filter = { _id: item.id };
      for (const field of SERVICE_LINK_FIELDS) {
        filter[field] = Object.prototype.hasOwnProperty.call(item.original, field)
          ? item.original[field]
          : { $exists: false };
      }
      update = { $set: item.encrypted };
    } else {
      filter = { _id: item.id, credentials: item.original };
      update = { $set: { credentials: item.encrypted } };
    }

    const result = await collection.updateOne(filter, update);
    if (result.modifiedCount !== 1) {
      throw new Error(
        `Rekey stopped after ${updatedDocuments} documents: a record changed during migration.`
      );
    }
    updatedDocuments += 1;
  }
  return { backupPath, updatedDocuments };
}

async function main() {
  const targetKey = getFieldEncryptionKey();
  const sourceKeys = getSourceKeys(targetKey);
  const client = await connectMongo();
  try {
    const result = await collectRekeyPlan(targetKey, sourceKeys);
    console.log(JSON.stringify({
      mode: APPLY ? "apply" : "dry-run",
      tenantsScanned: result.tenantsScanned,
      documentsScanned: result.scannedDocuments,
      documentsToRekey: result.plan.length,
      valuesToRekey: result.rekeyedValues,
      encryptedValuesBySourceKey: result.sourceKeyMatches,
    }, null, 2));
    if (!APPLY) {
      console.log("Dry run only; MongoDB was not modified.");
      return;
    }

    const applied = await applyRekeyPlan(result.plan);
    console.log(`Re-encrypted credentials in ${applied.updatedDocuments} documents.`);
    console.log(`Encrypted backup saved locally at: ${applied.backupPath}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("Credential rekey failed:", error.message);
  process.exitCode = 1;
});
