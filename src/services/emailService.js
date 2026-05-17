import nodemailer from "nodemailer";
import { config } from "../config.js";

let transporter = null;

function getTransporter() {
  if (!config.smtpHost) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth:
        config.smtpUser && config.smtpPass
          ? { user: config.smtpUser, pass: config.smtpPass }
          : undefined,
    });
  }
  return transporter;
}

/**
 * Send out-of-stock alert email. No-op if SMTP is not configured.
 */
export async function sendOutOfStockEmail({ to, tenantName, productTitle, sku, appUrl }) {
  if (!to) return { sent: false, reason: "no_recipient" };
  const transport = getTransporter();
  if (!transport) {
    return { sent: false, reason: "smtp_not_configured" };
  }

  const title = String(productTitle || "Product").trim();
  const skuLine = sku ? `SKU: ${sku}` : "";
  const inventoryUrl = appUrl ? `${appUrl.replace(/\/$/, "")}/inventory` : "";

  const text = [
    `Stock alert for ${tenantName}`,
    "",
    `The following product is now out of stock (quantity 0):`,
    "",
    title,
    skuLine,
    "",
    inventoryUrl ? `View inventory: ${inventoryUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
    <p><strong>${tenantName}</strong> — stock alert</p>
    <p>The following product is now <strong>out of stock</strong> (quantity 0):</p>
    <p><strong>${title}</strong><br/>${skuLine ? `${skuLine}<br/>` : ""}</p>
    ${inventoryUrl ? `<p><a href="${inventoryUrl}">Open inventory in UniSell</a></p>` : ""}
  `;

  await transport.sendMail({
    from: config.mailFrom,
    to,
    subject: `[UniSell] Out of stock: ${title.slice(0, 60)}`,
    text,
    html,
  });

  return { sent: true };
}
