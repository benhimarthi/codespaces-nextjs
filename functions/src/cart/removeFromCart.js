import { db } from "../utils/firebase.js";
import { removeFromCartSchema } from "./shared/schemas.js";
import { cartItemId } from "./shared/items.js";
import { cartOperation } from "./shared/operation.js";

export const removeFromCart = cartOperation(
  "removeFromCart",
  removeFromCartSchema,
  async (input, caller) => {
    await db.collection("carts").doc(caller.uid)
      .collection("items").doc(cartItemId(input.productId, input.variantId))
      .delete();
    return { removed: true };
  },
);
