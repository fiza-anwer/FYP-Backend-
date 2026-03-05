/**
 * Leopard: credentials only api_key and api_password (no base_url, api_path).
 */
import { connectMongo } from "../db/mongo.js";
import { config } from "../config.js";

const client = await connectMongo();
const db = client.db(config.authDbName);

const result = await db.collection("carriers").updateOne(
  { slug: "leopard" },
  {
    $set: {
      credentials_schema: [
        { key: "api_key", label: "API Key", type: "text", placeholder: "Leopard Merchant API key", required: true },
        { key: "api_password", label: "API Password", type: "password", placeholder: "Leopard API password", required: true },
      ],
      updated_at: new Date(),
    },
  }
);

if (result.modifiedCount) console.log("Migration 020_leopard_credentials_only: Leopard schema updated (api_key, api_password only).");
else console.log("Migration 020_leopard_credentials_only: no change.");
console.log("Migration 020_leopard_credentials_only: done.");
