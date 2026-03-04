/**
 * Reset superadmin email and password to env values (or defaults).
 * Run this if superadmin login stops working. Uses existing superadmins collection.
 * Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD in .env, or defaults are admin@example.com / admin123.
 */
import bcrypt from "bcryptjs";
import { connectMongo } from "../db/mongo.js";
import { config } from "../config.js";

const client = await connectMongo();
const db = client.db(config.authDbName);
const superadmins = db.collection("superadmins");

const email = (process.env.SUPERADMIN_EMAIL || "admin@example.com").trim().toLowerCase();
const password = process.env.SUPERADMIN_PASSWORD || "admin123";
const password_hash = bcrypt.hashSync(password, 10);

const result = await superadmins.updateOne(
  {},
  { $set: { email, password_hash, updated_at: new Date() } }
);

if (result.matchedCount === 0) {
  await superadmins.insertOne({
    email,
    password_hash,
    created_at: new Date(),
    updated_at: new Date(),
  });
  console.log("Migration 016: superadmin created with email:", email);
} else {
  console.log("Migration 016: superadmin password reset. Email:", email);
}
console.log("Migration 016_reset_superadmin_password: done. Use the email above and your set password (or default admin123) to sign in.");
