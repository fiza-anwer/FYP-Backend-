/**
 * Removes FedEx carrier and its services from auth DB (we work with DHL only for now).
 */
import { connectMongo } from "../db/mongo.js";
import { config } from "../config.js";

const client = await connectMongo();
const db = client.db(config.authDbName);

const carriers = db.collection("carriers");
const carrierServices = db.collection("carrier_services");

const fedex = await carriers.findOne({ slug: "fedex" });
if (fedex) {
  const fedexId = fedex._id;
  const delServices = await carrierServices.deleteMany({ carrier_id: fedexId });
  await carriers.deleteOne({ _id: fedexId });
  console.log("Migration 006_remove_fedex: Removed FedEx carrier and", delServices.deletedCount, "service(s).");
} else {
  console.log("Migration 006_remove_fedex: FedEx not found, skip.");
}

console.log("Migration 006_remove_fedex: done.");
