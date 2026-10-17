function iso(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : null;
}

const ownerFields = [
  "name",
  "description",
  "slug",
  "logoPath",
  "bannerPath",
  "contactPhone",
  "city",
  "address",
  "pickupLocations",
  "deliveryCities",
  "openingHours",
  "categories",
  "status",
  "statusReason",
  "commissionRateBps",
  "ratingAvg",
  "salesCount",
  "failedDeliveryCount",
  "cancellationCount",
  "resubmissionCount",
  "createdAt",
  "updatedAt",
  "version",
];

const adminFields = [...ownerFields, "ownerUid", "riskFlags", "verificationStatus"];

function mapFields(snapshotOrData, fields) {
  const source = typeof snapshotOrData.data === "function"
    ? { id: snapshotOrData.id, ...snapshotOrData.data() }
    : snapshotOrData;
  const result = { id: source.id };
  for (const field of fields) {
    if (source[field] !== undefined) result[field] = source[field];
  }
  for (const field of ["createdAt", "updatedAt"]) {
    if (field in result) result[field] = iso(result[field]);
  }
  return result;
}

export const toOwnerStoreDto = (value) => mapFields(value, ownerFields);
export const toAdminStoreDto = (value) => mapFields(value, adminFields);
export function toPublicStoreDto(storeId, value) {
  return {
    id: storeId,
    name: value.name,
    slug: value.slug,
    logo: value.logoPath ?? null,
    description: value.description,
    city: value.city,
    ratingAvg: Number.isFinite(value.ratingAvg) ? value.ratingAvg : 0,
    status: value.status,
  };
}
