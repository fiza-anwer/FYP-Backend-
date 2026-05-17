import { connectMongo } from "./mongo.js";
import { config } from "../config.js";

export async function getAuthDb() {
  const client = await connectMongo();
  return client.db(config.authDbName);
}
