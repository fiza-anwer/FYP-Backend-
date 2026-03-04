/**
 * DHL credentials_schema: username, password, base_url only.
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
        { key: "base_url", label: "Base URL", type: "text", placeholder: "https://express.api.dhl.com/mydhlapi/test", required: false },
      ],
      updated_at: new Date(),
    },
  }
);

if (result.modifiedCount) console.log("Migration 009_dhl_remove_shipper_account_field: DHL schema updated.");
else console.log("Migration 009_dhl_remove_shipper_account_field: no change.");
console.log("Migration 009_dhl_remove_shipper_account_field: done.");
