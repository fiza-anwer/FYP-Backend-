import "../loadEnv.js";
import dns from "node:dns";
import { connectMongo } from "../db/mongo.js";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb } from "../db/tenantDb.js";
import { encryptCredentialTree, getFieldEncryptionKey } from "../db/credentialEncryption.js";

dns.setServers(["8.8.8.8", "8.8.4.4"]);

const APPLY = process.argv.includes("--apply");
const CREDENTIAL_COLLECTIONS = ["company_integrations", "carrier_integrations"];

async function collectEncryptionPlan() {
  const key = getFieldEncryptionKey();
  const authDb = await getAuthDb();
  const tenants = await authDb.collection("tenants")
    .find({ tenant_name: { $type: "string", $ne: "" } })
    .project({ tenant_name: 1 })
    .toArray();
  const plan = [];
  let scannedDocuments = 0;
  let encryptedValues = 0;

  for (const tenant of tenants) {
    const tenantDb = await getTenantDb(tenant.tenant_name);
    for (const collectionName of CREDENTIAL_COLLECTIONS) {
      const documents = await tenantDb.collection(collectionName)
        .find({ credentials: { $type: "object" } })
        .toArray();
      for (const document of documents) {
        scannedDocuments += 1;
        const stats = { encryptedValues: 0 };
        const credentials = encryptCredentialTree(document.credentials, key, stats);
        if (stats.encryptedValues === 0) continue;
        encryptedValues += stats.encryptedValues;
        plan.push({
          tenantName: tenant.tenant_name,
          collectionName,
          id: document._id,
          original: document.credentials,
          encrypted: credentials,
        });
      }
    }

    const collectionName = "carrier_integration_services";
    const documents = await tenantDb.collection(collectionName).find({}).toArray();
    for (const document of documents) {
      scannedDocuments += 1;
      const original = Object.fromEntries(
        ["carrier_integration_id", "carrier_service_id"]
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
      const stats = { encryptedValues: 0 };
      const encrypted = encryptCredentialTree(input, key, stats);
      if (stats.encryptedValues === 0) continue;
      encryptedValues += stats.encryptedValues;
      plan.push({
        tenantName: tenant.tenant_name,
        collectionName,
        id: document._id,
        original,
        encrypted,
        isServiceLink: true,
      });
    }
  }
  return { tenantsScanned: tenants.length, scannedDocuments, encryptedValues, plan };
}

async function applyEncryptionPlan(plan) {
  let updatedDocuments = 0;
  for (const item of plan) {
    const collection = (await getTenantDb(item.tenantName)).collection(item.collectionName);
    const filter = item.isServiceLink
      ? {
          _id: item.id,
          carrier_integration_id: item.original.carrier_integration_id,
          carrier_service_id: item.original.carrier_service_id,
        }
      : { _id: item.id, credentials: item.original };
    const update = item.isServiceLink
      ? { $set: item.encrypted }
      : { $set: { credentials: item.encrypted } };
    const result = await collection.updateOne(filter, update);
    if (result.modifiedCount !== 1) {
      throw new Error(
        `Encryption stopped after ${updatedDocuments} documents: a record changed during migration.`
      );
    }
    updatedDocuments += 1;
  }
  return updatedDocuments;
}

async function main() {
  const client = await connectMongo();
  try {
    const result = await collectEncryptionPlan();
    console.log(JSON.stringify({
      mode: APPLY ? "apply" : "dry-run",
      tenantsScanned: result.tenantsScanned,
      documentsScanned: result.scannedDocuments,
      documentsToEncrypt: result.plan.length,
      valuesToEncrypt: result.encryptedValues,
    }, null, 2));
    if (!APPLY) {
      console.log("Dry run only; MongoDB was not modified. Re-run with --apply to encrypt these values.");
      return;
    }
    const updatedDocuments = await applyEncryptionPlan(result.plan);
    console.log(`Encrypted credentials in ${updatedDocuments} documents.`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("Credential encryption failed:", error.message);
  process.exitCode = 1;
});
