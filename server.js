/**
 * Main server entry (dotenv + Express + CORS + JSON).
 * Keeps existing UniSell API routes, MongoDB, and cron jobs.
 */
import "./src/loadEnv.js";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import cron from "node-cron";
import { connectMongo } from "./src/db/mongo.js";
import { config } from "./src/config.js";
import tenantRouter from "./src/routes/tenant.js";
import authRouter from "./src/routes/auth.js";
import darazRoutes from "./src/routes/daraz.js";
import { runOrderImportForAllTenants } from "./src/services/orderImportService.js";
import {
  runProductImportForAllTenants,
  runPushPendingProductsForAllTenants,
  runPushPendingProductsToDarazForAllTenants,
} from "./src/services/productImportService.js";
import { syncInventoryToChannelsForAllTenants } from "./src/services/inventorySyncService.js";
import { scanZeroStockForAllTenants } from "./src/services/stockAlertService.js";

const app = express();

app.use(
  cors({
    origin: config.frontendOrigin,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRouter);
app.use("/api/tenant", tenantRouter);
app.use("/api/daraz", darazRoutes);

cron.schedule("*/5 * * * *", async () => {
  try {
    await runOrderImportForAllTenants();
  } catch (err) {
    console.error("Order import cron error:", err);
  }
});

cron.schedule("*/5 * * * *", async () => {
  try {
    await runProductImportForAllTenants();
  } catch (err) {
    console.error("Product import cron error:", err);
  }
});

cron.schedule("*/5 * * * *", async () => {
  try {
    await syncInventoryToChannelsForAllTenants();
  } catch (err) {
    console.error("Inventory sync cron error:", err);
  }
});

cron.schedule("*/5 * * * *", async () => {
  try {
    await runPushPendingProductsForAllTenants();
    await runPushPendingProductsToDarazForAllTenants();
  } catch (err) {
    console.error("Push pending products cron error:", err);
  }
});

cron.schedule("*/15 * * * *", async () => {
  try {
    await scanZeroStockForAllTenants();
  } catch (err) {
    console.error("Stock alert scan cron error:", err);
  }
});

async function start() {
  await connectMongo();
  console.log("MongoDB connected");
  if (process.env.GOOGLE_CLIENT_ID) {
    console.log("Google OAuth: configured");
  }
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const geminiModel = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  if (geminiKey) {
    console.log("Gemini AI listings: configured (model: " + geminiModel + ")");
  } else {
    console.log("Gemini AI listings: not configured — set GEMINI_API_KEY in backend/.env");
  }
  console.log("Order import cron: every 5 minutes");
  console.log("Product import cron: every 5 minutes");
  console.log("Inventory sync cron: every 5 minutes");
  console.log("Push pending products cron: every 5 minutes");

  const port = config.port;
  const server = app.listen(port, () => {
    console.log("Server running on port " + port);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        "Port " + port + " is already in use. Stop the other process or set PORT to a different number."
      );
    } else {
      console.error("Server error:", err);
    }
    process.exit(1);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
