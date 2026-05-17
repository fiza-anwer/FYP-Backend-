/**
 * App config from environment (load env before requiring this).
 * Auth DB: use "auth" so one central auth database (tenants, users, carriers, integrations, etc.).
 * Set AUTH_DB_NAME in .env only if you need a different name.
 */
export const config = {
  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://localhost:27017",
  authDbName: process.env.AUTH_DB_NAME || process.env.MONGODB_AUTH_DB || "auth",
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpSecure: process.env.SMTP_SECURE === "true",
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || "noreply@unisell.local",
};
