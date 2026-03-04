/**
 * App config from environment (load env before requiring this).
 * Auth DB: use "auth" so one central auth database (tenants, users, carriers, integrations, etc.).
 * Set AUTH_DB_NAME in .env only if you need a different name.
 */
export const config = {
  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017",
  authDbName: process.env.AUTH_DB_NAME || "auth",
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
};
