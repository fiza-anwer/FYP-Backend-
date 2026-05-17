import "../loadEnv.js";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function run() {
  const dir = join(__dirname);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".js") && f !== "run.js")
    .sort();

  for (const file of files) {
    const name = file.replace(/\.js$/, "");
    console.log("Running " + name + "...");
    try {
      const path = join(dir, file);
      await import(pathToFileURL(path).href);
    } catch (err) {
      console.error("Migration " + name + " failed:", err);
      process.exit(1);
    }
  }
  console.log("All migrations completed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
