export function withShopifyChannelSkus(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (variants.length === 0) {
    const internalSku = String(product?.sku || "").trim();
    return {
      ...product,
      internal_sku: internalSku,
      sku: internalSku,
    };
  }

  return {
    ...product,
    variants: variants.map((variant) => {
      const internalSku = String(variant?.sku || product?.sku || "").trim();
      return {
        ...variant,
        internal_sku: internalSku,
        sku: internalSku,
      };
    }),
  };
}
