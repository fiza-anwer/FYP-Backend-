/**
 * Adds Leopard Courier (Pakistan) carrier and default service.
 * API: https://merchantapi.leopardscourier.com/api/bookPacket/format/json/
 * Body: JSON with api_key, api_password, booked_packet_*, shipment_*, consignment_*, etc.
 */
import { connectMongo } from "../db/mongo.js";
import { config } from "../config.js";

const client = await connectMongo();
const db = client.db(config.authDbName);

const carriers = db.collection("carriers");
const carrierServices = db.collection("carrier_services");

const leopard = await carriers.findOne({ slug: "leopard" });
if (!leopard) {
  await carriers.insertOne({
    name: "Leopard Courier",
    slug: "leopard",
    credentials_schema: [
      { key: "api_key", label: "API Key", type: "text", placeholder: "Leopard Merchant API key", required: true },
      { key: "api_password", label: "API Password", type: "password", placeholder: "Leopard API password", required: true },
      { key: "origin_city_id", label: "Origin city ID (optional)", type: "text", placeholder: "Leave blank for 'self', or numeric ID from Leopard getAllCities", required: false },
      { key: "destination_city_id", label: "Destination city ID (optional)", type: "text", placeholder: "Leave blank for 'self', or numeric ID from Leopard getAllCities", required: false },
    ],
    created_at: new Date(),
    updated_at: new Date(),
  });
  console.log("Migration 017_leopard_carrier: Leopard carrier seeded.");
}

const leopardCarrier = await carriers.findOne({ slug: "leopard" });
if (leopardCarrier) {
  const existingService = await carrierServices.findOne({ carrier_id: leopardCarrier._id });
  if (!existingService) {
    await carrierServices.insertMany([
      { carrier_id: leopardCarrier._id, name: "Book Packet", code: "standard", created_at: new Date(), updated_at: new Date() },
    ]);
    console.log("Migration 017_leopard_carrier: Leopard carrier services seeded.");
  }
}

console.log("Migration 017_leopard_carrier: done.");
