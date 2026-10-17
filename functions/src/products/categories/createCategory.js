import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../../utils/firebase.js";
import { auditEntry, auditReference, runAdmin } from "../shared/operations.js";
import { toCategoryDto } from "../shared/mappers.js";
import { createCategorySchema } from "../shared/schemas.js";
import { slugify } from "../shared/slugs.js";
import { findAvailableSlug } from "../shared/transactions.js";
import { validateCategoryParent } from "../shared/validators.js";

export async function createCategoryOperation(request) {
  return runAdmin(request, "createCategory", createCategorySchema, async (input, caller) => {
    const categoryId = randomUUID();
    const categoryRef = db.collection("categories").doc(categoryId);
    const auditRef = auditReference();
    const category = await db.runTransaction(async (transaction) => {
      const parentRef = await validateCategoryParent(input.parentId, transaction);
      const slugResult = await findAvailableSlug(
        transaction,
        "_categorySlugs",
        slugify(input.name),
        categoryId,
      );
      const now = FieldValue.serverTimestamp();
      const data = {
        name: input.name,
        slug: slugResult.slug,
        parentId: parentRef ? input.parentId : null,
        active: input.active ?? true,
        createdAt: now,
        updatedAt: now,
      };
      transaction.create(categoryRef, data);
      transaction.create(slugResult.reference, { targetId: categoryId });
      transaction.create(auditRef, auditEntry(request, caller, {
        action: "category_create",
        targetId: categoryId,
        before: null,
        after: { name: input.name, slug: slugResult.slug, parentId: data.parentId, active: data.active },
      }));
      return toCategoryDto({ id: categoryId, ...data });
    });
    const saved = await categoryRef.get();
    if (!saved.exists) throw new HttpsError("internal", "Unable to complete the request.");
    return { category: toCategoryDto(saved) };
  });
}
