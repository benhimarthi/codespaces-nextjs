import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import { auth, db } from "../../utils/firebase.js";
import { orderConfig } from "../../orders/shared/config.js";
import { createHash } from "node:crypto";
import { productVariantId } from "../../orders/shared/variants.js";

export function cartItemId(productId, variantId = null) {
  return createHash("sha256").update(`${productId}:${variantId ?? ""}`).digest("hex");
}

export { productVariantId };

export async function validateCartProduct(productId, variantId, uid) {
  const product = await db.collection("products").doc(productId).get();
  if (!product.exists) throw new HttpsError("not-found", "Product not found.");
  const data = product.data();
  if (data.sellerId === uid) {
    logger.warn("Cart own-product purchase blocked", {
      event: "cart_security",
      outcome: "denied",
      code: "CART_OWN_PRODUCT",
    });
    throw new HttpsError("failed-precondition", "Product is unavailable.");
  }
  if (data.status !== "active" || data.archived === true) {
    throw new HttpsError("failed-precondition", "Product is unavailable.");
  }
  const seller = await auth.getUser(data.sellerId);
  if (seller.disabled) {
    throw new HttpsError("failed-precondition", "Product is unavailable.");
  }
  const variant = variantId == null
    ? null
    : (data.variants ?? []).find((entry) => productVariantId(entry) === variantId);
  if (variantId != null && !variant) {
    throw new HttpsError("failed-precondition", "Product variant is unavailable.");
  }
  return { snapshot: product, data, variant };
}

export function assertStock(item, requestedQuantity) {
  const stock = item.variant?.stock ?? item.data.stock;
  if (!Number.isSafeInteger(stock) || stock < requestedQuantity) {
    logger.warn("Cart stock conflict", {
      event: "cart_stock",
      outcome: "denied",
      code: "CART_INSUFFICIENT_STOCK",
    });
    throw new HttpsError("failed-precondition", "Requested quantity is unavailable.");
  }
}

export function assertCartSize(size) {
  if (size > orderConfig.maxCartItems) {
    throw new HttpsError("resource-exhausted", "Cart item limit reached.");
  }
}

export async function activeSeller(sellerId) {
  const [profile, seller] = await Promise.all([
    db.collection("users").doc(sellerId).get(),
    auth.getUser(sellerId),
  ]);
  return !seller.disabled &&
    profile.exists &&
    profile.get("disabled") !== true &&
    profile.get("deleted") !== true &&
    profile.get("status") !== "disabled" &&
    profile.get("status") !== "deleted";
}
