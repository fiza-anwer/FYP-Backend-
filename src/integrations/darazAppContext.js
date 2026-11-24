/**
 * Per-company Daraz app (App Key / App Secret) support.
 *
 * Why this exists: every Daraz API call must be signed with the key+secret of the app
 * that issued the seller's access token. UniSell has several tenants/companies and each
 * can use its own "Seller Inhouse" app, so the key/secret can't be a single env var.
 *
 * How it works: the company's credentials object carries `app_key` + `app_secret`
 * (stored next to access_token/refresh_token). Whenever a DarazIntegration method is
 * called with such a credentials object, we run it inside an AsyncLocalStorage context.
 * darazApi.js reads the app from that context (getDarazApp) and falls back to the
 * DARAZ_APP_KEY / DARAZ_APP_SECRET env vars when the company has no app of its own
 * (so connections made before this change keep working).
 *
 * AsyncLocalStorage keeps concurrent calls for different companies isolated, which is
 * why we don't just swap process.env around.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();
const PATCHED = Symbol.for("unisell.darazAppContextApplied");

const clean = (v) => (typeof v === "string" ? v.trim() : "");

/** Read { app_key, app_secret } from a credentials object, or null if it has no app. */
export function appFromCredentials(creds) {
  if (!creds || typeof creds !== "object" || Array.isArray(creds)) return null;
  const app_key = clean(creds.app_key);
  const app_secret = clean(creds.app_secret);
  return app_key && app_secret ? { app_key, app_secret } : null;
}

/** Run fn with the given Daraz app active. With no app, fn runs on the env-var app. */
export function runWithDarazApp(app, fn) {
  if (!app?.app_key || !app?.app_secret) return fn();
  return storage.run({ app_key: app.app_key, app_secret: app.app_secret }, fn);
}

/** App used for signing right now: the company's app if in context, else env vars. */
export function getDarazApp() {
  const ctx = storage.getStore();
  if (ctx) return { key: ctx.app_key, secret: ctx.app_secret, source: "company" };
  return {
    key: clean(process.env.DARAZ_APP_KEY),
    secret: clean(process.env.DARAZ_APP_SECRET),
    source: "env",
  };
}

/** If a method returns credentials (has access_token) make sure the app fields survive. */
function keepApp(result, app) {
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof result.access_token === "string" &&
    !result.app_key
  ) {
    return { ...result, app_key: app.app_key, app_secret: app.app_secret };
  }
  return result;
}

/**
 * Wrap every static method of DarazIntegration so that, when its first argument is a
 * credentials object containing app_key/app_secret, the call runs in that app's context.
 * Methods whose first argument is not such an object (e.g. exchangeCode(code)) are untouched.
 * Safe to call more than once.
 */
export function applyDarazAppContext(Integration) {
  if (!Integration || Integration[PATCHED]) return Integration;

  for (const name of Object.getOwnPropertyNames(Integration)) {
    if (name === "length" || name === "name" || name === "prototype") continue;
    const desc = Object.getOwnPropertyDescriptor(Integration, name);
    if (!desc || typeof desc.value !== "function" || !desc.writable) continue;

    const original = desc.value;
    Integration[name] = function darazWithApp(...args) {
      const app = appFromCredentials(args[0]);
      if (!app) return original.apply(this, args);
      const out = storage.run(app, () => original.apply(this, args));
      return out && typeof out.then === "function"
        ? out.then((result) => keepApp(result, app))
        : keepApp(out, app);
    };
  }

  Object.defineProperty(Integration, PATCHED, { value: true });
  return Integration;
}
