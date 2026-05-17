/**
 * DHL requires the REAL shipper (origin) address – as on your DHL contract.
 * Placeholders cause: 420504 (origin invalid), 1001/410138 (product not available).
 * This migration adds address, city, postal code so you enter the exact address DHL has on file.
 */
import { connectMongo } from "../db/mongo.js";
import { config } from "../config.js";

const client = await connectMongo();
const db = client.db(config.authDbName);

const result = await db.collection("carriers").updateOne(
  { slug: "dhl" },
  {
    $set: {
      credentials_schema: [
        { key: "username", label: "Username (API Key)", type: "text", placeholder: "MyDHL API username", required: true },
        { key: "password", label: "Password (API Secret)", type: "password", placeholder: "MyDHL API password", required: true },
        { key: "account_number", label: "Shipper account number", type: "text", placeholder: "From DHL contract or invoice", required: true },
        { key: "shipper_country", label: "Shipper country (origin)", type: "text", placeholder: "e.g. PK, US, GB – must match DHL contract", required: true },
        { key: "shipper_postal_code", label: "Shipper postal code", type: "text", placeholder: "Origin postcode – must match DHL contract", required: true },
        { key: "shipper_city", label: "Shipper city", type: "text", placeholder: "Origin city – must match DHL contract", required: true },
        { key: "shipper_address_line1", label: "Shipper address (street)", type: "text", placeholder: "Origin street – must match DHL contract", required: true },
        { key: "base_url", label: "Base URL", type: "text", placeholder: "https://express.api.dhl.com/mydhlapi/test", required: false },
      ],
      updated_at: new Date(),
    },
  }
);

if (result.modifiedCount) console.log("Migration 012_dhl_shipper_full_address: DHL schema updated.");
else console.log("Migration 012_dhl_shipper_full_address: no change.");
console.log("Migration 012_dhl_shipper_full_address: done.");
