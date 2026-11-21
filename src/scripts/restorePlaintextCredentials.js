import "../loadEnv.js";
import dns from "node:dns";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMongo } from "../db/mongo.js";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb } from "../db/tenantDb.js";
import { decryptCredentialTree, getFieldEncryptionKey } from "../db/credentialEncryption.js";

dns.setServers(["8.8.8.8", "8.8.4.4"]);

const APPLY = process.argv.includes("--apply");
const COLLECTIONS = ["company_integrations", "carrier_integrations"];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function collectRecoveryPlan() {
  const key = getFieldEncryptionKey();
  const authDb = await getAuthDb();
  const tenants = await authDb.collection("tenants")
    .find({ tenant_name: { $type: "string", $ne: "" } })
    .project({ tenant_name: 1 })
    .toArray();
  const plan = [];
  let scannedDocuments = 0;
  let decryptedValues = 0;

  for (const tenant of tenants) {
    const tenantDb = await getTenantDb(tenant.tenant_name);
    for (const collectionName of COLLECTIONS) {
      const documents = await tenantDb.collection(collectionName)
        .find({ credentials: { $type: "object" } })
        .toArray();
      for (const document of documents) {
        scannedDocuments += 1;
        const stats = { decryptedValues: 0 };
        const credentials = decryptCredentialTree(document.credentials, key, stats);
        if (stats.decryptedValues === 0) continue;
        if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
          throw new Error(`Decrypted credentials in ${collectionName} have an unexpected shape.`);
        }
        decryptedValues += stats.decryptedValues;
        plan.push({
          tenantName: tenant.tenant_name,
          databaseName: tenantDb.databaseName,
          collectionName,
          id: document._id,
          originalCredentials: document.credentials,
          decryptedCredentials: credentials,
        });
      }
    }
  }
  return { tenantsScanned: tenants.length, scannedDocuments, decryptedValues, plan };
}

async function saveEncryptedBackup(plan) {
  const backupDirectory = resolve(projectRoot, ".credential-recovery-backups");
  await mkdir(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = resolve(backupDirectory, `credentials-${timestamp}.json`);
  const backup = plan.map((item) => ({
    tenant_name: item.tenantName,
    database: item.databaseName,
    collection: item.collectionName,
    id: item.id.toString(),
    credentials: item.originalCredentials,
  }));
  await writeFile(backupPath, JSON.stringify(backup, null, 2), { flag: "wx", mode: 0o600 });
  return backupPath;
}

async function applyRecovery(plan) {
  const backupPath = await saveEncryptedBackup(plan);
  let restoredDocuments = 0;
  for (const item of plan) {
    const result = await (await getTenantDb(item.tenantName))
      .collection(item.collectionName)
      .updateOne(
        { _id: item.id, credentials: item.originalCredentials },
        { $set: { credentials: item.decryptedCredentials } }
      );
    if (result.modifiedCount !== 1) {
      throw new Error(
        `Recovery stopped after ${restoredDocuments} documents: a credential record changed during recovery.`
      );
    }
    restoredDocuments += 1;
  }
  return { backupPath, restoredDocuments };
}

async function main() {
  const client = await connectMongo();
  try {
    const result = await collectRecoveryPlan();
    console.log(JSON.stringify({
      mode: APPLY ? "apply" : "dry-run",
      tenantsScanned: result.tenantsScanned,
      credentialDocumentsScanned: result.scannedDocuments,
      documentsToRestore: result.plan.length,
      encryptedValuesToRestore: result.decryptedValues,
    }, null, 2));
    if (!APPLY) {
      console.log("Dry run only; MongoDB was not modified. Re-run with --apply only after reviewing this preview.");
      return;
    }
    const applied = await applyRecovery(result.plan);
    console.log(`Restored ${applied.restoredDocuments} credential documents.`);
    console.log(`Encrypted backup saved locally at: ${applied.backupPath}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("Credential recovery failed:", error.message);
  process.exitCode = 1;
});
