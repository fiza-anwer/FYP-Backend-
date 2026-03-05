/**
 * Leopard: optional API path override – use exact path that works (fixes 404 if endpoint changed).
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
        { key: "api_path", label: "API path (optional, if 404)", type: "text", placeholder: "e.g. api/bookPacket/format/json/", required: false },
      ],
      updated_at: new Date(),
    },
  }
);

if (result.modifiedCount) console.log("Migration 019_leopard_api_path: Leopard api_path option added.");
else console.log("Migration 019_leopard_api_path: no change.");
console.log("Migration 019_leopard_api_path: done.");
