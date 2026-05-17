/** Collect https image URLs from product.images */
export function collectProductImageUrls(images) {
  const urls = [];
  if (!Array.isArray(images)) return urls;
  for (const img of images) {
    const u = typeof img === "string" ? img.trim() : img?.src?.trim?.() || img?.url?.trim?.() || "";
    if (u && /^https?:\/\//i.test(u)) urls.push(u);
  }
  return urls;
}

/**
 * Daraz needs a direct image file URL, not a product/category page.
 * @returns {string|null} Error message or null if OK
 */
export function validateDirectImageUrl(url) {
  const u = String(url || "").trim();
  if (!u) return "Image URL is empty.";
  if (!/^https:\/\//i.test(u)) return "Image URL must start with https://";

  const lower = u.toLowerCase();
  if (/\.html?(\?|#|$)/i.test(lower) || /\.htm(\?|#|$)/i.test(lower)) {
    return "This is a web page link, not an image. Right‑click the photo → Copy image address (should end with .jpg or .png).";
  }
  if (
    /\/jewell|\/jewelry|\/rings-women|\/collections\/|\/products\/[^/]+\/?(\?|$)/i.test(lower) &&
    !/\.(jpe?g|png)(\?|$)/i.test(lower)
  ) {
    return "This looks like a shop page URL, not a direct image file. Use Copy image address from the photo.";
  }
  if (/\.(jpe?g|png)(\?|#|$)/i.test(lower)) return null;
  if (/slatic\.net|cdn\.shopify\.com|i\.imgur\.com|picsum\.photos|cloudinary\.com/i.test(lower)) {
    return null;
  }
  return "Use a direct image link ending in .jpg or .png (or host on Shopify/CDN/Imgur).";
}

export function validateProductImagesForDaraz(images) {
  const urls = collectProductImageUrls(images);
  if (urls.length === 0) {
    return "Add at least one product image URL to list on Daraz.";
  }
  const problems = urls.map((u) => validateDirectImageUrl(u)).filter(Boolean);
  if (problems.length > 0) return problems[0];
  return null;
}
