/**
 * Seed Daraz integration in auth DB (OAuth — no manual credential fields).
 */
import { connectMongo } from "../db/mongo.js";
import { config } from "../config.js";

const client = await connectMongo();
const db = client.db(config.authDbName);
const integrations = db.collection("integrations");

const existing = await integrations.findOne({ slug: "daraz" });
if (!existing) {
  await integrations.insertOne({
    name: "Daraz",
    slug: "daraz",
    credentials_schema: [],
    created_at: new Date(),
    updated_at: new Date(),
  });
  console.log("Migration 023_daraz_integration: Daraz integration seeded.");
} else {
  console.log("Migration 023_daraz_integration: Daraz already exists, skip.");
}

console.log("Migration 023_daraz_integration: done.");
