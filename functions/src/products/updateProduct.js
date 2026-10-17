import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import { roleFor } from "../middleware/auth.js";
import { db } from "../utils/firebase.js";
import {
  assertOwner,
  deny,
  productOperation,
  requestId,
} from "./shared/operations.js";
import {
  MAX_PENDING_PRODUCTS,
  NEW_ACCOUNT_PENDING_LIMIT,
} from "./shared/constants.js";
import { toProductDto } from "./shared/mappers.js";
import { updateProductSchema, productFieldsSchema } from "./shared/schemas.js";
import { slugify, uniqueSkuValues } from "./shared/slugs.js";
import {
  checkSkuReservations,
  countSellerProducts,
  findAvailableSlug,
  reservationId,
} from "./shared/transactions.js";
import {
  getCategoryReferences,
  validateImagePaths,
  verifyImages,
} from "./shared/validators.js";

export async function updateProductOperation(request) {
  return productOperation(request, "updateProduct", updateProductSchema, async (input, caller, newAccount) => {
    const productRef = db.collection("products").doc(input.productId);
    const initial = await productRef.get();
    if (!initial.exists) throw new HttpsError("not-found", "Product not found.");
    assertOwner(initial.data(), caller.uid, "updateProduct");
    if (initial.get("version") !== input.expectedVersion) {
      deny("PRODUCT_VERSION_CONFLICT", "failed-precondition");
    }

    const { productId, expectedVersion, ...changes } = input;
    const initialData = initial.data();
    const contentFields = [
      "name",
      "description",
      "price",
      "currency",
      "categoryId",
      "subCategoryId",
      "images",
      "stock",
      "sku",
      "brand",
      "tags",
      "compareAtPrice",
      "weightGrams",
      "dimensions",
      "condition",
      "variants",
    ];
    const proposed = Object.fromEntries(contentFields.map((field) => [
      field,
      changes[field] === undefined ? initialData[field] : changes[field],
    ]).filter(([, value]) => value !== undefined));
    const parsedProduct = productFieldsSchema.safeParse(proposed);
    if (!parsedProduct.success) {
      throw new HttpsError("invalid-argument", "Invalid request.");
    }
    validateImagePaths(parsedProduct.data.images, caller.uid);
    await verifyImages(parsedProduct.data.images);

    const sensitiveChange = initialData.status === "active" && (
      changes.price !== undefined ||
      changes.compareAtPrice !== undefined ||
      changes.currency !== undefined ||
      changes.images !== undefined ||
      changes.categoryId !== undefined ||
      changes.subCategoryId !== undefined ||
      changes.variants !== undefined
    );
    const nextStatus = sensitiveChange
      ? "pending_review"
      : initialData.status === "rejected"
        ? "draft"
        : initialData.status;
    const slugChanged = changes.name !== undefined && changes.name !== initialData.name;
    const skuValues = uniqueSkuValues(parsedProduct.data);
    const oldSkuValues = uniqueSkuValues(initialData);
    const pendingLimit = newAccount ? NEW_ACCOUNT_PENDING_LIMIT : MAX_PENDING_PRODUCTS;

    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(productRef);
      if (!current.exists) throw new HttpsError("not-found", "Product not found.");
      const currentData = current.data();
      assertOwner(currentData, caller.uid, "updateProduct");
      if (currentData.version !== expectedVersion) {
        deny("PRODUCT_VERSION_CONFLICT", "failed-precondition");
      }
      if (!["draft", "pending_review", "active", "rejected"].includes(currentData.status)) {
        deny("PRODUCT_INVALID_TRANSITION");
      }

      await getCategoryReferences(transaction, parsedProduct.data.categoryId, parsedProduct.data.subCategoryId);
      if (sensitiveChange) {
        const pending = await countSellerProducts(
          transaction,
          caller.uid,
          "pending_review",
          pendingLimit,
        );
        if (pending >= pendingLimit) deny("PRODUCT_PENDING_QUOTA_EXCEEDED", "resource-exhausted");
      }

      let newSlug;
      if (slugChanged) {
        newSlug = await findAvailableSlug(
          transaction,
          "_productSlugs",
          slugify(changes.name),
          productId,
        );
      }
      const skuReferences = await checkSkuReservations(
        transaction,
        caller.uid,
        skuValues,
        productId,
      );

      const updatedAt = FieldValue.serverTimestamp();
      const next = {
        ...changes,
        ...(newSlug ? { slug: newSlug.slug } : {}),
        status: nextStatus,
        moderationStatus: sensitiveChange
          ? "pending"
          : currentData.status === "rejected"
            ? "not_submitted"
            : currentData.moderationStatus,
        moderationReason: currentData.status === "rejected" ? null : currentData.moderationReason,
        needsReview: sensitiveChange ? true : currentData.needsReview,
        version: currentData.version + 1,
        updatedAt,
      };
      transaction.update(productRef, next);
      if (newSlug && newSlug.slug !== currentData.slug) {
        transaction.create(newSlug.reference, { targetId: productId });
        transaction.delete(db.collection("_productSlugs").doc(currentData.slug));
      }
      const retainedSkus = new Set(skuValues);
      for (const oldSku of oldSkuValues) {
        if (!retainedSkus.has(oldSku)) {
          transaction.delete(db.collection("_sellerSkus").doc(
            reservationId(`${caller.uid}:${oldSku}`),
          ));
        }
      }
      skuReferences.forEach((reference) =>
        transaction.set(reference, { productId, sellerId: caller.uid }),
      );

      if (nextStatus !== currentData.status) {
        const auditRef = db.collection("auditLogs").doc();
        transaction.create(auditRef, {
          actorUid: caller.uid,
          actorRole: roleFor(caller),
          action: "product_status_forced_by_update",
          targetId: productId,
          before: { status: currentData.status, version: currentData.version },
          after: { status: nextStatus, version: currentData.version + 1 },
          reason: sensitiveChange ? "Sensitive product changes require review." : "Rejected product edited.",
          timestamp: updatedAt,
          requestId: requestId(request),
          ip: request.rawRequest?.ip ?? null,
        });
      }
      return true;
    });

    if (sensitiveChange) {
      logger.info("Active product sent for review after edit", {
        event: "product_status_transition",
        action: "updateProduct",
        outcome: "success",
        code: "PRODUCT_ACTIVE_TO_PENDING_REVIEW",
      });
    }
    const saved = await productRef.get();
    if (!saved.exists) throw new HttpsError("internal", "Unable to complete the request.");
    return { product: toProductDto(saved) };
  });
}
