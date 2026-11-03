export function formatTitleCase(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’][A-Za-zÀ-ÖØ-öø-ÿ]+)*/g, (word) => {
      if (word.length <= 4 && word === word.toLocaleUpperCase()) return word;
      if (/[a-z]/.test(word.slice(1)) && /[A-Z]/.test(word.slice(1))) return word;
      const lower = word.toLocaleLowerCase();
      return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
    });
}

export function formatSentenceCase(value) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (/^(?:XXS|XS|S|M|L|XL|XXL|XXXL|XXXXL)$/.test(normalized)) return normalized;
  const lower = normalized.toLocaleLowerCase();
  return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
}

export function normalizeProductText(product) {
  const normalized = {
    title: formatTitleCase(product.title),
    product_type: formatTitleCase(product.product_type),
  };
  if (Array.isArray(product.variants)) {
    normalized.variants = product.variants.map((variant) => ({
      ...variant,
      ...(variant.title != null ? { title: formatSentenceCase(variant.title) } : {}),
      ...(variant.option1 != null ? { option1: formatSentenceCase(variant.option1) } : {}),
      ...(variant.option2 != null ? { option2: formatSentenceCase(variant.option2) } : {}),
    }));
  }
  return normalized;
}
