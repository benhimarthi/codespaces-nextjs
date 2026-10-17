import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import { requireAuth, requireMfa, requireRecentLogin, requireRole, roleFor } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { runSafely } from "../../utils/errors.js";
import { auth, db } from "../../utils/firebase.js";
import { orderConfig } from "./config.js";

export async function activeAccount(request, operation, policy) {
  const caller = requireAuth(request);
  if (policy) await rateLimit(request, operation, policy);
  const [account, profile] = await Promise.all([
    auth.getUser(caller.uid),
    db.collection("users").doc(caller.uid).get(),
  ]);
  if (
    account.disabled ||
    !profile.exists ||
    profile.get("disabled") === true ||
    profile.get("deleted") === true ||
    profile.get("status") === "disabled" ||
    profile.get("status") === "deleted"
  ) {
    logger.warn("Store operation blocked for disabled account", {
      event: "store_account",
      action: operation,
      outcome: "denied",
      code: "STORE_ACCOUNT_DISABLED",
    });
    throw new HttpsError("permission-denied", "Permission denied.");
  }
  return { caller, account, profile, request };
}

export async function verifiedBuyer(request, operation, policy) {
  const accountState = await activeAccount(request, operation, policy);
  if (request.auth.token.email_verified !== true) {
    await writeFraudBlock(request, accountState.caller, operation, "ORDER_EMAIL_UNVERIFIED");
    throw new HttpsError("failed-precondition", "Account verification is required.");
  }
  return accountState;
}

export function isDisabledProfile(profile) {
  return !profile.exists ||
    profile.get("disabled") === true ||
    profile.get("deleted") === true ||
    profile.get("status") === "disabled" ||
    profile.get("status") === "deleted";
}

export function ratePolicy(name) {
  return orderConfig.rateLimits[name];
}

export async function writeFraudBlock(request, caller, action, code, orderId = null) {
  logger.warn("Order fraud rule blocked request", {
    event: "order_fraud",
    action,
    outcome: "denied",
    code,
  });
  const reference = db.collection("auditLogs").doc();
  await reference.create({
    actorUid: caller.uid,
    actorRole: roleFor(caller),
    action: `fraud_block:${action}`,
    orderId,
    beforeStatus: null,
    afterStatus: null,
    reason: code,
    timestamp: FieldValue.serverTimestamp(),
    requestId: request.rawRequest?.get?.("x-request-id")?.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    ) ? request.rawRequest.get("x-request-id") : randomUUID(),
    ip: request.rawRequest?.ip ?? null,
  });
}

export function makeOperation({ name, schema, policy, admin = false, freshAuth = false, handler }) {
  return async (request) => runSafely(name, async () => {
    const state = await activeAccount(request, name, policy);
    if (admin) {
      requireRole(state.caller, "admin");
      requireMfa(state.caller);
      if (freshAuth) requireRecentLogin(state.caller);
    }
    const input = validate(schema, request.data);
    return handler(input, state);
  });
}

export function accountAgeDays(account, profile) {
  const profileCreated = profile.get("createdAt");
  const createdAt = profileCreated && typeof profileCreated.toDate === "function"
    ? profileCreated.toDate().getTime()
    : Date.parse(account.metadata.creationTime);
  return Number.isFinite(createdAt) ? Math.max(0, (Date.now() - createdAt) / 86_400_000) : 0;
}

export async function requireVerifiedPhone(account, inputPhone, request, caller) {
  if (!account.phoneNumber) return;
  const verifiedPhone = normalizeMoroccanPhone(account.phoneNumber);
  const suppliedPhone = normalizeMoroccanPhone(inputPhone);
  if (verifiedPhone !== suppliedPhone) {
    await writeFraudBlock(request, caller, "createOrder", "ORDER_PHONE_MISMATCH");
    throw new HttpsError("failed-precondition", "Account verification is required.");
  }
}

export function normalizeMoroccanPhone(value) {
  const digits = value.replace(/[ -]/g, "");
  if (/^0[5-7]\d{8}$/.test(digits)) return `+212${digits.slice(1)}`;
  return digits;
}

export function fraudLimitError(code, status = "resource-exhausted") {
  logger.warn("Order fraud rule blocked request", {
    event: "order_fraud",
    outcome: "denied",
    code,
  });
  const error = new HttpsError(status, "Order cannot be completed.");
  error.internalCode = code;
  throw error;
}
