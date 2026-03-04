import { getTenantDb as getTenantDbFromMongo, connectMongo, getTenantDbSlug } from "./mongo.js";

export async function getTenantDb(tenantName) {
  return getTenantDbFromMongo(tenantName);
}

export async function tenantDbExists(tenantName) {
  const name = getTenantDbSlug(tenantName);
  if (!name) return false;
  const tenantDbPrefix = process.env.TENANT_DB_PREFIX ?? "";
  const client = await connectMongo();
  const dbName = tenantDbPrefix ? tenantDbPrefix + name : name;
  const admin = client.db("admin").admin();
  const { databases } = await admin.listDatabases();
  return databases.some((d) => d.name === dbName);
}
