import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb } from "../db/tenantDb.js";
import { config } from "../config.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

/**
 * POST /api/auth/signup
 * Body: { email, password, tenant_name }
 * Creates a pending tenant. Only tenants sign up; superadmin is created via migration.
 */
router.post("/signup", async (req, res) => {
  try {
    const { email, password, tenant_name } = req.body || {};
    const name = String(tenant_name || "").trim();
    const em = String(email || "").trim().toLowerCase();
    const pw = String(password || "");

    if (!name || !em || !pw) {
      return res.status(400).json({ error: "tenant_name, email and password are required" });
    }
    if (pw.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const db = await getAuthDb();
    const tenants = db.collection("tenants");
    const password_hash = bcrypt.hashSync(pw, 10);

    await tenants.insertOne({
      tenant_name: name,
      email: em,
      password_hash,
      status: "pending",
      created_at: new Date(),
      updated_at: new Date(),
    });
    return res.status(201).json({ message: "Signup successful. Wait for admin approval." });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: "Tenant name or email already registered" });
    }
    console.error("Signup error:", err);
    return res.status(500).json({ error: "Signup failed" });
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Returns JWT. No tenant name in request; backend determines superadmin vs tenant by email.
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const em = String(email || "").trim().toLowerCase();
    const pw = String(password || "");

    if (!em || !pw) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const db = await getAuthDb();
    const superadminsCol = db.collection("superadmins");
    const tenantsCol = db.collection("tenants");

    // 1) Superadmin (auth DB superadmins collection - use existing, do not create "users")
    const superadmin = await superadminsCol.findOne({ $or: [{ email: em }, { username: em }] });
    if (superadmin) {
      const hash = superadmin.password_hash || superadmin.password;
      const match = hash && (hash.startsWith("$2") ? bcrypt.compareSync(pw, hash) : hash === pw);
      if (!match) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      const token = jwt.sign(
        { email: em, role: "superadmin" },
        config.jwtSecret,
        { expiresIn: "7d" }
      );
      return res.json({ token, user: { email: em, role: "superadmin", isSuperadmin: true } });
    }

    // 2) Tenant (approved tenant with user in tenant DB)
    const tenant = await tenantsCol.findOne({ email: em, status: "approved" });
    if (!tenant) {
      return res.status(401).json({ error: "Invalid email or password or tenant not approved" });
    }
    const tenantDb = await getTenantDb(tenant.tenant_name);
    const tenantUsers = tenantDb.collection("users");
    const tenantUser = await tenantUsers.findOne({ email: em });
    if (!tenantUser || !tenantUser.password_hash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const match = bcrypt.compareSync(pw, tenantUser.password_hash);
    if (!match) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const token = jwt.sign(
      { email: em, role: "tenant", tenant_name: tenant.tenant_name },
      config.jwtSecret,
      { expiresIn: "7d" }
    );
    return res.json({
      token,
      user: {
        email: em,
        role: "tenant",
        tenant_name: tenant.tenant_name,
        isSuperadmin: false,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

/** Require JWT and role superadmin */
function superadminOnly(req, res, next) {
  if (req.user?.role !== "superadmin") {
    return res.status(403).json({ error: "Superadmin only" });
  }
  next();
}

/**
 * GET /api/auth/tenants
 * List all tenants (for superadmin). Requires JWT + superadmin.
 */
router.get("/tenants", authMiddleware, superadminOnly, async (req, res) => {
  try {
    const db = await getAuthDb();
    const list = await db
      .collection("tenants")
      .find({})
      .sort({ created_at: -1 })
      .project({ tenant_name: 1, email: 1, status: 1, created_at: 1 })
      .toArray();
    return res.json(list.map((t) => ({ ...t, id: t._id.toString() })));
  } catch (err) {
    console.error("List tenants error:", err);
    return res.status(500).json({ error: "Failed to list tenants" });
  }
});

/**
 * POST /api/auth/tenants/:id/approve
 * Approve tenant and create tenant DB + admin user. Requires JWT + superadmin.
 */
router.post("/tenants/:id/approve", authMiddleware, superadminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid tenant id" });
    }
    const db = await getAuthDb();
    const tenants = db.collection("tenants");
    const tenant = await tenants.findOne({ _id: new ObjectId(id) });
    if (!tenant) {
      return res.status(404).json({ error: "Tenant not found" });
    }
    if (tenant.status === "approved") {
      return res.json({ message: "Tenant already approved" });
    }

    await tenants.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "approved", updated_at: new Date() } }
    );

    // Create tenant DB and users collection with admin user
    const tenantDb = await getTenantDb(tenant.tenant_name);
    const tenantUsers = tenantDb.collection("users");
    const existing = await tenantUsers.findOne({ email: tenant.email });
    if (!existing) {
      await tenantUsers.insertOne({
        email: tenant.email,
        password_hash: tenant.password_hash,
        role: "admin",
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
    return res.json({ message: "Tenant approved" });
  } catch (err) {
    console.error("Approve tenant error:", err);
    return res.status(500).json({ error: "Failed to approve tenant" });
  }
});

/**
 * POST /api/auth/tenants/:id/reject
 * Reject tenant. Requires JWT + superadmin.
 */
router.post("/tenants/:id/reject", authMiddleware, superadminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid tenant id" });
    }
    const db = await getAuthDb();
    const result = await db
      .collection("tenants")
      .updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "rejected", updated_at: new Date() } }
      );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Tenant not found" });
    }
    return res.json({ message: "Tenant rejected" });
  } catch (err) {
    console.error("Reject tenant error:", err);
    return res.status(500).json({ error: "Failed to reject tenant" });
  }
});

export default router;
