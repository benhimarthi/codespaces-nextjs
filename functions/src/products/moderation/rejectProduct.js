import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../../utils/firebase.js";
import { auditEntry, auditReference, deny, runAdmin } from "../shared/operations.js";
import { toProductDto } from "../shared/mappers.js";
import { rejectProductSchema } from "../shared/schemas.js";

export async function rejectProductOperation(request) {
  return runAdmin(request, "rejectProduct", rejectProductSchema, async (input, caller) => {
    const productRef = db.collection("products").doc(input.productId);
    const auditRef = auditReference();
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(productRef);
      if (!current.exists) throw new HttpsError("not-found", "Product not found.");
      if (current.get("status") !== "pending_review") {
        deny("PRODUCT_INVALID_TRANSITION");
      }
      const updated = {
        status: "rejected",
        moderationStatus: "rejected",
        moderationReason: input.reason,
        needsReview: false,
        version: current.get("version") + 1,
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.update(productRef, updated);
      transaction.create(auditRef, auditEntry(request, caller, {
        action: "product_reject",
        targetId: input.productId,
        before: { status: "pending_review", version: current.get("version") },
        after: { status: "rejected", version: current.get("version") + 1 },
        reason: input.reason,
      }));
    });
    const saved = await productRef.get();
    if (!saved.exists) throw new HttpsError("internal", "Unable to complete the request.");
    return { product: toProductDto(saved) };
  });
}
