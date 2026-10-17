import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../../utils/firebase.js";
import { auditEntry, auditReference, deny, runAdmin } from "../shared/operations.js";
import { setCategoryActiveSchema } from "../shared/schemas.js";
import { deactivateCategory } from "./categoryService.js";
import { FieldValue } from "firebase-admin/firestore";
import { toCategoryDto } from "../shared/mappers.js";

export async function setCategoryActiveOperation(request) {
  return runAdmin(request, "setCategoryActive", setCategoryActiveSchema, async (input, caller) => {
    if (!input.active) {
      return deactivateCategory(
        request,
        caller,
        input.categoryId,
        "category_deactivate",
      );
    }
    const categoryRef = db.collection("categories").doc(input.categoryId);
    const auditRef = auditReference();
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(categoryRef);
      if (!current.exists) throw new HttpsError("not-found", "Category not found.");
      if (current.get("deactivationState") === "in_progress") {
        throw new HttpsError("failed-precondition", "Category update in progress.");
      }
      const data = current.data();
      if (data.parentId != null) {
        const parent = await transaction.get(db.collection("categories").doc(data.parentId));
        if (!parent.exists || parent.get("active") !== true) {
          deny("CATEGORY_PARENT_INACTIVE");
        }
      }
      transaction.update(categoryRef, {
        active: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.create(auditRef, auditEntry(request, caller, {
        action: "category_update",
        targetId: input.categoryId,
        before: toCategoryDto({ id: input.categoryId, ...data }),
        after: { ...toCategoryDto({ id: input.categoryId, ...data }), active: true },
      }));
    });
    const saved = await categoryRef.get();
    if (!saved.exists) throw new HttpsError("internal", "Unable to complete the request.");
    return { category: toCategoryDto(saved) };
  });
}
