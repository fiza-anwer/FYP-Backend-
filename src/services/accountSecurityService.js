import {
  createHash,
  randomBytes,
} from "node:crypto";
import nodemailer from "nodemailer";
import { config } from "../config.js";
import jwt from "jsonwebtoken";

let transporter;

export function createToken() {
  return randomBytes(32).toString("hex");
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createSessionId() {
  return randomBytes(24).toString("hex");
}

export async function createAuthenticatedSession(db, req, userKey, claims) {
  const sessionId = createSessionId();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  const userAgent = String(req.get("user-agent") || "Unknown device").slice(0, 300);
  await db.collection("auth_sessions").insertOne({
    _id: sessionId,
    user_key: userKey,
    created_at: createdAt,
    last_seen_at: createdAt,
    expires_at: expiresAt,
    user_agent: userAgent,
    ip_address: String(req.ip || "").slice(0, 64),
  });
  const token = jwt.sign({ ...claims, jti: sessionId, sub: userKey }, config.jwtSecret, {
    expiresIn: "7d",
  });
  return { token, sessionId, createdAt, expiresAt };
}

function getTransporter() {
  if (!config.smtpHost) {
    throw new Error("Email delivery is not configured. Set SMTP_HOST and the SMTP credentials.");
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: config.smtpUser && config.smtpPass
        ? { user: config.smtpUser, pass: config.smtpPass }
        : undefined,
    });
  }
  return transporter;
}

export async function sendAccountEmail({ to, subject, text, html }) {
  await getTransporter().sendMail({ from: config.mailFrom, to, subject, text, html });
}

export function passwordFeedback(password) {
  const value = String(password || "");
  const normalized = value.toLowerCase();
  const common = new Set([
    "password1234", "password12345", "password123456", "qwerty123456",
    "123456789012", "1234567890123", "letmein123456", "admin12345678",
    "welcome123456", "iloveyou123456", "changeme123456", "abc123456789",
  ]);
  if (value.length < 12) return "Use at least 12 characters.";
  if (
    common.has(normalized) ||
    /(password|qwerty|letmein|admin|welcome|iloveyou|changeme|monkey|dragon)/i.test(value) ||
    /^(.)\1{7,}$/.test(value) ||
    /^(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef)/i.test(value)
  ) {
    return "This password is too common or predictable. Choose a different one.";
  }
  const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)].filter(Boolean).length;
  if (classes < 3) return "Use a mix of uppercase, lowercase, numbers, and symbols.";
  return "";
}
