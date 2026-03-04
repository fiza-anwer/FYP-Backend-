import { getAuthDb } from "../db/authDb.js";

const TENANT_NAME = "zee_clothing";
const NEW_EMAIL = "zee@gmail.com";

async function main() {
  const db = await getAuthDb();
  const tenants = db.collection("tenants");
  const res = await tenants.updateOne(
    { tenant_name: TENANT_NAME },
    { $set: { email: NEW_EMAIL } }
  );
  console.log("Matched:", res.matchedCount, "Modified:", res.modifiedCount);
}

main()
  .then(() => {
    console.log("Done updating tenant email for", TENANT_NAME);
    process.exit(0);
  })
  .catch((err) => {
    console.error("Error updating tenant email:", err);
    process.exit(1);
  });

