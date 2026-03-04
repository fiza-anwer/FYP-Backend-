import jwt from "jsonwebtoken";
import { config } from "../config.js";

/**
 * Verify JWT from Authorization: Bearer <token> or from cookie, set req.user and req.tenantName.
 */
export function authMiddleware(req, res, next) {
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
    req.user = payload;
    req.tenantName = payload.tenant_name || payload.tenantName || null;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
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
