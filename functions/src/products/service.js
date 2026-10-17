import { FirebaseAuthError } from "firebase-admin/auth";
import { logger } from "firebase-functions";
import { HttpsError, onRequest } from "firebase-functions/v2/https";
import {
  approveProductOperation,
  archiveProductOperation,
  createCategoryOperation,
  createProductOperation,
  getMyProductsOperation,
  rejectProductOperation,
  setCategoryActiveOperation,
  submitForReviewOperation,
  updateCategoryOperation,
  updateProductOperation,
} from "./routes.js";
import { runSafely } from "../utils/errors.js";
import { auth } from "../utils/firebase.js";
import { productServiceOptions } from "./shared/options.js";

const routes = new Map([
  ["POST /products/create", createProductOperation],
  ["POST /products/update", updateProductOperation],
  ["POST /products/archive", archiveProductOperation],
  ["POST /products/mine", getMyProductsOperation],
  ["POST /products/submit-for-review", submitForReviewOperation],
  ["POST /categories/create", createCategoryOperation],
  ["POST /categories/update", updateCategoryOperation],
  ["POST /categories/set-active", setCategoryActiveOperation],
  ["POST /moderation/approve", approveProductOperation],
  ["POST /moderation/reject", rejectProductOperation],
]);

const httpStatusByCode = {
  "invalid-argument": 400,
  unauthenticated: 401,
  "permission-denied": 403,
  "not-found": 404,
  "already-exists": 409,
  "failed-precondition": 412,
  "resource-exhausted": 429,
  unavailable: 503,
  "deadline-exceeded": 504,
  internal: 500,
};

const invalidAuthTokenCodes = new Set([
  "auth/argument-error",
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/invalid-id-token",
  "auth/user-disabled",
  "auth/user-not-found",
]);

function sendError(response, error) {
  const httpsError = error instanceof HttpsError
    ? error
    : new HttpsError("internal", "Unable to complete the request.");
  response.status(httpStatusByCode[httpsError.code] ?? 500).json({
    error: {
      status: httpsError.code.toUpperCase().replaceAll("-", "_"),
      message: httpsError.message,
    },
  });
}

async function verifyRequest(request) {
  const authorization = request.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    logger.warn("Product authentication required", {
      event: "product_authentication",
      outcome: "unauthenticated",
      code: "PRODUCT_AUTH_REQUIRED",
    });
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  try {
    const token = await auth.verifyIdToken(match[1], true);
    return { uid: token.uid, token };
  } catch (error) {
    if (
      !(error instanceof FirebaseAuthError) ||
      !invalidAuthTokenCodes.has(error.code)
    ) {
      throw error;
    }
    logger.warn("Product ID token rejected", {
      event: "product_authentication",
      outcome: "unauthenticated",
      code: "PRODUCT_AUTH_TOKEN_INVALID",
    });
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
}

export const productService = onRequest(productServiceOptions(), async (request, response) => {
  response.set("Cache-Control", "no-store");
  const operation = routes.get(`${request.method} ${request.path}`);
  if (!operation) {
    response.status(404).json({
      error: {
        status: "NOT_FOUND",
        message: "Endpoint not found.",
      },
    });
    return;
  }

  try {
    const result = await runSafely("product_service", async () => {
      const data = request.body ?? {};
      if (
        typeof data !== "object" ||
        data === null ||
        Array.isArray(data) ||
        Buffer.byteLength(JSON.stringify(data), "utf8") > 100 * 1024
      ) {
        throw new HttpsError("invalid-argument", "Invalid request.");
      }
      const caller = await verifyRequest(request);
      return operation({
        auth: caller,
        rawRequest: request,
        data,
      });
    });
    response.status(200).json(result);
  } catch (error) {
    sendError(response, error);
  }
});
