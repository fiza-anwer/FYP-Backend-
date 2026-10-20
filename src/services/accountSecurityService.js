import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
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

function base32Encode(buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let current = 0;
  const output = [];
  for (const char of value.toUpperCase().replace(/=+$/g, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Invalid authenticator secret");
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function createTotpSecret() {
  return base32Encode(randomBytes(20));
}

function totp(secret, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

export function totpCounterForCode(secret, code, now = Date.now()) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const counter = Math.floor(now / 30_000);
  for (let drift = -1; drift <= 1; drift += 1) {
    const expected = Buffer.from(totp(secret, counter + drift));
    const supplied = Buffer.from(code);
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return counter + drift;
  }
  return null;
}

export function verifyTotp(secret, code, now = Date.now()) {
  return totpCounterForCode(secret, code, now) !== null;
}

const encryptionKey = () => createHash("sha256").update(config.jwtSecret).digest();

export function encryptSecret(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(value) {
  const [ivHex, tagHex, dataHex] = String(value || "").split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Invalid encrypted authenticator secret");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

export function authenticatorUri(secret, email) {
  const label = encodeURIComponent(`UniSell:${email}`);
  const issuer = encodeURIComponent("UniSell");
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
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
