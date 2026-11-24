import express from "express";
import { DarazIntegration } from "../integrations/Daraz.js";
import { runWithDarazApp } from "../integrations/darazAppContext.js";
// Importing this module also activates the per-company app context on DarazIntegration.
import { darazAppCredentialsError } from "../services/darazAppCredentials.js";

const router = express.Router();

const AUTHORIZE_URL = "https://api.daraz.pk/oauth/authorize";
const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Step 1 — build the Daraz sign-in URL for a specific app.
 * GET /api/daraz/connect?app_key=<company's app key>
 * Without app_key the server-wide DARAZ_APP_KEY is used (legacy single-app setup).
 */
router.get("/connect", (req, res) => {
  try {
    const redirectUri = str(process.env.DARAZ_REDIRECT_URI);
    if (!redirectUri) {
      return res.status(500).json({
        error: "Daraz is not configured. Set DARAZ_REDIRECT_URI on the server (the /api/daraz/callback URL).",
      });
    }

    const appKey = str(req.query.app_key) || str(process.env.DARAZ_APP_KEY);
    if (!appKey) {
      return res.status(400).json({ error: "Enter the Daraz App Key for this company's app." });
    }

    const url =
      `${AUTHORIZE_URL}` +
      `?response_type=code` +
      `&force_auth=true` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&client_id=${encodeURIComponent(appKey)}`;

    return res.json({ url });
  } catch (err) {
    console.error("[Daraz] connect error:", err);
    return res.status(500).json({ error: err.message || "Daraz connect failed" });
  }
});

/**
 * Step 2 — Daraz redirects the popup here. We only hand the one-time code back to the
 * page that opened the popup; the page then calls /exchange with the app credentials.
 * (The callback itself can't know which company's app was used.)
 */
router.get("/callback", (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    const detail = String(error_description || error);
    console.error("[Daraz] OAuth denied:", detail);
    return res.send(popupHtml({ ok: false, error: detail }));
  }
  if (!code) {
    return res.send(popupHtml({ ok: false, error: "No authorization code returned from Daraz." }));
  }
  return res.send(popupHtml({ ok: true, code: String(code) }));
});

/**
 * Step 3 — exchange the code for tokens using that company's app.
 * POST /api/daraz/exchange { app_key, app_secret, code }
 * Leave app_key/app_secret empty to use the server-wide DARAZ_APP_KEY/SECRET.
 * Daraz codes are single-use and short-lived, so the UI calls this immediately.
 */
router.post("/exchange", async (req, res) => {
  const code = str(req.body?.code);
  const app_key = str(req.body?.app_key);
  const app_secret = str(req.body?.app_secret);

  if (!code) return res.status(400).json({ error: "Authorization code is required." });

  const appError = darazAppCredentialsError({ app_key, app_secret });
  if (appError) return res.status(400).json({ error: appError });

  try {
    const app = app_key && app_secret ? { app_key, app_secret } : null;
    const tokens = await runWithDarazApp(app, () => DarazIntegration.exchangeCode(code));
    if (!tokens?.access_token) {
      throw new Error("Daraz did not return an access token. Try connecting again.");
    }
    console.log("[Daraz] token exchange ok");
    return res.json({
      credentials: { ...tokens, oauth_connected: "true", authorization_code: "" },
    });
  } catch (err) {
    console.error("[Daraz] token exchange failed:", err.message);
    return res.status(400).json({ error: err.message || "Daraz token exchange failed" });
  }
});

function popupHtml(payload) {
  const json = JSON.stringify({ type: "DARAZ_OAUTH_CODE", ...payload }).replace(/</g, "\\u003c");
  const ok = payload.ok === true;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Daraz</title></head>
<body>
<p>${ok ? "Daraz authorized. Finishing the connection — you can close this window." : "Daraz connect failed. You can close this window."}</p>
<script>
  try {
    if (window.opener) {
      window.opener.postMessage(${json}, "*");
    }
  } catch (e) {}
  setTimeout(function () { window.close(); }, 400);
</script>
</body></html>`;
}

export default router;
