import { createHash } from "node:crypto";
import { db } from "../../utils/firebase.js";
import { deny } from "./operations.js";

export function reservationId(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function findAvailableSlug(transaction, collectionName, base, targetId) {
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const slug = suffix === 1 ? base : `${base}-${suffix}`;
    const reference = db.collection(collectionName).doc(slug);
    const reservation = await transaction.get(reference);
    if (!reservation.exists || reservation.get("targetId") === targetId) {
      return { slug, reference };
    }
  }
  deny("PRODUCT_SLUG_CAPACITY_EXCEEDED", "resource-exhausted");
}

export async function checkSkuReservations(transaction, sellerId, skus, productId) {
  const references = skus.map((sku) => db.collection("_sellerSkus")
    .doc(reservationId(`${sellerId}:${sku}`)));
  const snapshots = await Promise.all(references.map((reference) => transaction.get(reference)));
  for (const snapshot of snapshots) {
    if (snapshot.exists && snapshot.get("productId") !== productId) {
      deny("PRODUCT_SKU_ALREADY_EXISTS", "already-exists");
    }
  }
  return references;
}
export async function countSellerProducts(transaction, sellerId, status, limit) {
  const query = db.collection("products")
    .where("sellerId", "==", sellerId)
    .where("status", "==", status)
    .limit(limit);
  const snapshot = await transaction.get(query);
  return snapshot.size;
}
