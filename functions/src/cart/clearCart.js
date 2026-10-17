import { db } from "../utils/firebase.js";
import { emptyCartSchema } from "./shared/schemas.js";
import { cartOperation } from "./shared/operation.js";

export const clearCart = cartOperation("clearCart", emptyCartSchema, async (_input, caller) => {
  const items = await db.collection("carts").doc(caller.uid).collection("items").get();
  const batch = db.batch();
  items.docs.forEach((item) => batch.delete(item.ref));
  await batch.commit();
  return { cleared: items.size };
});
