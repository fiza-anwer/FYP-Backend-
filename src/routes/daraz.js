import express from "express";
import { DarazIntegration } from "../integrations/Daraz.js";

const router = express.Router();

router.get("/connect", async (req, res) => {
  try {
    const redirectUri = encodeURIComponent(process.env.DARAZ_REDIRECT_URI || "");
    const clientId = process.env.DARAZ_APP_KEY || "";

    if (!redirectUri || !clientId) {
      return res.status(500).json({
        error: "Daraz is not configured. Set DARAZ_REDIRECT_URI and DARAZ_APP_KEY in .env",
      });
    }

    const url =
      `https://api.daraz.pk/oauth/authorize` +
      `?response_type=code` +
      `&force_auth=true` +
      `&redirect_uri=${redirectUri}` +
      `&client_id=${clientId}`;

    res.json({ url });
  } catch (err) {
    console.error("[Daraz] connect error:", err);
    res.status(500).json({ error: err.message || "Daraz connect failed" });
  }
});

router.get("/callback", async (req, res) => {
  const { code, error, error_description } = req.query;

  try {
    if (error) {
      const detail = String(error_description || error);
      console.error("[Daraz] OAuth denied:", detail);
      return res.send(oauthPopupHtml({ ok: false, message: detail }));
    }

    if (!code) {
      return res.send(oauthPopupHtml({ ok: false, message: "No authorization code returned from Daraz." }));
    }

    // Exchange immediately — Daraz codes are single-use and expire within minutes.
    console.log("[Daraz] exchanging authorization code…");
    const tokens = await DarazIntegration.exchangeCode(String(code));
    console.log("[Daraz] token exchange ok");

    return res.send(
      oauthPopupHtml({
        ok: true,
        credentials: {
          oauth_connected: "true",
          authorization_code: "",
          access_token: tokens.access_token || "",
          refresh_token: tokens.refresh_token || "",
          expires_in: tokens.expires_in || "",
          refresh_expires_in: tokens.refresh_expires_in || "",
        },
      })
    );
  } catch (err) {
    console.error("[Daraz] callback exchange failed:", err.message);
    return res.send(
      oauthPopupHtml({
        ok: false,
        message: err.message || "Daraz OAuth failed",
      })
    );
  }
});

function oauthPopupHtml({ ok, credentials, message }) {
  const payload = ok
    ? { type: "DARAZ_CONNECTED", ok: true, credentials }
    : { type: "DARAZ_CONNECTED", ok: false, error: message || "OAuth failed" };
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Daraz</title></head>
<body>
<p>${ok ? "Daraz connected. You can close this window." : "Daraz connect failed."}</p>
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
