/**
 * Leopard: remove shipper account number from credentials_schema (not in API body).
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
        { key: "base_url", label: "Base URL (optional)", type: "text", placeholder: "https://merchantapi.leopardscourier.com", required: false },
      ],
      updated_at: new Date(),
    },
  }
);

if (result.modifiedCount) console.log("Migration 018_leopard_remove_account_number: Leopard schema updated (account_number removed).");
else console.log("Migration 018_leopard_remove_account_number: no change.");
console.log("Migration 018_leopard_remove_account_number: done.");
