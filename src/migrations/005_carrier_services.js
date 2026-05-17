/**
 * Creates carrier_services collection in auth DB, linked to carriers by carrier_id.
 */
import { ObjectId } from "mongodb";
import { connectMongo } from "../db/mongo.js";
import { config } from "../config.js";

const client = await connectMongo();
const db = client.db(config.authDbName);

const existing = await db.listCollections().toArray();
const names = existing.map((c) => c.name);

if (!names.includes("carrier_services")) {
  await db.createCollection("carrier_services");
}
await db.collection("carrier_services").createIndex({ carrier_id: 1 }).catch(() => {});
await db.collection("carrier_services").createIndex({ carrier_id: 1, code: 1 }, { unique: true }).catch(() => {});

const carriers = db.collection("carriers");
const carrierServices = db.collection("carrier_services");

const dhl = await carriers.findOne({ slug: "dhl" });
if (dhl) {
  const dhlId = dhl._id;
  const existingDhl = await carrierServices.findOne({ carrier_id: dhlId });
  if (!existingDhl) {
    await carrierServices.insertMany([
      { carrier_id: dhlId, name: "Express Worldwide", code: "express", created_at: new Date(), updated_at: new Date() },
      { carrier_id: dhlId, name: "Economy Select", code: "economy", created_at: new Date(), updated_at: new Date() },
    ]);
    console.log("Migration 005_carrier_services: DHL services seeded.");
  }
}

console.log("Migration 005_carrier_services: done.");
