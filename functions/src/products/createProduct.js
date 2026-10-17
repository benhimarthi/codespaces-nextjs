import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase.js";
import { deny, productOperation } from "./shared/operations.js";
import {
  MAX_PENDING_PRODUCTS,
  NEW_ACCOUNT_PENDING_LIMIT,
} from "./shared/constants.js";
import { toProductDto } from "./shared/mappers.js";
import { createProductSchema } from "./shared/schemas.js";
import { slugify, uniqueSkuValues } from "./shared/slugs.js";
import {
  checkSkuReservations,
  countSellerProducts,
  findAvailableSlug,
  reservationId,
  stableStringify,
} from "./shared/transactions.js";
import { getCategoryReferences, validateImagePaths, verifyImages } from "./shared/validators.js";

export async function createProductOperation(request) {
  return productOperation(request, "createProduct", createProductSchema, async (input, caller, newAccount) => {
    validateImagePaths(input.images, caller.uid);
    await verifyImages(input.images);

    const { requestId, submitForReview = false, ...productInput } = input;
    const status = submitForReview ? "pending_review" : "draft";
    const payloadHash = createHash("sha256").update(stableStringify(input)).digest("hex");
    const idempotencyRef = db.collection("_productRequests").doc(
      reservationId(`${caller.uid}:${requestId}`),
    );
    const proposedProductId = randomUUID();
    const productRef = db.collection("products").doc(proposedProductId);
    const pendingLimit = newAccount ? NEW_ACCOUNT_PENDING_LIMIT : MAX_PENDING_PRODUCTS;

    const resultProductId = await db.runTransaction(async (transaction) => {
      const receipt = await transaction.get(idempotencyRef);
      if (receipt.exists) {
        if (receipt.get("payloadHash") !== payloadHash) {
          deny("PRODUCT_REQUEST_ID_REUSED", "already-exists");
        }
        const existing = await transaction.get(db.collection("products").doc(receipt.get("productId")));
        if (!existing.exists) {
          throw new HttpsError("internal", "Unable to complete the request.");
        }
        return existing.id;
      }

      await getCategoryReferences(transaction, input.categoryId, input.subCategoryId);
      if (status === "pending_review") {
        const pending = await countSellerProducts(
          transaction,
          caller.uid,
          "pending_review",
          pendingLimit,
        );
        if (pending >= pendingLimit) {
          deny("PRODUCT_PENDING_QUOTA_EXCEEDED", "resource-exhausted");
        }
      }
      const slugResult = await findAvailableSlug(
        transaction,
        "_productSlugs",
        slugify(input.name),
        proposedProductId,
      );
      const skuValues = uniqueSkuValues(productInput);
      const skuReferences = await checkSkuReservations(
        transaction,
        caller.uid,
        skuValues,
        proposedProductId,
      );
      const now = FieldValue.serverTimestamp();
      const product = {
        ...productInput,
        sellerId: caller.uid,
        status,
        moderationStatus: status === "pending_review" ? "pending" : "not_submitted",
        moderationReason: null,
        needsReview: false,
        slug: slugResult.slug,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };

      transaction.create(productRef, product);
      transaction.create(slugResult.reference, { targetId: proposedProductId });
      skuReferences.forEach((reference) =>
        transaction.create(reference, { productId: proposedProductId, sellerId: caller.uid }),
      );
      transaction.create(idempotencyRef, {
        productId: proposedProductId,
        payloadHash,
        createdAt: now,
      });
      return proposedProductId;
    });
    const saved = await db.collection("products").doc(resultProductId).get();
    if (!saved.exists) throw new HttpsError("internal", "Unable to complete the request.");

    logger.info("Product created", {
      event: "product_create",
      outcome: "success",
      status,
    });
    return { product: toProductDto(saved) };
  });
}
