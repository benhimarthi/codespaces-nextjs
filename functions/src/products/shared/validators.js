import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../../utils/firebase.js";
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES } from "./constants.js";

const bucket = process.env.FIREBASE_STORAGE_BUCKET
  ? getStorage().bucket(process.env.FIREBASE_STORAGE_BUCKET)
  : getStorage().bucket();

function reject(code, httpsCode = "invalid-argument") {
  logger.warn("Product integrity check rejected", {
    event: "product_integrity",
    outcome: "denied",
    code,
  });
  throw new HttpsError(httpsCode, "Request cannot be completed.");
}

export function validateImagePaths(paths, uid) {
  const prefix = `products/${uid}/`;
  if (paths.some((path) =>
    !path.startsWith(prefix) ||
    path.length <= prefix.length ||
    path.includes("..") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    /^https?:/i.test(path)
  )) {
    reject("PRODUCT_IMAGE_PATH_INVALID");
  }
}

export async function verifyImages(paths) {
  await Promise.all(paths.map(async (path) => {
    let metadata;
    try {
      [metadata] = await bucket.file(path).getMetadata();
    } catch (error) {
      if (error?.code === 404 || error?.code === "404") {
        reject("PRODUCT_IMAGE_MISSING");
      }
      throw error;
    }
    const size = Number(metadata.size);
    if (
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_IMAGE_BYTES ||
      !IMAGE_CONTENT_TYPES.includes(metadata.contentType)
    ) {
      reject("PRODUCT_IMAGE_METADATA_INVALID");
    }
  }));
}

export async function getCategoryReferences(transaction, categoryId, subCategoryId) {
  const categoryRef = db.collection("categories").doc(categoryId);
  const subCategoryRef = db.collection("categories").doc(subCategoryId);
  const [category, subCategory] = await Promise.all([
    transaction.get(categoryRef),
    transaction.get(subCategoryRef),
  ]);
  if (
    !category.exists ||
    category.get("active") !== true ||
    category.get("deactivationState") === "in_progress" ||
    category.get("parentId") != null ||
    !subCategory.exists ||
    subCategory.get("active") !== true ||
    subCategory.get("deactivationState") === "in_progress" ||
    subCategory.get("parentId") !== categoryId
  ) {
    reject("PRODUCT_CATEGORY_UNAVAILABLE", "failed-precondition");
  }
  return { categoryRef, subCategoryRef };
}

export async function validateCategoryParent(parentId, transaction) {
  if (parentId === undefined || parentId === null) return null;
  const parentRef = db.collection("categories").doc(parentId);
  const parent = await transaction.get(parentRef);
  if (
    !parent.exists ||
    parent.get("parentId") != null ||
    parent.get("active") !== true ||
    parent.get("deactivationState") === "in_progress"
  ) {
    reject("PRODUCT_CATEGORY_PARENT_UNAVAILABLE", "failed-precondition");
  }
  return parentRef;
}
