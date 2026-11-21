const SHOPIFY_SKU_MAX_LENGTH = 100;

export function generateShopifyChannelSku(productId, internalSku, variantIndex = 0) {
  const stableId = String(productId ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!stableId) throw new Error("A UniSell product ID is required to generate a Shopify SKU.");
  if (!Number.isInteger(variantIndex) || variantIndex < 0) {
    throw new Error("The Shopify variant index must be a non-negative integer.");
  }

  const suffix = `-${stableId}-${String(variantIndex + 1).padStart(3, "0")}`;
  const prefix = "US-SH-";
  const normalizedSku = String(internalSku || "SKU")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  const availableSkuLength = Math.max(1, SHOPIFY_SKU_MAX_LENGTH - prefix.length - suffix.length);
  const skuLabel = normalizedSku.slice(0, availableSkuLength) || "S";

  return `${prefix}${skuLabel}${suffix}`;
}

export function withShopifyChannelSkus(product, productId) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (variants.length === 0) {
    const internalSku = String(product?.sku || "").trim();
    return {
      ...product,
      internal_sku: internalSku,
      sku: generateShopifyChannelSku(productId, internalSku),
    };
  }

  return {
    ...product,
    variants: variants.map((variant, index) => {
      const internalSku = String(variant?.sku || product?.sku || "").trim();
      return {
        ...variant,
        internal_sku: internalSku,
        sku: generateShopifyChannelSku(productId, internalSku, index),
      };
    }),
  };
}
