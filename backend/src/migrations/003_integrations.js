/**
 * Creates integrations collection in auth DB and seeds Shopify integration.
 * credentials_schema defines the fields shown when user selects this integration.
 */
import { connectMongo } from "../db/mongo.js";
import { config } from "../config.js";

const client = await connectMongo();
const db = client.db(config.authDbName);

const existing = await db.listCollections().toArray();
const names = existing.map((c) => c.name);

if (!names.includes("integrations")) {
  await db.createCollection("integrations");
}
await db.collection("integrations").createIndex({ slug: 1 }, { unique: true }).catch(() => {});

const integrations = db.collection("integrations");
const shopify = await integrations.findOne({ slug: "shopify" });
if (!shopify) {
  await integrations.insertOne({
    name: "Shopify",
    slug: "shopify",
    credentials_schema: [
      { key: "shop_domain", label: "Shop Domain", type: "text", placeholder: "your-store.myshopify.com", required: true },
      { key: "access_token", label: "Admin API Access Token", type: "password", placeholder: "shpat_...", required: true },
    ],
    created_at: new Date(),
    updated_at: new Date(),
  });
  console.log("Migration 003_integrations: Shopify integration seeded.");
} else {
  console.log("Migration 003_integrations: Shopify already exists, skip.");
}

console.log("Migration 003_integrations: done.");
