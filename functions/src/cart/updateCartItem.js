import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase.js";
import { updateCartItemSchema } from "./shared/schemas.js";
import { assertStock, cartItemId, productVariantId, validateCartProduct } from "./shared/items.js";
import { cartOperation } from "./shared/operation.js";

export const updateCartItem = cartOperation(
  "updateCartItem",
  updateCartItemSchema,
  async (input, caller) => {
    const { snapshot } = await validateCartProduct(input.productId, input.variantId, caller.uid);
    const variantId = input.variantId ?? null;
    const reference = db.collection("carts").doc(caller.uid)
      .collection("items").doc(cartItemId(input.productId, variantId));
    const productRef = db.collection("products").doc(snapshot.id);
    await db.runTransaction(async (transaction) => {
      const [product, existing] = await Promise.all([
        transaction.get(productRef),
        transaction.get(reference),
      ]);
      if (
        !product.exists ||
        !existing.exists ||
        product.get("status") !== "active" ||
        product.get("archived") === true
      ) {
        throw new HttpsError("not-found", "Cart item not found.");
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
      const variant = variantId == null
        ? null
        : (product.get("variants") ?? []).find((entry) => productVariantId(entry) === variantId);
      if (variantId != null && !variant) {
        throw new HttpsError("failed-precondition", "Product variant is unavailable.");
      }
      assertStock({ data: product.data(), variant }, input.quantity);
      transaction.update(reference, { quantity: input.quantity });
    });
    return { item: { productId: input.productId, variantId, quantity: input.quantity } };
  },
);
