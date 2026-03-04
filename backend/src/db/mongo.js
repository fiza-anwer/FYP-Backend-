import { MongoClient } from "mongodb";
import { config } from "../config.js";

let client = null;

// Use empty prefix so DB name = tenant name (e.g. zee_clothing). Set TENANT_DB_PREFIX=fyp_tenant_ if you use prefixed DBs.
const tenantDbPrefix = process.env.TENANT_DB_PREFIX ?? "";

export async function connectMongo() {
  if (client) return client;
  client = new MongoClient(config.mongoUri);
  await client.connect();
  return client;
}

/**
 * Normalize tenant name to a DB-safe slug so "Zee Clothing" and "zee_clothing" both resolve to the same DB.
 */
export function getTenantDbSlug(tenantName) {
  const s = String(tenantName || "").trim();
  if (!s) return "";
  return s.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "");
}

/**
 * Get tenant DB for the given tenant name (e.g. from auth tenants collection).
 * With default empty prefix, DB name is the normalized tenant name (e.g. zee_clothing).
 */
export async function getTenantDb(tenantName) {
  const c = await connectMongo();
  const name = getTenantDbSlug(tenantName);
  if (!name) throw new Error("Invalid tenant name");
  const dbName = tenantDbPrefix ? tenantDbPrefix + name : name;
  return c.db(dbName);
}
