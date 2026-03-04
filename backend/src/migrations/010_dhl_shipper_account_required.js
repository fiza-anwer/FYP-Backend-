/**
 * Adds Shipper account number to DHL credentials_schema (required by DHL API – error 801 without it).
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
        { key: "base_url", label: "Base URL", type: "text", placeholder: "https://express.api.dhl.com/mydhlapi/test", required: false },
      ],
      updated_at: new Date(),
    },
  }
);

if (result.modifiedCount) console.log("Migration 010_dhl_shipper_account_required: DHL schema updated.");
else console.log("Migration 010_dhl_shipper_account_required: no change.");
console.log("Migration 010_dhl_shipper_account_required: done.");
