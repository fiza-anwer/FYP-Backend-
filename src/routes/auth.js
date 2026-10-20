import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { getAuthDb } from "../db/authDb.js";
import { getTenantDb } from "../db/tenantDb.js";
import { config } from "../config.js";
import { authMiddleware } from "../middleware/auth.js";
import { getStockAlertSummaryForTenant } from "../services/stockAlertService.js";
import {
  createAuthenticatedSession,
  createToken,
  hashToken,
  sendAccountEmail,
  passwordFeedback,
  createTotpSecret,
  authenticatorUri,
  encryptSecret,
  decryptSecret,
  verifyTotp,
  totpCounterForCode,
} from "../services/accountSecurityService.js";

const router = Router();
const PASSWORD_ATTEMPT_LIMIT = 5;
const PASSWORD_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const SUPPORT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const SUPPORT_CATEGORIES = new Set(["Account", "Product", "Order", "Integration", "Other"]);
const SUPPORT_PRIORITIES = new Set(["Low", "Normal", "High", "Urgent"]);
const SUPPORT_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

async function passwordAttemptCount(db, key) {
  const record = await db.collection("security_attempts").findOne({ _id: key });
  if (!record || Date.now() - new Date(record.window_started_at).getTime() >= PASSWORD_ATTEMPT_WINDOW_MS) return 0;
  return record.count || 0;
}

async function recordPasswordFailure(db, key) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - PASSWORD_ATTEMPT_WINDOW_MS);
  await db.collection("security_attempts").updateOne(
    { _id: key },
    [{
      $set: {
        window_started_at: {
          $cond: [{ $gt: ["$window_started_at", cutoff] }, "$window_started_at", now],
        },
        count: {
          $cond: [
            { $gt: ["$window_started_at", cutoff] },
            { $add: [{ $ifNull: ["$count", 0] }, 1] },
            1,
          ],
        },
      },
    }],
    { upsert: true }
  );
}

async function consumeSupportRateLimit(db, userKey, action, limit) {
  const key = hashToken(`support:${action}:${userKey}`);
  const now = new Date();
  const cutoff = new Date(now.getTime() - PASSWORD_ATTEMPT_WINDOW_MS);
  const record = await db.collection("support_rate_limits").findOneAndUpdate(
    { _id: key },
    [{
      $set: {
        window_started_at: {
          $cond: [{ $gt: ["$window_started_at", cutoff] }, "$window_started_at", now],
        },
        count: {
          $cond: [
            { $gt: ["$window_started_at", cutoff] },
            { $add: [{ $ifNull: ["$count", 0] }, 1] },
            1,
          ],
        },
      },
    }],
    { upsert: true, returnDocument: "after" }
  );
  if (record.count > limit) {
    return Math.max(
      1,
      Math.ceil((PASSWORD_ATTEMPT_WINDOW_MS - (now.getTime() - new Date(record.window_started_at).getTime())) / 60000)
    );
  }
  return 0;
}

function normalizeSupportAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") return null;
  const name = String(attachment.name || "").replace(/[^\w.\- ()]/g, "_").slice(0, 120);
  const contentType = String(attachment.content_type || "");
  const base64 = String(attachment.data || "");
  if (!name || !SUPPORT_ATTACHMENT_TYPES.has(contentType)) {
    throw new Error("Attachment must be a PNG, JPEG, WebP, or PDF file.");
  }
  const encoded = base64.replace(/^data:[^,]+;base64,/, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Attachment encoding is invalid.");
  const size = Buffer.from(encoded, "base64").length;
  if (size === 0 || size > SUPPORT_UPLOAD_MAX_BYTES) {
    throw new Error("Attachment must be smaller than 5 MB.");
  }
  return { name, content_type: contentType, size, data: encoded };
}

async function findAccountByUserKey(db, userKey) {
  if (userKey.startsWith("superadmin:")) {
    const id = userKey.slice("superadmin:".length);
    if (!ObjectId.isValid(id)) return null;
    const collection = db.collection("superadmins");
    const account = await collection.findOne({ _id: new ObjectId(id) });
    return account ? { account, collection, role: "superadmin" } : null;
  }
  if (userKey.startsWith("tenant:")) {
    const separator = userKey.lastIndexOf(":");
    const tenantName = userKey.slice("tenant:".length, separator);
    const id = userKey.slice(separator + 1);
    if (!tenantName || !ObjectId.isValid(id)) return null;
    const tenantDb = await getTenantDb(tenantName);
    const collection = tenantDb.collection("users");
    const account = await collection.findOne({ _id: new ObjectId(id) });
    return account ? { account, collection, role: "tenant", tenantName } : null;
  }
  return null;
}

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
    const passwordError = passwordFeedback(pw);
    if (passwordError) return res.status(400).json({ error: passwordError });

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
      if (superadmin.two_factor_enabled) {
        const challengeToken = jwt.sign(
          { email: em, role: "superadmin", purpose: "login_2fa" },
          config.jwtSecret,
          { expiresIn: "5m" }
        );
        return res.json({ requires_two_factor: true, challenge_token: challengeToken });
      }
      const userKey = `superadmin:${superadmin._id}`;
      const session = await createAuthenticatedSession(db, req, userKey, { email: em, role: "superadmin" });
      await superadminsCol.updateOne({ _id: superadmin._id }, { $set: { last_login_at: new Date() } });
      return res.json({
        token: session.token,
        user: {
          email: em,
          name: superadmin.name || superadmin.username || em,
          avatar: superadmin.avatar || "",
          role: "superadmin",
          member_since: superadmin.created_at || null,
          last_login_at: new Date(),
          email_verified: superadmin.email_verified === true,
          isSuperadmin: true,
        },
      });
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
    if (tenantUser.two_factor_enabled) {
      const challengeToken = jwt.sign(
        { email: em, role: "tenant", tenant_name: tenant.tenant_name, purpose: "login_2fa" },
        config.jwtSecret,
        { expiresIn: "5m" }
      );
      return res.json({ requires_two_factor: true, challenge_token: challengeToken });
    }
    const userKey = `tenant:${tenant.tenant_name}:${tenantUser._id}`;
    const session = await createAuthenticatedSession(db, req, userKey, {
      email: em,
      role: "tenant",
      tenant_name: tenant.tenant_name,
    });
    const lastLoginAt = new Date();
    await tenantUsers.updateOne({ _id: tenantUser._id }, { $set: { last_login_at: lastLoginAt } });
    let stock_alerts = { count: 0, alerts: [], email_configured: false };
    try {
      stock_alerts = await getStockAlertSummaryForTenant(tenantDb);
    } catch (alertErr) {
      console.warn("[Login] stock alerts:", alertErr.message);
    }
    return res.json({
      token: session.token,
      user: {
        email: em,
        name: tenantUser.name || tenant.tenant_name,
        avatar: tenantUser.avatar || "",
        role: "tenant",
        tenant_name: tenant.tenant_name,
        member_since: tenantUser.created_at || tenant.created_at || null,
        last_login_at: lastLoginAt,
        email_verified: tenantUser.email_verified === true,
        isSuperadmin: false,
      },
      stock_alerts,
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

router.post("/two-factor/login", async (req, res) => {
  try {
    const challenge = jwt.verify(String(req.body?.challenge_token || ""), config.jwtSecret);
    if (challenge.purpose !== "login_2fa") return res.status(401).json({ error: "Invalid sign-in challenge" });
    const db = await getAuthDb();
    let account;
    let tenant;
    let tenantDb;
    let collection;
    if (challenge.role === "superadmin") {
      collection = db.collection("superadmins");
      account = await collection.findOne({
        $or: [{ email: challenge.email }, { username: challenge.email }],
      });
    } else if (challenge.role === "tenant" && challenge.tenant_name) {
      tenant = await db.collection("tenants").findOne({
        tenant_name: challenge.tenant_name,
        email: challenge.email,
        status: "approved",
      });
      if (tenant) {
        tenantDb = await getTenantDb(tenant.tenant_name);
        collection = tenantDb.collection("users");
        account = await collection.findOne({ email: challenge.email });
      }
    }
    if (!account?.two_factor_enabled || !account.two_factor_secret) {
      return res.status(401).json({ error: "Two-factor authentication is not enabled for this account" });
    }
    const userKey = challenge.role === "superadmin"
      ? `superadmin:${account._id}`
      : `tenant:${tenant.tenant_name}:${account._id}`;
    const attemptKey = hashToken(`2fa:${userKey}`);
    if (await passwordAttemptCount(db, attemptKey) >= PASSWORD_ATTEMPT_LIMIT) {
      return res.status(429).json({ error: "Too many incorrect verification codes. Try again in 15 minutes." });
    }
    const codeCounter = totpCounterForCode(decryptSecret(account.two_factor_secret), String(req.body?.code || ""));
    if (codeCounter === null) {
      await recordPasswordFailure(db, attemptKey);
      return res.status(401).json({ error: "Invalid verification code" });
    }
    const consumeCode = await collection.updateOne(
      {
        _id: account._id,
        $or: [
          { two_factor_last_counter: { $lt: codeCounter } },
          { two_factor_last_counter: { $exists: false } },
        ],
      },
      { $set: { two_factor_last_counter: codeCounter } }
    );
    if (consumeCode.matchedCount === 0) {
      await recordPasswordFailure(db, attemptKey);
      return res.status(401).json({ error: "This verification code has already been used" });
    }
    await db.collection("security_attempts").deleteOne({ _id: attemptKey });
    const session = await createAuthenticatedSession(db, req, userKey, {
      email: challenge.email,
      role: challenge.role,
      ...(tenant ? { tenant_name: tenant.tenant_name } : {}),
    });
    const lastLoginAt = new Date();
    await collection.updateOne({ _id: account._id }, { $set: { last_login_at: lastLoginAt } });
    const user = {
      email: challenge.email,
      name: account.name || tenant?.tenant_name || account.username || challenge.email,
      avatar: account.avatar || "",
      role: challenge.role,
      member_since: account.created_at || tenant?.created_at || null,
      last_login_at: lastLoginAt,
      email_verified: account.email_verified === true,
      isSuperadmin: challenge.role === "superadmin",
      ...(tenant ? { tenant_name: tenant.tenant_name } : {}),
    };
    let stock_alerts;
    if (tenantDb) {
      try {
        stock_alerts = await getStockAlertSummaryForTenant(tenantDb);
      } catch (alertErr) {
        console.warn("[Two-factor login] stock alerts:", alertErr.message);
      }
    }
    return res.json({ token: session.token, user, stock_alerts });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Sign-in challenge expired. Please sign in again." });
    }
    console.error("Two-factor sign-in error:", err);
    return res.status(500).json({ error: "Two-factor sign-in failed" });
  }
});

router.post("/two-factor/setup", authMiddleware, async (req, res) => {
  try {
    const db = await getAuthDb();
    const accountData = await findAccountByUserKey(db, req.user.sub);
    if (!accountData) return res.status(404).json({ error: "Account not found" });
    if (accountData.account.two_factor_enabled) {
      return res.status(409).json({ error: "Two-factor authentication is already enabled" });
    }
    const secret = createTotpSecret();
    await accountData.collection.updateOne(
      { _id: accountData.account._id },
      {
        $set: {
          two_factor_setup_secret: encryptSecret(secret),
          two_factor_setup_expires_at: new Date(Date.now() + 10 * 60 * 1000),
        },
      }
    );
    return res.json({
      secret,
      otpauth_url: authenticatorUri(secret, accountData.account.email || req.user.email),
    });
  } catch (err) {
    console.error("Two-factor setup error:", err);
    return res.status(500).json({ error: "Unable to start two-factor setup" });
  }
});

router.post("/two-factor/enable", authMiddleware, async (req, res) => {
  try {
    const db = await getAuthDb();
    const accountData = await findAccountByUserKey(db, req.user.sub);
    if (!accountData) return res.status(404).json({ error: "Account not found" });
    const account = accountData.account;
    if (
      !account.two_factor_setup_secret ||
      !account.two_factor_setup_expires_at ||
      account.two_factor_setup_expires_at <= new Date()
    ) {
      return res.status(400).json({ error: "Two-factor setup expired. Start setup again." });
    }
    const secret = decryptSecret(account.two_factor_setup_secret);
    const codeCounter = totpCounterForCode(secret, String(req.body?.code || ""));
    if (codeCounter === null) {
      return res.status(400).json({ error: "Invalid authenticator code" });
    }
    await accountData.collection.updateOne(
      { _id: account._id },
      {
        $set: {
          two_factor_enabled: true,
          two_factor_secret: account.two_factor_setup_secret,
          two_factor_last_counter: codeCounter,
        },
        $unset: { two_factor_setup_secret: "", two_factor_setup_expires_at: "" },
      }
    );
    return res.json({ message: "Two-factor authentication enabled." });
  } catch (err) {
    console.error("Enable two-factor error:", err);
    return res.status(500).json({ error: "Unable to enable two-factor authentication" });
  }
});

router.post("/two-factor/disable", authMiddleware, async (req, res) => {
  try {
    const db = await getAuthDb();
    const accountData = await findAccountByUserKey(db, req.user.sub);
    if (!accountData) return res.status(404).json({ error: "Account not found" });
    const { account, collection } = accountData;
    const attemptKey = hashToken(`2fa-disable:${req.user.sub}`);
    if (await passwordAttemptCount(db, attemptKey) >= PASSWORD_ATTEMPT_LIMIT) {
      return res.status(429).json({ error: "Too many incorrect attempts. Try again in 15 minutes." });
    }
    const hash = account.password_hash || account.password;
    const passwordValid = typeof hash === "string" && (
      hash.startsWith("$2") ? bcrypt.compareSync(String(req.body?.current_password || ""), hash)
        : hash === String(req.body?.current_password || "")
    );
    const codeValid = account.two_factor_secret &&
      verifyTotp(decryptSecret(account.two_factor_secret), String(req.body?.code || ""));
    if (!passwordValid || !codeValid) {
      await recordPasswordFailure(db, attemptKey);
      return res.status(400).json({ error: "Current password or authenticator code is incorrect" });
    }
    await db.collection("security_attempts").deleteOne({ _id: attemptKey });
    await collection.updateOne(
      { _id: account._id },
      {
        $set: { two_factor_enabled: false },
        $unset: {
          two_factor_secret: "",
          two_factor_setup_secret: "",
          two_factor_last_counter: "",
        },
      }
    );
    return res.json({ message: "Two-factor authentication disabled." });
  } catch (err) {
    console.error("Disable two-factor error:", err);
    return res.status(500).json({ error: "Unable to disable two-factor authentication" });
  }
});

router.get("/sessions", authMiddleware, async (req, res) => {
  try {
    const db = await getAuthDb();
    const sessions = await db.collection("auth_sessions")
      .find({ user_key: req.user.sub, expires_at: { $gt: new Date() }, revoked_at: { $exists: false } })
      .sort({ last_seen_at: -1 })
      .project({ user_agent: 1, ip_address: 1, created_at: 1, last_seen_at: 1, expires_at: 1 })
      .toArray();
    return res.json(sessions.map((session) => ({
      id: session._id,
      user_agent: session.user_agent,
      ip_address: session.ip_address,
      created_at: session.created_at,
      last_seen_at: session.last_seen_at,
      expires_at: session.expires_at,
      current: session._id === req.user.jti,
    })));
  } catch (err) {
    console.error("List sessions error:", err);
    return res.status(500).json({ error: "Unable to load active sessions" });
  }
});

router.delete("/sessions/others", authMiddleware, async (req, res) => {
  try {
    const db = await getAuthDb();
    const result = await db.collection("auth_sessions").deleteMany({
      user_key: req.user.sub,
      _id: { $ne: req.user.jti },
    });
    return res.json({ revoked: result.deletedCount });
  } catch (err) {
    console.error("Revoke sessions error:", err);
    return res.status(500).json({ error: "Unable to sign out other sessions" });
  }
});

router.delete("/sessions/current", authMiddleware, async (req, res) => {
  try {
    const db = await getAuthDb();
    await db.collection("auth_sessions").deleteOne({ _id: req.user.jti, user_key: req.user.sub });
    return res.json({ message: "Signed out." });
  } catch (err) {
    console.error("Revoke current session error:", err);
    return res.status(500).json({ error: "Unable to end this session" });
  }
});

router.get("/support/config", authMiddleware, async (req, res) => {
  try {
    const db = await getAuthDb();
    const accountData = await findAccountByUserKey(db, req.user.sub);
    if (!accountData) return res.status(404).json({ error: "Account not found" });
    let tenantId = "";
    if (accountData.role === "tenant") {
      const tenant = await db.collection("tenants").findOne({ tenant_name: accountData.tenantName });
      tenantId = tenant?._id?.toString() || "";
    }
    return res.json({
      email: accountData.account.email || req.user.email,
      account_type: accountData.role === "superadmin" ? "Superadmin" : "Tenant",
      tenant_id: tenantId,
      app_version: config.appVersion,
      contact: {
        email: config.supportEmail,
        phone: config.supportPhone,
        whatsapp: config.supportWhatsapp,
        hours: config.supportHours,
      },
      expected_response: config.supportExpectedResponse,
    });
  } catch (err) {
    console.error("Support context error:", err);
    return res.status(500).json({ error: "Unable to load support information" });
  }
});

router.get("/support/tickets", authMiddleware, async (req, res) => {
  try {
    const db = await getAuthDb();
    const tickets = await db.collection("support_tickets")
      .find({ user_key: req.user.sub })
      .sort({ updated_at: -1 })
      .limit(100)
      .project({ attachment: 0 })
      .toArray();
    return res.json(tickets.map((ticket) => ({
      id: ticket._id.toString(),
      ticket_number: ticket.ticket_number,
      subject: ticket.subject,
      category: ticket.category,
      priority: ticket.priority,
      description: ticket.description,
      status: ticket.status,
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      attachment: ticket.attachment
        ? { name: ticket.attachment.name, content_type: ticket.attachment.content_type, size: ticket.attachment.size }
        : null,
      replies: (ticket.replies || []).map((reply) => ({
        message: reply.message,
        author: reply.author,
        created_at: reply.created_at,
      })),
    })));
  } catch (err) {
    console.error("List support tickets error:", err);
    return res.status(500).json({ error: "Unable to load support tickets" });
  }
});

router.post("/support/tickets", authMiddleware, async (req, res) => {
  try {
    if (String(req.body?.website || "").trim()) {
      return res.status(400).json({ error: "Unable to submit support request" });
    }
    const db = await getAuthDb();
    const accountData = await findAccountByUserKey(db, req.user.sub);
    if (!accountData) return res.status(404).json({ error: "Account not found" });
    const retryMinutes = await consumeSupportRateLimit(db, req.user.sub, "create", 3);
    if (retryMinutes) {
      return res.status(429).json({ error: `Too many requests. Try again in ${retryMinutes} minute(s).` });
    }

    const subject = String(req.body?.subject || "").trim();
    const category = String(req.body?.category || "");
    const priority = String(req.body?.priority || "");
    const description = String(req.body?.description || "").trim();
    if (!subject || subject.length > 160 || !description || description.length > 10000) {
      return res.status(400).json({ error: "Subject (up to 160 characters) and description (up to 10,000 characters) are required." });
    }
    if (!SUPPORT_CATEGORIES.has(category) || !SUPPORT_PRIORITIES.has(priority)) {
      return res.status(400).json({ error: "Choose a valid category and priority." });
    }
    let attachment;
    try {
      attachment = normalizeSupportAttachment(req.body?.attachment);
    } catch (attachmentError) {
      return res.status(400).json({ error: attachmentError.message });
    }

    const now = new Date();
    const ticketNumber = `US-${now.toISOString().slice(2, 10).replace(/-/g, "")}-${createToken().slice(0, 6).toUpperCase()}`;
    const ticket = {
      ticket_number: ticketNumber,
      user_key: req.user.sub,
      account_email: accountData.account.email || req.user.email,
      account_type: accountData.role,
      tenant_id: accountData.role === "tenant"
        ? (await db.collection("tenants").findOne({ tenant_name: accountData.tenantName }))?._id?.toString() || ""
        : "",
      subject,
      category,
      priority,
      description,
      status: "Open",
      attachment,
      replies: [],
      created_at: now,
      updated_at: now,
    };
    const result = await db.collection("support_tickets").insertOne(ticket);

    const ticketText = `Ticket: ${ticketNumber}\nSubject: ${subject}\nCategory: ${category}\nPriority: ${priority}\n\n${description}`;
    const ticketHtml = `<p><strong>Ticket:</strong> ${ticketNumber}<br/><strong>Subject:</strong> ${escapeHtml(subject)}<br/><strong>Category:</strong> ${escapeHtml(category)}<br/><strong>Priority:</strong> ${escapeHtml(priority)}</p><p>${escapeHtml(description).replace(/\n/g, "<br/>")}</p>`;
    let emailSent = true;
    try {
      await sendAccountEmail({
        to: ticket.account_email,
        subject: `[UniSell Support ${ticketNumber}] Request received`,
        text: `We received your support request.\n\n${ticketText}`,
        html: `<p>We received your support request.</p>${ticketHtml}`,
      });
    } catch (mailError) {
      emailSent = false;
      console.error("Support ticket email copy failed:", mailError);
    }
    let supportNotified = false;
    if (config.supportEmail) {
      try {
        await sendAccountEmail({
          to: config.supportEmail,
          subject: `[UniSell Support ${ticketNumber}] ${subject}`,
          text: `New customer support request from ${ticket.account_email}.\n\n${ticketText}`,
          html: `<p>New customer support request from ${escapeHtml(ticket.account_email)}.</p>${ticketHtml}`,
        });
        supportNotified = true;
      } catch (mailError) {
        console.error("Support team notification failed:", mailError);
      }
    }
    return res.status(201).json({
      id: result.insertedId.toString(),
      ticket_number: ticketNumber,
      status: "Open",
      email_sent: emailSent,
      support_notified: supportNotified,
      support_configured: Boolean(config.supportEmail),
    });
  } catch (err) {
    console.error("Create support ticket error:", err);
    return res.status(500).json({ error: "Unable to create support ticket" });
  }
});

router.get("/support/admin/tickets", authMiddleware, async (req, res) => {
  try {
    const db = await getAuthDb();
    const accountData = await findAccountByUserKey(db, req.user.sub);
    if (accountData?.role !== "superadmin") return res.status(403).json({ error: "Support staff access required" });
    const tickets = await db.collection("support_tickets")
      .find({})
      .sort({ updated_at: -1 })
      .limit(200)
      .project({ attachment: 0 })
      .toArray();
    return res.json(tickets.map((ticket) => ({
      id: ticket._id.toString(),
      ticket_number: ticket.ticket_number,
      account_email: ticket.account_email,
      subject: ticket.subject,
      category: ticket.category,
      priority: ticket.priority,
      description: ticket.description,
      status: ticket.status,
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      attachment: ticket.attachment
        ? { name: ticket.attachment.name, content_type: ticket.attachment.content_type, size: ticket.attachment.size }
        : null,
      replies: (ticket.replies || []).map((reply) => ({
        message: reply.message,
        author: reply.author,
        created_at: reply.created_at,
      })),
    })));
  } catch (err) {
    console.error("List support inbox error:", err);
    return res.status(500).json({ error: "Unable to load support inbox" });
  }
});

router.patch("/support/admin/tickets/:id", authMiddleware, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid ticket id" });
    const status = String(req.body?.status || "");
    if (!["Open", "In progress", "Resolved"].includes(status)) {
      return res.status(400).json({ error: "Invalid ticket status" });
    }
    const db = await getAuthDb();
    const accountData = await findAccountByUserKey(db, req.user.sub);
    if (accountData?.role !== "superadmin") return res.status(403).json({ error: "Support staff access required" });
    const collection = db.collection("support_tickets");
    const result = await collection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status, updated_at: new Date() } }
    );
    if (!result.matchedCount) return res.status(404).json({ error: "Ticket not found" });
    const ticket = await collection.findOne({ _id: new ObjectId(req.params.id) });
    let emailSent = true;
    try {
      await sendAccountEmail({
        to: ticket.account_email,
        subject: `[UniSell Support ${ticket.ticket_number}] Status updated`,
        text: `The status of your support request "${ticket.subject}" is now ${status}.`,
        html: `<p>The status of your support request <strong>${escapeHtml(ticket.subject)}</strong> is now <strong>${escapeHtml(status)}</strong>.</p>`,
      });
    } catch (mailError) {
      emailSent = false;
      console.error("Support status email failed:", mailError);
    }
    return res.json({ message: "Ticket status updated.", email_sent: emailSent });
  } catch (err) {
    console.error("Update support ticket status error:", err);
    return res.status(500).json({ error: "Unable to update ticket status" });
  }
});

router.post("/support/admin/tickets/:id/replies", authMiddleware, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid ticket id" });
    const message = String(req.body?.message || "").trim();
    if (!message || message.length > 5000) {
      return res.status(400).json({ error: "Reply is required and must be no longer than 5,000 characters." });
    }
    const db = await getAuthDb();
    const accountData = await findAccountByUserKey(db, req.user.sub);
    if (accountData?.role !== "superadmin") return res.status(403).json({ error: "Support staff access required" });
    const collection = db.collection("support_tickets");
    const result = await collection.updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $push: {
          replies: {
            message,
            author: "Support",
            created_at: new Date(),
          },
        },
        $set: { updated_at: new Date() },
      }
    );
    if (!result.matchedCount) return res.status(404).json({ error: "Ticket not found" });
    const ticket = await collection.findOne({ _id: new ObjectId(req.params.id) });
    let emailSent = true;
    try {
      await sendAccountEmail({
        to: ticket.account_email,
        subject: `[UniSell Support ${ticket.ticket_number}] Support replied`,
        text: `Support replied to your request "${ticket.subject}":\n\n${message}`,
        html: `<p>Support replied to your request <strong>${escapeHtml(ticket.subject)}</strong>:</p><p>${escapeHtml(message).replace(/\n/g, "<br/>")}</p>`,
      });
    } catch (mailError) {
      emailSent = false;
      console.error("Support staff reply email failed:", mailError);
    }
    return res.status(201).json({ message: "Support reply added.", email_sent: emailSent });
  } catch (err) {
    console.error("Add support staff reply error:", err);
    return res.status(500).json({ error: "Unable to add support reply" });
  }
});

router.post("/support/tickets/:id/replies", authMiddleware, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid ticket id" });
    const message = String(req.body?.message || "").trim();
    if (!message || message.length > 5000) {
      return res.status(400).json({ error: "Reply is required and must be no longer than 5,000 characters." });
    }
    const db = await getAuthDb();
    const retryMinutes = await consumeSupportRateLimit(db, req.user.sub, "reply", 10);
    if (retryMinutes) {
      return res.status(429).json({ error: `Too many replies. Try again in ${retryMinutes} minute(s).` });
    }
    const collection = db.collection("support_tickets");
    const result = await collection.updateOne(
      { _id: new ObjectId(req.params.id), user_key: req.user.sub, status: { $ne: "Resolved" } },
      {
        $push: {
          replies: {
            message,
            author: "Customer",
            created_at: new Date(),
          },
        },
        $set: { updated_at: new Date() },
      }
    );
    if (!result.matchedCount) {
      const ticketExists = await collection.findOne({ _id: new ObjectId(req.params.id), user_key: req.user.sub }, { projection: { status: 1 } });
      return ticketExists
        ? res.status(409).json({ error: "This ticket is resolved and can no longer receive replies." })
        : res.status(404).json({ error: "Ticket not found" });
    }
    const ticket = await collection.findOne({ _id: new ObjectId(req.params.id), user_key: req.user.sub });
    let emailSent = true;
    try {
      await sendAccountEmail({
        to: ticket.account_email,
        subject: `[UniSell Support ${ticket.ticket_number}] Reply received`,
        text: `Your reply was added to support request ${ticket.ticket_number}.\n\n${message}`,
        html: `<p>Your reply was added to support request <strong>${escapeHtml(ticket.ticket_number)}</strong>.</p><p>${escapeHtml(message).replace(/\n/g, "<br/>")}</p>`,
      });
    } catch (mailError) {
      emailSent = false;
      console.error("Support reply email copy failed:", mailError);
    }
    let supportNotified = false;
    if (config.supportEmail) {
      try {
        await sendAccountEmail({
          to: config.supportEmail,
          subject: `[UniSell Support ${ticket.ticket_number}] Customer reply`,
          text: `Customer ${ticket.account_email} replied to ${ticket.ticket_number}:\n\n${message}`,
          html: `<p>Customer ${escapeHtml(ticket.account_email)} replied to <strong>${escapeHtml(ticket.ticket_number)}</strong>:</p><p>${escapeHtml(message).replace(/\n/g, "<br/>")}</p>`,
        });
        supportNotified = true;
      } catch (mailError) {
        console.error("Support reply notification failed:", mailError);
      }
    }
    return res.status(201).json({ message: "Reply added.", email_sent: emailSent, support_notified: supportNotified });
  } catch (err) {
    console.error("Support ticket reply error:", err);
    return res.status(500).json({ error: "Unable to add reply" });
  }
});

router.post("/email-change/:action", async (req, res) => {
  try {
    const { action } = req.params;
    const token = String(req.body?.token || "");
    if (!["confirm", "cancel", "rollback", "verify"].includes(action) || !token) {
      return res.status(400).json({ error: "Invalid email change link" });
    }
    const db = await getAuthDb();
    const tokenCollection = db.collection("email_change_tokens");
    const record = await tokenCollection.findOne({
      _id: hashToken(token),
      kind: action,
      expires_at: { $gt: new Date() },
    });
    if (!record) return res.status(400).json({ error: "This email link is invalid or has expired" });

    const accountData = await findAccountByUserKey(db, record.user_key);
    if (!accountData) return res.status(404).json({ error: "Account not found" });
    const { account, collection, role, tenantName } = accountData;

    if (action === "cancel") {
      await tokenCollection.deleteMany({
        user_key: record.user_key,
        kind: { $in: ["confirm", "cancel"] },
      });
      return res.json({ message: "The email change request was canceled. Your email has not changed." });
    }

    if (action === "verify") {
      if (record.kind !== "verify") return res.status(400).json({ error: "Invalid verification link" });
      await accountData.collection.updateOne(
        { _id: account._id },
        { $set: { email_verified: true, updated_at: new Date() } }
      );
      await tokenCollection.deleteOne({ _id: record._id });
      return res.json({ message: "Email address verified." });
    }

    if (action === "confirm") {
      const nextEmail = record.new_email;
      const [tenantConflict, superadminConflict] = await Promise.all([
        db.collection("tenants").findOne(
          role === "tenant" ? { email: nextEmail, tenant_name: { $ne: tenantName } } : { email: nextEmail }
        ),
        db.collection("superadmins").findOne({
          $or: [{ email: nextEmail }, { username: nextEmail }],
          ...(role === "superadmin" ? { _id: { $ne: account._id } } : {}),
        }),
      ]);
      if (tenantConflict || superadminConflict) {
        return res.status(409).json({ error: "That email address is already in use" });
      }
      const update = { email: nextEmail, email_verified: true, updated_at: new Date() };
      if (role === "superadmin" && account.username?.toLowerCase() === record.old_email) {
        update.username = nextEmail;
      }
      if (role === "tenant") {
        const tenants = db.collection("tenants");
        const centralUpdate = await tenants.updateOne(
          { tenant_name: tenantName },
          { $set: { email: nextEmail, updated_at: new Date() } }
        );
        if (centralUpdate.matchedCount === 0) return res.status(404).json({ error: "Tenant account not found" });
        try {
          await collection.updateOne({ _id: account._id }, { $set: update });
        } catch (accountUpdateError) {
          await tenants.updateOne(
            { tenant_name: tenantName },
            { $set: { email: record.old_email, updated_at: new Date() } }
          );
          throw accountUpdateError;
        }
      } else {
        await collection.updateOne({ _id: account._id }, { $set: update });
      }
      await tokenCollection.deleteMany({
        user_key: record.user_key,
        kind: { $in: ["confirm", "cancel"] },
      });
      await db.collection("auth_sessions").deleteMany({ user_key: record.user_key });
      const rollbackToken = createToken();
      await tokenCollection.insertOne({
        _id: hashToken(rollbackToken),
        user_key: record.user_key,
        kind: "rollback",
        old_email: record.old_email,
        new_email: nextEmail,
        was_verified: account.email_verified === true,
        created_at: new Date(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      const rollbackUrl = `${config.frontendOrigin.replace(/\/$/, "")}/email-change?token=${encodeURIComponent(rollbackToken)}&action=rollback`;
      let noticeSent = true;
      try {
        await sendAccountEmail({
          to: record.old_email,
          subject: "[UniSell] Your email address was changed",
          text: `Your UniSell email address was changed to ${nextEmail}. If this wasn't you, revert the change within 24 hours: ${rollbackUrl}`,
          html: `<p>Your UniSell email address was changed to <strong>${escapeHtml(nextEmail)}</strong>.</p><p>If this wasn't you, <a href="${rollbackUrl}">click here to revert the email change</a> within 24 hours.</p>`,
        });
      } catch (mailError) {
        noticeSent = false;
        console.error("Email change security notice failed:", mailError);
      }
      return res.json({
        message: "Email address confirmed. Sign in again using your new email address.",
        email: nextEmail,
        security_notice_sent: noticeSent,
      });
    }

    if (account.email?.toLowerCase() !== record.new_email) {
      await tokenCollection.deleteOne({ _id: record._id });
      return res.status(409).json({ error: "This email change can no longer be reverted" });
    }
    const [oldTenantConflict, oldSuperadminConflict] = await Promise.all([
      db.collection("tenants").findOne(
        role === "tenant" ? { email: record.old_email, tenant_name: { $ne: tenantName } } : { email: record.old_email }
      ),
      db.collection("superadmins").findOne({
        $or: [{ email: record.old_email }, { username: record.old_email }],
        ...(role === "superadmin" ? { _id: { $ne: account._id } } : {}),
      }),
    ]);
    if (oldTenantConflict || oldSuperadminConflict) {
      return res.status(409).json({ error: "The previous email address is now in use and cannot be restored automatically." });
    }
    if (role === "tenant") {
      const tenants = db.collection("tenants");
      const centralUpdate = await tenants.updateOne(
        { tenant_name: tenantName },
        { $set: { email: record.old_email, updated_at: new Date() } }
      );
      if (centralUpdate.matchedCount === 0) return res.status(404).json({ error: "Tenant account not found" });
      try {
        await collection.updateOne(
          { _id: account._id },
          {
            $set: {
              email: record.old_email,
              email_verified: record.was_verified === true,
              updated_at: new Date(),
            },
          }
        );
      } catch (accountUpdateError) {
        await tenants.updateOne(
          { tenant_name: tenantName },
          { $set: { email: record.new_email, updated_at: new Date() } }
        );
        throw accountUpdateError;
      }
    } else if (account.username?.toLowerCase() === record.new_email) {
      await collection.updateOne(
        { _id: account._id },
        { $set: { email: record.old_email, username: record.old_email, email_verified: record.was_verified === true, updated_at: new Date() } }
      );
    } else {
      await collection.updateOne(
        { _id: account._id },
        { $set: { email: record.old_email, email_verified: record.was_verified === true, updated_at: new Date() } }
      );
    }
    await tokenCollection.deleteOne({ _id: record._id });
    await db.collection("auth_sessions").deleteMany({ user_key: record.user_key });
    return res.json({ message: "Email change reverted. Sign in again using your previous email address." });
  } catch (err) {
    console.error("Email change confirmation error:", err);
    return res.status(500).json({ error: "Unable to process email change link" });
  }
});

router.post("/email-verification", authMiddleware, async (req, res) => {
  try {
    const db = await getAuthDb();
    const accountData = await findAccountByUserKey(db, req.user.sub);
    if (!accountData) return res.status(404).json({ error: "Account not found" });
    const { account } = accountData;
    if (account.email_verified === true) return res.json({ message: "Email address is already verified" });
    const token = createToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const collection = db.collection("email_change_tokens");
    await collection.deleteMany({ user_key: req.user.sub, kind: "verify" });
    await collection.insertOne({
      _id: hashToken(token),
      user_key: req.user.sub,
      kind: "verify",
      created_at: new Date(),
      expires_at: expiresAt,
    });
    const verifyUrl = `${config.frontendOrigin.replace(/\/$/, "")}/email-change?token=${encodeURIComponent(token)}&action=verify`;
    await sendAccountEmail({
      to: account.email || req.user.email,
      subject: "[UniSell] Verify your email address",
      text: `Verify your UniSell email address: ${verifyUrl}\nThis link expires in 1 hour.`,
      html: `<p><a href="${verifyUrl}">Verify your email address</a></p><p>This link expires in 1 hour.</p>`,
    });
    return res.json({ message: "Verification email sent." });
  } catch (err) {
    console.error("Email verification request error:", err);
    return res.status(500).json({ error: "Unable to send verification email. Check backend email configuration." });
  }
});

/**
 * GET /api/auth/profile
 * Return the authenticated user's editable profile fields.
 */
router.get("/profile", authMiddleware, async (req, res) => {
  try {
    const db = await getAuthDb();
    if (req.user?.role === "superadmin") {
      const account = await db.collection("superadmins").findOne({
        $or: [{ email: req.user.email }, { username: req.user.email }],
      });
      if (!account) return res.status(404).json({ error: "Account not found" });
      const pendingEmail = await db.collection("email_change_tokens").findOne({
        user_key: req.user.sub,
        kind: "confirm",
        expires_at: { $gt: new Date() },
      });
      return res.json({
        user: {
          email: account.email || req.user.email,
          name: account.name || account.username || account.email || req.user.email,
          avatar: account.avatar || "",
          role: "superadmin",
          member_since: account.created_at || null,
          last_login_at: account.last_login_at || null,
          email_verified: account.email_verified === true,
          two_factor_enabled: account.two_factor_enabled === true,
          pending_email: pendingEmail?.new_email || "",
        },
      });
    }

    if (req.user?.role !== "tenant" || !req.user.tenant_name) {
      return res.status(403).json({ error: "Unsupported account type" });
    }
    const tenant = await db.collection("tenants").findOne({
      tenant_name: req.user.tenant_name,
      status: "approved",
    });
    if (!tenant) return res.status(404).json({ error: "Tenant account not found" });
    const tenantDb = await getTenantDb(tenant.tenant_name);
    const account = await tenantDb.collection("users").findOne({ email: req.user.email });
    if (!account) return res.status(404).json({ error: "Account not found" });
    const pendingEmail = await db.collection("email_change_tokens").findOne({
      user_key: req.user.sub,
      kind: "confirm",
      expires_at: { $gt: new Date() },
    });
    return res.json({
      user: {
        email: account.email,
        name: account.name || tenant.tenant_name,
        avatar: account.avatar || "",
        role: account.role || "tenant",
        tenant_name: tenant.tenant_name,
        member_since: account.created_at || tenant.created_at || null,
        last_login_at: account.last_login_at || null,
        email_verified: account.email_verified === true,
        two_factor_enabled: account.two_factor_enabled === true,
        pending_email: pendingEmail?.new_email || "",
      },
    });
  } catch (err) {
    console.error("Get profile error:", err);
    return res.status(500).json({ error: "Failed to load profile" });
  }
});

/**
 * PATCH /api/auth/profile
 * Update the authenticated user's name, email, password, or avatar.
 */
router.patch("/profile", authMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const allowedKeys = ["name", "email", "password", "current_password", "avatar"];
    if (Object.keys(body).some((key) => !allowedKeys.includes(key))) {
      return res.status(400).json({ error: "Unsupported profile field" });
    }

    const name = body.name === undefined ? undefined : String(body.name).trim();
    const email = body.email === undefined ? undefined : String(body.email).trim().toLowerCase();
    const password = body.password === undefined ? undefined : String(body.password);
    const currentPassword = body.current_password === undefined ? "" : String(body.current_password);
    const avatar = body.avatar === undefined ? undefined : body.avatar;

    if (name !== undefined && (!name || name.length > 100)) {
      return res.status(400).json({ error: "Name must be between 1 and 100 characters" });
    }
    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }
    const passwordError = password === undefined ? "" : passwordFeedback(password);
    if (passwordError) return res.status(400).json({ error: passwordError });
    if (
      avatar !== undefined &&
      avatar !== null &&
      avatar !== "" &&
      (typeof avatar !== "string" ||
        !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar) ||
        avatar.length > 1400000)
    ) {
      return res.status(400).json({ error: "Avatar must be a PNG, JPEG, or WebP image up to 1 MB" });
    }
    if (name === undefined && email === undefined && password === undefined && avatar === undefined) {
      return res.status(400).json({ error: "No profile changes provided" });
    }

    const db = await getAuthDb();
    const superadmin = req.user?.role === "superadmin";
    let account;
    let tenant;
    let accountCollection;
    let emailChanged = false;

    if (superadmin) {
      accountCollection = db.collection("superadmins");
      account = await accountCollection.findOne({
        $or: [{ email: req.user.email }, { username: req.user.email }],
      });
    } else if (req.user?.role === "tenant" && req.user.tenant_name) {
      tenant = await db.collection("tenants").findOne({
        tenant_name: req.user.tenant_name,
        status: "approved",
      });
      if (tenant) {
        const tenantDb = await getTenantDb(tenant.tenant_name);
        accountCollection = tenantDb.collection("users");
        account = await accountCollection.findOne({ email: req.user.email });
      }
    } else {
      return res.status(403).json({ error: "Unsupported account type" });
    }
    if (!account) return res.status(404).json({ error: "Account not found" });

    const currentEmail = String(account.email || req.user.email).toLowerCase();
    emailChanged = email !== undefined && email !== currentEmail;
    const passwordChanged = password !== undefined;
    if ((emailChanged || passwordChanged) && !currentPassword) {
      return res.status(400).json({ error: "Enter your current password to change your email or password" });
    }
    const attemptKey = hashToken(req.user.sub);
    if (emailChanged || passwordChanged) {
      if (await passwordAttemptCount(db, attemptKey) >= PASSWORD_ATTEMPT_LIMIT) {
        return res.status(429).json({ error: "Too many incorrect password attempts. Try again in 15 minutes." });
      }
      const passwordHash = account.password_hash || account.password;
      const validPassword =
        typeof passwordHash === "string" &&
        (passwordHash.startsWith("$2")
          ? bcrypt.compareSync(currentPassword, passwordHash)
          : passwordHash === currentPassword);
      if (!validPassword) {
        await recordPasswordFailure(db, attemptKey);
        return res.status(400).json({ error: "Current password is incorrect" });
      }
      await db.collection("security_attempts").deleteOne({ _id: attemptKey });
    }

    if (emailChanged) {
      const tenants = db.collection("tenants");
      const superadmins = db.collection("superadmins");
      const [tenantConflict, superadminConflict] = await Promise.all([
        tenants.findOne(superadmin ? { email } : { email, tenant_name: { $ne: tenant.tenant_name } }),
        superadmins.findOne({
          $or: [{ email }, { username: email }],
          ...(superadmin ? { _id: { $ne: account._id } } : {}),
        }),
      ]);
      if (tenantConflict || superadminConflict) {
        return res.status(409).json({ error: "That email address is already in use" });
      }
    }

    if (emailChanged) {
      const confirmToken = createToken();
      const cancelToken = createToken();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const changes = db.collection("email_change_tokens");
      await changes.deleteMany({ user_key: req.user.sub, kind: { $in: ["confirm", "cancel"] } });
      await changes.insertMany([
        {
          _id: hashToken(confirmToken),
          user_key: req.user.sub,
          kind: "confirm",
          old_email: currentEmail,
          new_email: email,
          created_at: new Date(),
          expires_at: expiresAt,
        },
        {
          _id: hashToken(cancelToken),
          user_key: req.user.sub,
          kind: "cancel",
          created_at: new Date(),
          expires_at: expiresAt,
        },
      ]);
      const baseUrl = config.frontendOrigin.replace(/\/$/, "");
      try {
        await sendAccountEmail({
          to: email,
          subject: "[UniSell] Confirm your new email address",
          text: `Confirm your new email address by opening: ${baseUrl}/email-change?token=${encodeURIComponent(confirmToken)}&action=confirm\nThis link expires in 1 hour.`,
          html: `<p>Confirm your new email address:</p><p><a href="${baseUrl}/email-change?token=${encodeURIComponent(confirmToken)}&action=confirm">Confirm email address</a></p><p>This link expires in 1 hour. Your current email stays active until you confirm.</p>`,
        });
        await sendAccountEmail({
          to: currentEmail,
          subject: "[UniSell] Email change requested",
          text: `A request was made to change your UniSell email to ${email}. Your current email remains active until confirmation. If you did not request this, cancel it here: ${baseUrl}/email-change?token=${encodeURIComponent(cancelToken)}&action=cancel`,
          html: `<p>A request was made to change your UniSell email to <strong>${escapeHtml(email)}</strong>. Your current address remains active until the new address is confirmed.</p><p>If this wasn't you, <a href="${baseUrl}/email-change?token=${encodeURIComponent(cancelToken)}&action=cancel">cancel the email change</a>.</p>`,
        });
      } catch (mailError) {
        await changes.deleteMany({ user_key: req.user.sub, kind: { $in: ["confirm", "cancel"] } });
        console.error("Email change confirmation message failed:", mailError);
        throw new Error("ACCOUNT_EMAIL_DELIVERY_FAILED");
      }
    }

    const update = { updated_at: new Date() };
    if (name !== undefined) update.name = name;
    if (passwordChanged) {
      update.password_hash = bcrypt.hashSync(password, 10);
      update.password_changed_at = new Date();
    }
    if (avatar !== undefined) update.avatar = avatar || "";

    const accountUpdate = { $set: update };
    if (passwordChanged && account.password) accountUpdate.$unset = { password: "" };
    const hasProfileChanges = name !== undefined || passwordChanged || avatar !== undefined;
    let refreshedSession;
    if (hasProfileChanges) {
      await accountCollection.updateOne({ _id: account._id }, accountUpdate);
      refreshedSession = await createAuthenticatedSession(db, req, req.user.sub, {
        email: currentEmail,
        role: superadmin ? "superadmin" : "tenant",
        ...(superadmin ? {} : { tenant_name: tenant.tenant_name }),
      });
      const revokeQuery = { user_key: req.user.sub, _id: { $ne: refreshedSession.sessionId } };
      if (passwordChanged) {
        await db.collection("auth_sessions").deleteMany(revokeQuery);
      } else {
        await db.collection("auth_sessions").deleteOne({ _id: req.user.jti, user_key: req.user.sub });
      }
    }

    let passwordNoticeSent = true;
    if (passwordChanged) {
      try {
        await sendAccountEmail({
          to: currentEmail,
          subject: "[UniSell] Your password was changed",
          text: "Your UniSell password was changed. If you did not make this change, contact your administrator immediately.",
          html: "<p>Your UniSell password was changed.</p><p>If you did not make this change, contact your administrator immediately.</p>",
        });
      } catch (mailError) {
        passwordNoticeSent = false;
        console.error("Password change notice email failed:", mailError);
      }
    }
    const currentPendingEmail = emailChanged
      ? email
      : (await db.collection("email_change_tokens").findOne({
          user_key: req.user.sub,
          kind: "confirm",
          expires_at: { $gt: new Date() },
        }))?.new_email || "";
    return res.json({
      token: refreshedSession?.token,
      pending_email: currentPendingEmail || undefined,
      password_notice_sent: passwordChanged ? passwordNoticeSent : undefined,
      user: {
        email: currentEmail,
        name: name !== undefined ? name : account.name || (superadmin ? account.username : tenant.tenant_name),
        avatar: avatar !== undefined ? avatar || "" : account.avatar || "",
        role: superadmin ? "superadmin" : account.role || "tenant",
        email_verified: account.email_verified === true,
        two_factor_enabled: account.two_factor_enabled === true,
        member_since: account.created_at || tenant?.created_at || null,
        last_login_at: account.last_login_at || null,
        pending_email: currentPendingEmail,
        ...(superadmin ? {} : { tenant_name: tenant.tenant_name }),
      },
    });
  } catch (err) {
    console.error("Update profile error:", err);
    if (err.message === "ACCOUNT_EMAIL_DELIVERY_FAILED") {
      return res.status(503).json({ error: "Email could not be sent. Profile changes were not saved; check SMTP configuration and retry." });
    }
    return res.status(500).json({ error: "Failed to update profile" });
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
