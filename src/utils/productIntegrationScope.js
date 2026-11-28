export function normalizeProductIntegrationScope(scope, integrationSlugs) {
  if (scope === "all" || scope === "selected") return scope;
  return Array.isArray(integrationSlugs) && integrationSlugs.length > 0 ? "selected" : "all";
}

export function shouldSyncProductToPlatform(product, platform) {
  const slugs = Array.isArray(product?.integration_slugs)
    ? product.integration_slugs.filter((slug) => typeof slug === "string")
    : [];
  const scope = normalizeProductIntegrationScope(product?.integration_scope, slugs);
  return scope === "all" || slugs.includes(platform);
}
