import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase.js";
import { assertOwner, deny, productOperation } from "./shared/operations.js";
import { toProductDto } from "./shared/mappers.js";
import { productIdSchema } from "./shared/schemas.js";

export async function archiveProductOperation(request) {
  return productOperation(request, "archiveProduct", productIdSchema, async (input, caller) => {
    const productRef = db.collection("products").doc(input.productId);
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(productRef);
      if (!snapshot.exists) throw new HttpsError("not-found", "Product not found.");
      assertOwner(snapshot.data(), caller.uid, "archiveProduct");
      if (snapshot.get("status") !== "active") {
        deny("PRODUCT_INVALID_TRANSITION");
      }
      const updated = {
        status: "archived",
        moderationStatus: "archived",
        version: snapshot.get("version") + 1,
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.update(productRef, updated);
      return true;
    });
    const saved = await productRef.get();
    if (!saved.exists) throw new HttpsError("internal", "Unable to complete the request.");
    return { product: toProductDto(saved) };
  });
}
