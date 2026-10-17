import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import {
  requireAuth,
  requireMfa,
  requireRecentLogin,
  requireRole,
  roleFor,
} from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { runSafely } from "../../utils/errors.js";
import { auth, db } from "../../utils/firebase.js";
import {
  NEW_ACCOUNT_AGE_DAYS,
  NEW_ACCOUNT_RATE_FACTOR,
  ratePolicies,
} from "./constants.js";
const MAX_PAYLOAD_BYTES = 100 * 1024;

export function validatePayloadSize(data) {
  const serialized = JSON.stringify(data ?? null);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    logger.warn("Product request rejected", {
      event: "product_validation",
      outcome: "denied",
      code: "PRODUCT_PAYLOAD_TOO_LARGE",
    });
    throw new HttpsError("invalid-argument", "Invalid request.");
  }
}

export async function authenticateSeller(request, operation) {
  const caller = requireAuth(request);
  await rateLimit(request, `product:${operation}`, ratePolicies[operation]);

  const profileRef = db.collection("users").doc(caller.uid);
  const [profile, user] = await Promise.all([
    profileRef.get(),
    auth.getUser(caller.uid),
  ]);
  if (
    caller.token.email_verified !== true ||
    user.disabled ||
    !profile.exists ||
    profile.get("disabled") === true ||
    profile.get("deleted") === true ||
    profile.get("status") === "disabled" ||
    profile.get("status") === "deleted"
  ) {
    logger.warn("Product seller account rejected", {
      event: "product_account",
      action: operation,
      outcome: "denied",
      code: "PRODUCT_ACCOUNT_INELIGIBLE",
    });
    throw new HttpsError("permission-denied", "Permission denied.");
  }

  const createdAt = profile.get("createdAt");
  const accountCreatedAt = createdAt && typeof createdAt.toDate === "function"
    ? createdAt.toDate().getTime()
    : Date.parse(user.metadata.creationTime);
  const ageDays = Number.isFinite(accountCreatedAt)
    ? (Date.now() - accountCreatedAt) / 86_400_000
    : 0;
  const newAccount = ageDays < NEW_ACCOUNT_AGE_DAYS;
  if (newAccount) {
    await rateLimit(request, `product:new-account:${operation}`, {
      perUid: Math.max(1, Math.floor(ratePolicies[operation].perUid * NEW_ACCOUNT_RATE_FACTOR)),
      windowSeconds: ratePolicies[operation].windowSeconds,
    });
  }
  return { caller, newAccount };
}

export async function authenticateAdmin(request, operation) {
  const caller = requireAuth(request);
  await rateLimit(request, `admin:product:${operation}`, ratePolicies[operation]);
  requireRole(caller, "admin");
  const categoryOperation = [
    "createCategory",
    "updateCategory",
    "setCategoryActive",
  ].includes(operation);
  if (!categoryOperation || process.env.PRODUCT_CATEGORY_MFA_REQUIRED !== "false") {
    requireMfa(caller);
  }
  requireRecentLogin(caller);
  return caller;
}

export function deny(code, httpsCode = "failed-precondition", message = "Request cannot be completed.") {
  logger.warn("Product operation denied", {
    event: "product_security",
    outcome: "denied",
    code,
  });
  const error = new HttpsError(httpsCode, message);
  error.internalCode = code;
  throw error;
}

export function assertOwner(product, uid, operation) {
  if (product.sellerId !== uid) {
    logger.warn("Product ownership check denied", {
      event: "product_ownership",
      action: operation,
      outcome: "denied",
      code: "PRODUCT_NOT_FOUND",
    });
    throw new HttpsError("not-found", "Product not found.");
  }
}

export function requestId(request) {
  const supplied = request.rawRequest?.get("x-request-id");
  return typeof supplied === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied)
    ? supplied
    : randomUUID();
}

export function auditReference() {
  return db.collection("auditLogs").doc();
}

export function auditEntry(request, caller, { action, targetId, before, after, reason, id }) {
  return {
    actorUid: caller.uid,
    actorRole: roleFor(caller),
    action,
    targetId,
    before: before ?? null,
    after: after ?? null,
    reason: typeof reason === "string"
      ? reason
        .replace(/\bBearer\s+\S+/gi, "[REDACTED]")
        .replace(/\b(?:password|token|oobCode)\s*[:=]\s*\S+/gi, "[REDACTED]")
        .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
      : null,
    timestamp: FieldValue.serverTimestamp(),
    requestId: id ?? requestId(request),
    ip: request.rawRequest?.ip ?? null,
  };
}

export async function runAdmin(request, operation, schema, handler) {
  requireAuth(request);
  validatePayloadSize(request.data);
  let caller;
  try {
    caller = await authenticateAdmin(request, operation);
    let input;
    try {
      input = validate(schema, request.data);
    } catch (error) {
      logger.warn("Product admin input rejected", {
        event: "product_validation",
        action: operation,
        outcome: "denied",
        code: `PRODUCT_${operation.toUpperCase()}_INVALID_INPUT`,
      });
      throw error;
    }
    const result = await handler(input, caller);
    logger.info("Product admin action completed", {
      event: "product_admin_action",
      action: operation,
      actorRole: roleFor(caller),
      outcome: "success",
    });
    return result;
  } catch (error) {
    const code = typeof error?.internalCode === "string"
      ? error.internalCode
      : error instanceof HttpsError
        ? `PRODUCT_${operation.toUpperCase()}_${error.code.toUpperCase().replaceAll("-", "_")}`
        : `PRODUCT_${operation.toUpperCase()}_FAILED`;
    logger.warn("Product admin action rejected", {
      event: "product_admin_action",
      action: operation,
      outcome: "denied",
      code,
    });
    throw error;
  }
}

export function productOperation(request, operation, schema, handler) {
  requireAuth(request);
  validatePayloadSize(request.data);
  return (async () => {
    const { caller, newAccount } = await authenticateSeller(request, operation);
    let input;
    try {
      input = validate(schema, request.data);
    } catch (error) {
      logger.warn("Product input rejected", {
        event: "product_validation",
        action: operation,
        outcome: "denied",
        code: `PRODUCT_${operation.toUpperCase()}_INVALID_INPUT`,
      });
      throw error;
    }
    return handler(input, caller, newAccount);
  })();
}
