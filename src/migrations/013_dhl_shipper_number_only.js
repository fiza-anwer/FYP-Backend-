/**
 * DHL carrier integration: shipper account number + API credentials only.
 * No shipper address fields. Destination comes from order address.
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

if (result.modifiedCount) console.log("Migration 013_dhl_shipper_number_only: DHL schema updated (shipper number + API only).");
else console.log("Migration 013_dhl_shipper_number_only: no change.");
console.log("Migration 013_dhl_shipper_number_only: done.");
