import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { getAuthDb } from "../db/authDb.js";

/**
 * Verify JWT from Authorization: Bearer <token> or from cookie, set req.user and req.tenantName.
 */
export async function authMiddleware(req, res, next) {
  const token =
    req.cookies?.token ||
    (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : null);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (!payload.jti || !payload.sub) {
      return res.status(401).json({ error: "Session expired. Please sign in again." });
    }
    const db = await getAuthDb();
    const session = await db.collection("auth_sessions").findOneAndUpdate(
      {
        _id: payload.jti,
        user_key: payload.sub,
        expires_at: { $gt: new Date() },
        revoked_at: { $exists: false },
      },
      { $set: { last_seen_at: new Date() } },
      { returnDocument: "after" }
    );
    if (!session) {
      return res.status(401).json({ error: "Session expired. Please sign in again." });
    }
    req.user = payload;
    req.tenantName = payload.tenant_name || payload.tenantName || null;
    next();
  } catch (err) {
    console.error("Authentication session validation error:", err);
    return res.status(err.name === "JsonWebTokenError" || err.name === "TokenExpiredError" ? 401 : 503)
      .json({ error: err.name === "JsonWebTokenError" || err.name === "TokenExpiredError" ? "Unauthorized" : "Authentication service unavailable" });
  }
}

/**
 * Require tenant context (tenant user, not superadmin-only). Reject if no tenant name.
 */
export function tenantOnly(req, res, next) {
  if (!req.tenantName) {
    return res.status(403).json({ error: "Tenant context required" });
  }
  next();
}
