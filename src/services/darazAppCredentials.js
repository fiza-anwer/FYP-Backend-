/**
 * Helpers for Daraz company-integration credentials (used by routes/tenant.js and routes/daraz.js).
 * Importing this module also activates the per-company app context on DarazIntegration.
 */
import { DarazIntegration } from "../integrations/Daraz.js";
import {
  applyDarazAppContext,
  appFromCredentials,
  runWithDarazApp,
} from "../integrations/darazAppContext.js";

applyDarazAppContext(DarazIntegration);

const str = (v) => (typeof v === "string" ? v.trim() : "");

/** Fields never sent back to the browser. */
const HIDDEN_KEYS = ["app_secret", "access_token", "refresh_token", "authorization_code"];

/** Returns an error message if the credentials can't identify a Daraz app, else null. */
export function darazAppCredentialsError(creds) {
  const key = str(creds?.app_key);
  const secret = str(creds?.app_secret);
  if (key && secret) return null;
  if (key || secret) return "Enter both the Daraz App Key and the App Secret.";
  if (str(process.env.DARAZ_APP_KEY) && str(process.env.DARAZ_APP_SECRET)) return null;
  return "Enter the Daraz App Key and App Secret for this company's app.";
}

/** Trim app fields and exchange a legacy authorization_code (if any) for tokens. */
export async function normalizeDarazCredentials(credentials) {
  const creds = { ...(credentials || {}) };
  if (typeof creds.app_key === "string") creds.app_key = creds.app_key.trim();
  if (typeof creds.app_secret === "string") creds.app_secret = creds.app_secret.trim();

  // A fresh OAuth code wins over a stored (possibly expired) access_token.
  const code = str(creds.authorization_code);
  if (code) {
    try {
      const exchanged = await runWithDarazApp(appFromCredentials(creds), () =>
        DarazIntegration.exchangeCode(code)
      );
      return { ...creds, ...exchanged, authorization_code: "" };
    } catch (err) {
      console.error("[Daraz] Token exchange failed:", err.message);
      throw new Error(
        "Daraz authorization code expired or invalid. Connect Daraz again in Company Integrations, then Save immediately."
      );
    }
  }
  return creds;
}

/**
 * Merge credentials sent by the UI over the stored ones (PUT).
 * The API never returns app_secret/tokens, so the UI sends them blank unless the user
 * typed a new secret or reconnected. Blank values must keep the stored ones.
 */
export function mergeDarazCredentials(existing, incoming) {
  const base = { ...(existing || {}) };
  const next = { ...(incoming || {}) };

  delete next.app_secret_set; // display-only flag added by publicDarazCredentials
  for (const key of [...HIDDEN_KEYS, "app_key", "oauth_connected"]) {
    if (typeof next[key] === "string") next[key] = next[key].trim();
    if (!next[key]) delete next[key];
  }

  const keyChanged = !!next.app_key && next.app_key !== str(base.app_key);
  const secretChanged = !!next.app_secret && next.app_secret !== str(base.app_secret);

  if (keyChanged && !next.app_secret) {
    throw new Error("Daraz: enter the App Secret together with the new App Key.");
  }
  // Tokens belong to one app, so a different app means a new OAuth sign-in is required.
  if ((keyChanged || secretChanged) && !next.access_token && !next.authorization_code) {
    throw new Error(
      "Daraz app credentials changed. Click “Connect Daraz account” again, then save."
    );
  }
  return { ...base, ...next };
}

/** Credentials as the browser may see them: no secret, no tokens, only status flags. */
export function publicDarazCredentials(creds) {
  const out = { ...(creds || {}) };
  const hasToken = !!str(out.access_token);
  const hasSecret = !!str(out.app_secret);
  for (const key of HIDDEN_KEYS) delete out[key];
  delete out.expires_in;
  delete out.refresh_expires_in;
  if (hasToken) out.oauth_connected = "true";
  if (hasSecret) out.app_secret_set = "true";
  return out;
}
