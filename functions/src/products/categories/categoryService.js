import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../../utils/firebase.js";
import { auditEntry, auditReference, deny, requestId } from "../shared/operations.js";
import { toCategoryDto } from "../shared/mappers.js";
import { findAvailableSlug } from "../shared/transactions.js";
import { slugify } from "../shared/slugs.js";
import { validateCategoryParent } from "../shared/validators.js";

export async function deactivateCategory(request, caller, categoryId, action) {
  const categoryRef = db.collection("categories").doc(categoryId);
  const before = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(categoryRef);
    if (!snapshot.exists) throw new HttpsError("not-found", "Category not found.");
    if (snapshot.get("active") !== true) return null;
    transaction.update(categoryRef, {
      deactivationState: "in_progress",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return snapshot.data();
  });

  if (before) {
    let cursor;
    while (true) {
      let query = db.collection("products")
        .where(
          before.parentId == null ? "categoryId" : "subCategoryId",
          "==",
          categoryId,
        )
        .orderBy(FieldPath.documentId())
        .limit(400);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      const batch = db.batch();
      let changed = false;
      for (const product of page.docs) {
        if (product.get("needsReview") === true &&
          product.get("moderationStatus") === "review_required") continue;
        changed = true;
        batch.update(product.ref, {
          needsReview: true,
          moderationStatus: "review_required",
          updatedAt: FieldValue.serverTimestamp(),
          version: FieldValue.increment(1),
        });
      }
      if (changed) await batch.commit();
      cursor = page.docs.at(-1);
      if (page.size < 400) break;
    }
  }

  const auditRef = auditReference();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(categoryRef);
    if (!snapshot.exists) throw new HttpsError("not-found", "Category not found.");
    if (snapshot.get("active") !== true) return { category: toCategoryDto(snapshot) };
    if (snapshot.get("deactivationState") !== "in_progress") {
      deny("CATEGORY_DEACTIVATION_STATE_CHANGED");
    }
    const after = {
      active: false,
      deactivationState: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.update(categoryRef, after);
    transaction.create(auditRef, auditEntry(request, caller, {
      action,
      targetId: categoryId,
      before: { id: categoryId, name: snapshot.get("name"), active: true },
      after: { id: categoryId, name: snapshot.get("name"), active: false },
      id: requestId(request),
    }));
    return {
      category: {
        id: categoryId,
        name: snapshot.get("name"),
        slug: snapshot.get("slug"),
        parentId: snapshot.get("parentId") ?? null,
        active: false,
        createdAt: snapshot.get("createdAt")?.toDate().toISOString() ?? null,
        updatedAt: Timestamp.now().toDate().toISOString(),
      },
    };
  });
}

export async function updateCategoryTransaction(request, input, caller) {
  const categoryRef = db.collection("categories").doc(input.categoryId);
  const auditRef = auditReference();
  return db.runTransaction(async (transaction) => {
    const current = await transaction.get(categoryRef);
    if (!current.exists) throw new HttpsError("not-found", "Category not found.");
    if (current.get("deactivationState") === "in_progress") {
      deny("CATEGORY_DEACTIVATION_IN_PROGRESS");
    }
    const currentData = current.data();
    const nextName = input.name ?? currentData.name;
    const nextParentId = input.parentId === undefined
      ? currentData.parentId ?? null
      : input.parentId;

    if (nextParentId === input.categoryId) deny("CATEGORY_PARENT_CYCLE", "invalid-argument");
    if (input.active === true && nextParentId !== null) {
      await validateCategoryParent(nextParentId, transaction);
    }
    if (nextParentId !== currentData.parentId) {
      const children = await transaction.get(
        db.collection("categories").where("parentId", "==", input.categoryId).limit(1),
      );
      const productReferences = await Promise.all([
        transaction.get(
          db.collection("products").where("categoryId", "==", input.categoryId).limit(1),
        ),
        transaction.get(
          db.collection("products").where("subCategoryId", "==", input.categoryId).limit(1),
        ),
      ]);
      if (!children.empty || productReferences.some((products) => !products.empty)) {
        deny("CATEGORY_PARENT_IN_USE");
      }
      if (nextParentId !== null) {
        await validateCategoryParent(nextParentId, transaction);
      }
    }

    let slug;
    if (nextName !== currentData.name) {
      slug = await findAvailableSlug(
        transaction,
        "_categorySlugs",
        slugify(nextName),
        input.categoryId,
      );
    }
    const now = FieldValue.serverTimestamp();
    const updatedFields = {
      ...(input.name !== undefined ? { name: nextName } : {}),
      ...(input.parentId !== undefined ? { parentId: nextParentId } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(slug ? { slug: slug.slug } : {}),
      updatedAt: now,
    };
    transaction.update(categoryRef, updatedFields);
    if (slug && slug.slug !== currentData.slug) {
      transaction.create(slug.reference, { targetId: input.categoryId });
      transaction.delete(db.collection("_categorySlugs").doc(currentData.slug));
    }

    const after = { ...currentData, ...updatedFields };
    transaction.create(auditRef, auditEntry(request, caller, {
      action: "category_update",
      targetId: input.categoryId,
      before: toCategoryDto({ id: input.categoryId, ...currentData }),
      after: toCategoryDto({ id: input.categoryId, ...after }),
    }));
    return toCategoryDto({ id: input.categoryId, ...after });
  });
}
