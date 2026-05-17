/**
 * Adds optional Shipper country only. Receiver address/postal always come from the order.
 * One field: where you ship FROM (country code). Fixes DHL product/segment errors (1001, 410138, 410301).
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
        { key: "shipper_country", label: "Origin country (only for international)", type: "text", placeholder: "Leave blank for domestic. Set e.g. US if you ship from US to other countries.", required: false },
        { key: "base_url", label: "Base URL", type: "text", placeholder: "https://express.api.dhl.com/mydhlapi/test", required: false },
      ],
      updated_at: new Date(),
    },
  }
);

if (result.modifiedCount) console.log("Migration 011_dhl_shipper_address: DHL schema updated.");
else console.log("Migration 011_dhl_shipper_address: no change.");
console.log("Migration 011_dhl_shipper_address: done.");
