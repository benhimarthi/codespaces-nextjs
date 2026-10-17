import { productVariantId } from "../../orders/shared/variants.js";

const productFields = [
  "id",
  "sellerId",
  "name",
  "description",
  "price",
  "currency",
  "categoryId",
  "subCategoryId",
  "images",
  "stock",
  "sku",
  "brand",
  "tags",
  "compareAtPrice",
  "weightGrams",
  "dimensions",
  "condition",
  "variants",
  "status",
  "moderationStatus",
  "moderationReason",
  "needsReview",
  "slug",
  "version",
  "createdAt",
  "updatedAt",
];

function timestampToIso(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : null;
}

export function toProductDto(snapshotOrData) {
  const source = typeof snapshotOrData.data === "function"
    ? { id: snapshotOrData.id, ...snapshotOrData.data() }
    : snapshotOrData;
  const result = {};
  for (const key of productFields) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  if (Array.isArray(result.variants)) {
    result.variants = result.variants.map((variant) => ({
      ...variant,
      id: productVariantId(variant),
    }));
  }
  if ("createdAt" in result) result.createdAt = timestampToIso(result.createdAt);
  if ("updatedAt" in result) result.updatedAt = timestampToIso(result.updatedAt);
  return result;
}

export function toCategoryDto(snapshotOrData) {
  const source = typeof snapshotOrData.data === "function"
    ? { id: snapshotOrData.id, ...snapshotOrData.data() }
    : snapshotOrData;
  return {
    id: source.id,
    name: source.name,
    slug: source.slug,
    parentId: source.parentId ?? null,
    active: source.active,
    createdAt: timestampToIso(source.createdAt),
    updatedAt: timestampToIso(source.updatedAt),
  };
}
