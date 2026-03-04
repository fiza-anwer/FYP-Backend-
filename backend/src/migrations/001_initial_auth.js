/**
 * Ensure auth DB has tenants and superadmins collections only (use existing; do not create "users").
 */
import { connectMongo } from "../db/mongo.js";
import { config } from "../config.js";

const client = await connectMongo();
const db = client.db(config.authDbName);

const existing = await db.listCollections().toArray();
const names = existing.map((c) => c.name);

if (!names.includes("tenants")) {
  await db.createCollection("tenants");
}
if (names.includes("tenants")) {
  await db.collection("tenants").createIndex({ tenant_name: 1 }, { unique: true }).catch(() => {});
  await db.collection("tenants").createIndex({ email: 1 }, { unique: true }).catch(() => {});
}
if (!names.includes("superadmins")) {
  await db.createCollection("superadmins");
}
if (names.includes("superadmins")) {
  await db.collection("superadmins").createIndex({ email: 1 }, { unique: true }).catch(() => {});
}

console.log("Migration 001_initial_auth: done.");
