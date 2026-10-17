import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../../utils/firebase.js";
import { auditEntry, auditReference, deny, runAdmin } from "../shared/operations.js";
import { toProductDto } from "../shared/mappers.js";
import { moderationSchema } from "../shared/schemas.js";
import {
  MAX_ACTIVE_PRODUCTS,
  NEW_ACCOUNT_ACTIVE_LIMIT,
  NEW_ACCOUNT_AGE_DAYS,
} from "../shared/constants.js";
import { getCategoryReferences } from "../shared/validators.js";

export async function approveProductOperation(request) {
  return runAdmin(request, "approveProduct", moderationSchema, async (input, caller) => {
    const productRef = db.collection("products").doc(input.productId);
    const auditRef = auditReference();
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(productRef);
      if (!current.exists) throw new HttpsError("not-found", "Product not found.");
      if (current.get("status") !== "pending_review") {
        deny("PRODUCT_INVALID_TRANSITION");
      }
      await getCategoryReferences(
        transaction,
        current.get("categoryId"),
        current.get("subCategoryId"),
      );
      const sellerProfile = await transaction.get(db.collection("users").doc(current.get("sellerId")));
      const createdAt = sellerProfile.get("createdAt");
      const ageDays = createdAt && typeof createdAt.toDate === "function"
        ? (Date.now() - createdAt.toDate().getTime()) / 86_400_000
        : 0;
      const activeLimit = ageDays < NEW_ACCOUNT_AGE_DAYS
        ? NEW_ACCOUNT_ACTIVE_LIMIT
        : MAX_ACTIVE_PRODUCTS;
      const activeProducts = await transaction.get(
        db.collection("products")
          .where("sellerId", "==", current.get("sellerId"))
          .where("status", "==", "active")
          .limit(activeLimit),
      );
      if (activeProducts.size >= activeLimit) {
        deny("PRODUCT_ACTIVE_QUOTA_EXCEEDED", "resource-exhausted");
      }
      const updated = {
        status: "active",
        moderationStatus: "approved",
        moderationReason: null,
        needsReview: false,
        version: current.get("version") + 1,
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.update(productRef, updated);
      transaction.create(auditRef, auditEntry(request, caller, {
        action: "product_approve",
        targetId: input.productId,
        before: { status: "pending_review", version: current.get("version") },
        after: { status: "active", version: current.get("version") + 1 },
      }));
    });
    const saved = await productRef.get();
    if (!saved.exists) throw new HttpsError("internal", "Unable to complete the request.");
    return { product: toProductDto(saved) };
  });
}
