/**
 * Generate product listing fields from keywords using Google Gemini.
 * Set GEMINI_API_KEY and optional GEMINI_MODEL in .env (https://aistudio.google.com/apikey).
 */

import { config } from "../config.js";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

/** Models that typically still have free-tier quota (2.0-flash often shows limit: 0). */
const FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash-8b",
];

const LISTING_SCHEMA = `{
  "title": "string — product name, max 120 chars",
  "description": "string — HTML product description (2-4 short paragraphs, use <p> tags)",
  "page_title": "string — SEO meta title, max 60 chars",
  "meta_description": "string — SEO meta description, max 160 chars",
  "handle": "string — URL slug, lowercase hyphenated",
  "sku": "string — unique SKU code",
  "product_type": "string — category e.g. T-Shirts, Jewellery",
  "price": "number — suggested retail price in USD",
  "price_old": "number or null — compare-at price if on sale, else null",
  "vendor": "string — brand or store name",
  "tags": ["string array — 3-8 relevant tags"]
}`;

export function getDefaultGeminiModel() {
  return config.geminiModel || "gemini-2.5-flash";
}

function getApiKey() {
  const key = config.geminiApiKey?.trim();
  if (!key) {
    throw new Error(
      "Gemini API is not configured. Add GEMINI_API_KEY to backend .env (get a key at https://aistudio.google.com/apikey)."
    );
  }
  return key;
}

function modelIdFromApiName(name) {
  return String(name || "").replace(/^models\//, "");
}

function isListingSuitableModel(id) {
  const m = String(id || "").toLowerCase();
  if (!m.startsWith("gemini-")) return false;
  if (m.includes("embedding") || m.includes("aqa")) return false;
  if (
    m.includes("image") ||
    m.includes("tts") ||
    m.includes("robotics") ||
    m.includes("computer-use") ||
    m.includes("deep-research") ||
    m.includes("lyria") ||
    m.includes("nano-banana") ||
    m.includes("customtools")
  ) {
    return false;
  }
  return m.includes("flash") || m.includes("pro");
}

function sortModelsForListing(a, b) {
  const score = (id) => {
    const m = id.toLowerCase();
    if (m === "gemini-2.5-flash") return 0;
    if (m === "gemini-2.5-flash-lite") return 1;
    if (m === "gemini-flash-latest") return 2;
    if (m.startsWith("gemini-2.5-flash") && !m.includes("preview")) return 3;
    if (m.includes("flash-lite")) return 5;
    if (m.includes("flash") && !m.includes("2.0-flash")) return 4;
    if (m === "gemini-2.0-flash") return 8;
    if (m.includes("pro")) return 7;
    return 6;
  };
  const d = score(a) - score(b);
  return d !== 0 ? d : a.localeCompare(b);
}

function isQuotaOrRateLimitError(res, msg) {
  if (res.status === 429 || res.status === 503) return true;
  const s = String(msg).toLowerCase();
  return (
    s.includes("quota") ||
    s.includes("rate limit") ||
    s.includes("resource_exhausted") ||
    s.includes("exceeded") ||
    s.includes("too many requests")
  );
}

function friendlyGeminiError(msg, status) {
  const s = String(msg || "");
  if (isQuotaOrRateLimitError({ status }, s)) {
    const retryMatch = s.match(/retry in ([\d.]+)s/i);
    const wait = retryMatch ? ` Wait about ${Math.ceil(Number(retryMatch[1]))} seconds.` : "";
    return (
      "Gemini free tier quota exceeded for this model." +
      wait +
      " Try another model (e.g. gemini-2.5-flash) in the dropdown, wait a minute, or enable billing: https://ai.google.dev/gemini-api/docs/rate-limits"
    );
  }
  if (s.length > 280) return s.slice(0, 277) + "…";
  return s || `Gemini API error (${status})`;
}

/** @returns {Promise<string[]>} */
export async function listAvailableGeminiModels() {
  const key = config.geminiApiKey?.trim();
  if (!key) {
    return [...FALLBACK_MODELS];
  }
  try {
    const url = `${API_ROOT}/models?key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("[Gemini] list models failed:", data?.error?.message || res.status);
      return [...FALLBACK_MODELS];
    }
    const fromApi = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => modelIdFromApiName(m.name))
      .filter((id) => isListingSuitableModel(id))
      .sort(sortModelsForListing);
    if (fromApi.length === 0) return [...FALLBACK_MODELS];
    const preferred = getDefaultGeminiModel();
    const merged = [...FALLBACK_MODELS, preferred, ...fromApi];
    return [...new Set(merged)].filter(isListingSuitableModel).sort(sortModelsForListing);
  } catch (err) {
    console.warn("[Gemini] list models error:", err.message);
    return [...FALLBACK_MODELS];
  }
}

export async function getGeminiAiConfig() {
  const configured = !!config.geminiApiKey?.trim();
  const model = getDefaultGeminiModel();
  const models = configured ? await listAvailableGeminiModels() : [...FALLBACK_MODELS];
  return { configured, model, models };
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseJsonFromModelText(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("Gemini returned invalid JSON for product listing.");
  }
}

function normalizeListing(parsed) {
  const title = String(parsed.title || "").trim().slice(0, 200);
  if (!title) throw new Error("AI did not return a product title. Try different keywords.");

  const price = parsed.price != null && !Number.isNaN(Number(parsed.price)) ? Number(parsed.price) : null;
  const price_old =
    parsed.price_old != null && !Number.isNaN(Number(parsed.price_old)) ? Number(parsed.price_old) : null;

  let handle = String(parsed.handle || "").trim().toLowerCase();
  if (!handle) handle = slugify(title);

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
    : typeof parsed.tags === "string"
      ? parsed.tags.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

  return {
    title,
    description: String(parsed.description || "").trim(),
    page_title: String(parsed.page_title || title).trim().slice(0, 70),
    meta_description: String(parsed.meta_description || "").trim().slice(0, 320),
    handle: slugify(handle),
    sku: String(parsed.sku || "").trim().slice(0, 64) || `SKU-${Date.now().toString(36).toUpperCase()}`,
    product_type: String(parsed.product_type || "General").trim().slice(0, 100),
    price: price != null && price >= 0 ? Math.round(price * 100) / 100 : null,
    price_old: price_old != null && price_old >= 0 ? Math.round(price_old * 100) / 100 : null,
    vendor: String(parsed.vendor || "").trim().slice(0, 100),
    tags,
  };
}

async function callGeminiGenerate(apiKey, model, prompt) {
  const url = `${API_ROOT}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.65,
        responseMimeType: "application/json",
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/**
 * @param {string} keywords
 * @param {{ model?: string }} [options]
 */
export async function generateProductListingFromKeywords(keywords, options = {}) {
  const apiKey = getApiKey();
  const requested = (options.model || getDefaultGeminiModel()).trim();
  const listed = await listAvailableGeminiModels();
  const tryModels = [
    ...new Set([requested, getDefaultGeminiModel(), ...listed, ...FALLBACK_MODELS]),
  ].filter(isListingSuitableModel);

  const prompt = `You are an e-commerce product listing expert for Shopify and Daraz marketplaces.

Given these product keywords: "${keywords}"

Generate a complete product listing. Return ONLY valid JSON matching this schema (no markdown outside JSON):
${LISTING_SCHEMA}

Rules:
- Write in English unless keywords clearly indicate another language.
- Prices should be realistic for the product type (USD).
- Description must be customer-friendly HTML with <p> tags only.
- SKU should look like a real product code (letters + numbers).
- handle must be URL-safe (lowercase, hyphens).`;

  let lastError = "Gemini API error";
  let quotaFailures = 0;

  for (const model of tryModels) {
    const { res, data } = await callGeminiGenerate(apiKey, model, prompt);
    if (res.ok) {
      const text =
        data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
      if (!text) {
        lastError = "Gemini returned an empty response. Try again.";
        continue;
      }
      const listing = normalizeListing(parseJsonFromModelText(text));
      return { listing, model_used: model };
    }

    const rawMsg = data?.error?.message || data?.error?.status || `Gemini API error (${res.status})`;
    lastError = friendlyGeminiError(rawMsg, res.status);

    if (isQuotaOrRateLimitError(res, rawMsg)) {
      quotaFailures += 1;
      console.warn(`[Gemini] quota/rate limit on ${model}, trying next model…`);
      continue;
    }

    const notFound =
      res.status === 404 || /not found|invalid model|does not exist/i.test(String(rawMsg));
    if (notFound) {
      console.warn(`[Gemini] model ${model} unavailable, trying next…`);
      continue;
    }

    throw new Error(lastError);
  }

  if (quotaFailures > 0) {
    throw new Error(
      "Gemini free tier quota is used up for all models we tried. Wait a few minutes, pick gemini-2.5-flash in the model dropdown, or add billing in Google AI Studio: https://ai.google.dev/gemini-api/docs/rate-limits"
    );
  }
  throw new Error(lastError);
}
