/**
 * Updates DHL carrier credentials_schema to MyDHL API format:
 * username, password, base_url (test: https://express.api.dhl.com/mydhlapi/test)
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
        {
          key: "base_url",
          label: "Base URL",
          type: "text",
          placeholder: "https://express.api.dhl.com/mydhlapi/test",
          required: false,
        },
      ],
      updated_at: new Date(),
    },
  }
);

if (result.modifiedCount) console.log("Migration 007_dhl_credentials_schema: DHL credentials_schema updated.");
else console.log("Migration 007_dhl_credentials_schema: no change (DHL carrier not found or already updated).");
console.log("Migration 007_dhl_credentials_schema: done.");
