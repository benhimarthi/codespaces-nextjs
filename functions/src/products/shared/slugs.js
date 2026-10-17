export function slugify(value) {
  const slug = value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "item";
}

export function uniqueSkuValues(product) {
  return [...new Set([
    product.sku,
    ...(product.variants ?? []).map((variant) => variant.sku),
  ].filter(Boolean).map((sku) => sku.toLowerCase()))];
}
