import "./loadEnv.js";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import cron from "node-cron";
import { connectMongo } from "./db/mongo.js";
import { config } from "./config.js";
import tenantRouter from "./routes/tenant.js";
import authRouter from "./routes/auth.js";
import { runOrderImportForAllTenants } from "./services/orderImportService.js";
import { runProductImportForAllTenants } from "./services/productImportService.js";

const app = express();

app.use(
  cors({
    origin: config.frontendOrigin,
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRouter);
app.use("/api/tenant", tenantRouter);

// Order import cron: every 5 minutes
cron.schedule("*/5 * * * *", async () => {
  try {
    await runOrderImportForAllTenants();
  } catch (err) {
    console.error("Order import cron error:", err);
  }
});

// Product import cron: every 5 minutes
cron.schedule("*/5 * * * *", async () => {
  try {
    await runProductImportForAllTenants();
  } catch (err) {
    console.error("Product import cron error:", err);
  }
});

async function start() {
  await connectMongo();
  console.log("MongoDB connected");
  if (process.env.GOOGLE_CLIENT_ID) {
    console.log("Google OAuth: configured");
  }
  console.log("Order import cron: every 5 minutes");
  console.log("Product import cron: every 5 minutes");
  const server = app.listen(config.port, () => {
    console.log("Server running on http://localhost:" + config.port);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error("Port " + config.port + " is already in use. Stop the other process or set PORT to a different number.");
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
