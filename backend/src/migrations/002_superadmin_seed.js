/**
 * Seed superadmin in existing superadmins collection (skip if any exists).
 * Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD in env. Uses superadmins, not users.
 */
import bcrypt from "bcryptjs";
import { connectMongo } from "../db/mongo.js";
import { config } from "../config.js";

const client = await connectMongo();
const db = client.db(config.authDbName);
const superadmins = db.collection("superadmins");

const existing = await superadmins.findOne({});
const defaultEmail = process.env.SUPERADMIN_EMAIL || "admin@example.com";
const defaultPassword = process.env.SUPERADMIN_PASSWORD || "admin123";

if (existing) {
  if (!existing.password_hash && !existing.password) {
    const password_hash = bcrypt.hashSync(defaultPassword, 10);
    await superadmins.updateOne(
      { _id: existing._id },
      { $set: { password_hash, updated_at: new Date() } }
    );
    console.log("Migration 002_superadmin_seed: superadmin password_hash set.");
  } else {
    console.log("Migration 002_superadmin_seed: superadmin already exists, skip.");
  }
} else {
  const password_hash = bcrypt.hashSync(defaultPassword, 10);
  await superadmins.insertOne({
    email: defaultEmail,
    password_hash,
    created_at: new Date(),
    updated_at: new Date(),
  });
  console.log("Migration 002_superadmin_seed: superadmin created in superadmins (email from env, password hashed).");
}
console.log("Migration 002_superadmin_seed: done.");
