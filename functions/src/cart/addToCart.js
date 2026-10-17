import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase.js";
import { orderConfig } from "../orders/shared/config.js";
import { addToCartSchema } from "./shared/schemas.js";
import { assertCartSize, assertStock, cartItemId, productVariantId, validateCartProduct } from "./shared/items.js";
import { cartOperation } from "./shared/operation.js";

export const addToCart = cartOperation("addToCart", addToCartSchema, async (input, caller) => {
  const { snapshot } = await validateCartProduct(
    input.productId,
    input.variantId,
    caller.uid,
  );
  const variantId = input.variantId ?? null;
  const reference = db.collection("carts").doc(caller.uid)
    .collection("items").doc(cartItemId(input.productId, variantId));
  const productRef = db.collection("products").doc(snapshot.id);
  let savedQuantity;
  await db.runTransaction(async (transaction) => {
    const [product, lines] = await Promise.all([
      transaction.get(productRef),
      transaction.get(reference.parent),
    ]);
    if (
      !product.exists ||
      product.get("status") !== "active" ||
      product.get("archived") === true
    ) {
      throw new HttpsError("failed-precondition", "Product is unavailable.");
    }
    if (product.get("sellerId") === caller.uid) {
      throw new HttpsError("failed-precondition", "Product is unavailable.");
    }
    const sellerProfile = await transaction.get(
      db.collection("users").doc(product.get("sellerId")),
    );
    if (
      !sellerProfile.exists ||
      sellerProfile.get("disabled") === true ||
      sellerProfile.get("deleted") === true ||
      ["disabled", "deleted"].includes(sellerProfile.get("status"))
    ) {
      throw new HttpsError("failed-precondition", "Product is unavailable.");
    }
    const currentVariant = variantId == null
      ? null
      : (product.get("variants") ?? []).find((entry) => productVariantId(entry) === variantId);
    if (variantId != null && !currentVariant) {
      throw new HttpsError("failed-precondition", "Product variant is unavailable.");
    }
    const existing = await transaction.get(reference);
    const nextQuantity = (existing.get("quantity") ?? 0) + input.quantity;
    if (nextQuantity > orderConfig.maxQuantity) {
      throw new HttpsError("invalid-argument", "Invalid request.");
    }
    assertStock({ data: product.data(), variant: currentVariant }, nextQuantity);
    assertCartSize(lines.size + (existing.exists ? 0 : 1));
    savedQuantity = nextQuantity;
    transaction.set(reference, {
      productId: input.productId,
      variantId,
      quantity: nextQuantity,
    });
  });
  return { item: { productId: input.productId, variantId, quantity: savedQuantity } };
});
