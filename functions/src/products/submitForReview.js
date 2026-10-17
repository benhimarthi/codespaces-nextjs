import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase.js";
import { assertOwner, deny, productOperation } from "./shared/operations.js";
import {
  MAX_PENDING_PRODUCTS,
  NEW_ACCOUNT_PENDING_LIMIT,
} from "./shared/constants.js";
import { toProductDto } from "./shared/mappers.js";
import { productIdSchema } from "./shared/schemas.js";
import { countSellerProducts } from "./shared/transactions.js";
import {
  getCategoryReferences,
  validateImagePaths,
  verifyImages,
} from "./shared/validators.js";

export async function submitForReviewOperation(request) {
  return productOperation(request, "submitForReview", productIdSchema, async (input, caller, newAccount) => {
    const productRef = db.collection("products").doc(input.productId);
    const initial = await productRef.get();
    if (!initial.exists) throw new HttpsError("not-found", "Product not found.");
    assertOwner(initial.data(), caller.uid, "submitForReview");
    if (initial.get("status") !== "draft") deny("PRODUCT_INVALID_TRANSITION");
    validateImagePaths(initial.get("images"), caller.uid);
    await verifyImages(initial.get("images"));

    const pendingLimit = newAccount ? NEW_ACCOUNT_PENDING_LIMIT : MAX_PENDING_PRODUCTS;
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(productRef);
      if (!current.exists) throw new HttpsError("not-found", "Product not found.");
      assertOwner(current.data(), caller.uid, "submitForReview");
      if (current.get("status") !== "draft") deny("PRODUCT_INVALID_TRANSITION");
      await getCategoryReferences(
        transaction,
        current.get("categoryId"),
        current.get("subCategoryId"),
      );
      const pending = await countSellerProducts(
        transaction,
        caller.uid,
        "pending_review",
        pendingLimit,
      );
      if (pending >= pendingLimit) deny("PRODUCT_PENDING_QUOTA_EXCEEDED", "resource-exhausted");

      const updated = {
        status: "pending_review",
        moderationStatus: "pending",
        needsReview: false,
        version: current.get("version") + 1,
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
