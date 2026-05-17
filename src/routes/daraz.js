import express from "express";

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
  const { code } = req.query;

  try {
    console.log("Authorization code:", code);

    // TODO:
    // Exchange code for token here

    const safeCode = code ? String(code).replace(/\\/g, "\\\\").replace(/'/g, "\\'") : "";
    res.send(`
      <script>
        window.opener.postMessage(
          { type: "DARAZ_CONNECTED", code: "${safeCode}" },
          "*"
        );
        window.close();
      </script>
    `);
  } catch (error) {
    console.log(error);
    res.send("OAuth failed");
  }
});

export default router;
