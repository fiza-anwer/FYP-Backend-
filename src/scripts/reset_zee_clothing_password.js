import bcrypt from "bcryptjs";
import { getTenantDb } from "../db/tenantDb.js";

const TENANT_NAME = "zee_clothing";
const EMAIL = "zee@gmail.com";
const NEW_PASSWORD = "Zee@12345";

async function main() {
  const db = await getTenantDb(TENANT_NAME);
  const users = db.collection("users");
  const password_hash = bcrypt.hashSync(NEW_PASSWORD, 10);
  const result = await users.updateOne({ email: EMAIL }, { $set: { password_hash } });
  console.log("Matched:", result.matchedCount, "Modified:", result.modifiedCount);
}

main()
  .then(() => {
    console.log("Done resetting password for", EMAIL, "in tenant", TENANT_NAME);
    process.exit(0);
  })
  .catch((err) => {
    console.error("Error resetting password:", err);
    process.exit(1);
  });

