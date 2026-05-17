/**
 * Creates carriers collection in auth DB.
 * credentials_schema defines the fields shown when user configures a carrier integration (like integrations).
 */
import { connectMongo } from "../db/mongo.js";
import { config } from "../config.js";

const client = await connectMongo();
const db = client.db(config.authDbName);

const existing = await db.listCollections().toArray();
const names = existing.map((c) => c.name);

if (!names.includes("carriers")) {
  await db.createCollection("carriers");
}
await db.collection("carriers").createIndex({ slug: 1 }, { unique: true }).catch(() => {});

const carriers = db.collection("carriers");
const dhl = await carriers.findOne({ slug: "dhl" });
if (!dhl) {
  await carriers.insertOne({
    name: "DHL",
    slug: "dhl",
    credentials_schema: [
      { key: "api_key", label: "API Key", type: "text", placeholder: "", required: true },
      { key: "api_secret", label: "API Secret", type: "password", placeholder: "", required: true },
    ],
    created_at: new Date(),
    updated_at: new Date(),
  });
  console.log("Migration 004_carriers: DHL carrier seeded.");
}

console.log("Migration 004_carriers: done.");
