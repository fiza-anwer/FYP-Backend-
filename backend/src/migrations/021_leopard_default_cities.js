/**
 * Leopard: add optional default origin/destination city (fixes "city is disabled" and "Special Instructions are required").
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
        { key: "origin_city_id", label: "Origin city ID (optional)", type: "text", placeholder: "Leave blank for 'self', or numeric ID from Leopard getAllCities", required: false },
        { key: "destination_city_id", label: "Destination city ID (optional)", type: "text", placeholder: "Leave blank for 'self', or numeric ID from Leopard getAllCities", required: false },
      ],
      updated_at: new Date(),
    },
  }
);

if (result.modifiedCount) console.log("Migration 021_leopard_default_cities: Leopard default city options added.");
else console.log("Migration 021_leopard_default_cities: no change.");
console.log("Migration 021_leopard_default_cities: done.");
