import { activeSeller } from "./shared/items.js";
import { cartItemId, productVariantId } from "./shared/items.js";
import { db } from "../utils/firebase.js";
import { getMyCartSchema } from "./shared/schemas.js";
import { cartOperation } from "./shared/operation.js";

export const getMyCart = cartOperation("getMyCart", getMyCartSchema, async (input, caller) => {
  const cart = await db.collection("carts").doc(caller.uid).collection("items").get();
  const sellerStatus = new Map();
  const previousPrices = new Map((input.knownPrices ?? []).map((entry) => [
    cartItemId(entry.productId, entry.variantId),
    entry,
  ]));
  const items = await Promise.all(cart.docs.map(async (line) => {
    const saved = line.data();
    const productSnapshot = await db.collection("products").doc(saved.productId).get();
    if (!productSnapshot.exists) {
      return {
        productId: saved.productId,
        variantId: saved.variantId ?? null,
        quantity: saved.quantity,
        available: false,
        unavailableReason: "product_unavailable",
      };
    }
    const product = productSnapshot.data();
    if (!sellerStatus.has(product.sellerId)) {
      sellerStatus.set(product.sellerId, activeSeller(product.sellerId));
    }
    const sellerEnabled = await sellerStatus.get(product.sellerId);
    const variant = saved.variantId == null
      ? null
      : (product.variants ?? []).find((candidate) => productVariantId(candidate) === saved.variantId);
    const unitPrice = variant?.price ?? product.price;
    const currency = product.currency;
    const available = product.status === "active" &&
      product.archived !== true &&
      product.sellerId !== caller.uid &&
      sellerEnabled &&
      (saved.variantId == null || variant !== null) &&
      (variant ? variant.stock : product.stock) >= saved.quantity;
    const previous = previousPrices.get(line.id);
    return {
      productId: saved.productId,
      variantId: saved.variantId ?? null,
      quantity: saved.quantity,
      name: product.name,
      unitPrice,
      currency,
      imagePath: product.images?.[0] ?? null,
      available,
      priceChanged: previous !== undefined &&
        (previous.price !== unitPrice || previous.currency !== currency),
      ...(available ? {} : { unavailableReason: "product_unavailable" }),
    };
  }));
  return { items };
});
