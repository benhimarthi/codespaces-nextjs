import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import { requireAuth, requireMfa, requireRecentLogin, requireRole, roleFor } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { auth, db } from "../../utils/firebase.js";

export async function requireEnabledAccount(request, operation) {
  const caller = requireAuth(request);
  const [account, profile] = await Promise.all([
    auth.getUser(caller.uid),
    db.collection("users").doc(caller.uid).get(),
  ]);
  if (account.disabled || !profile.exists ||
    profile.get("disabled") === true ||
    profile.get("deleted") === true ||
    ["disabled", "deleted"].includes(profile.get("status"))) {
    logger.warn("Store operation denied for disabled account", {
      event: "store_account",
      action: operation,
      outcome: "denied",
      code: "STORE_ACCOUNT_DISABLED",
    });
    throw new HttpsError("permission-denied", "Permission denied.");
  }
  return { caller, account, profile };
}

export async function requireActiveStore(request, operation = "seller_action") {
  const state = await requireEnabledAccount(request, operation);
  const snapshot = await db.collection("stores")
    .where("ownerUid", "==", state.caller.uid)
    .limit(1)
    .get();
  const store = snapshot.docs[0];
  if (!store) throw new HttpsError("failed-precondition", "An active store is required.");
  if (store.get("status") !== "active") {
    logger.warn("Inactive store action denied", {
      event: "store_status_guard",
      action: operation,
      outcome: "denied",
      code: "STORE_NOT_ACTIVE",
      status: store.get("status"),
    });
    throw new HttpsError("failed-precondition", "An active store is required.");
  }
  return { ...state, store };
}

export async function ownerOperation(request, operation, schema, handler, policy = { perUid: 8, perIp: 30, windowSeconds: 60 }) {
  const state = await requireEnabledAccount(request, operation);
  await rateLimit(request, `store:${operation}`, policy);
  const input = validate(schema, request.data);
  const snapshot = await db.collection("stores")
    .where("ownerUid", "==", state.caller.uid)
    .limit(1)
    .get();
  return handler(input, { ...state, store: snapshot.docs[0] ?? null });
}

export async function adminOperation(request, operation, schema, handler, freshAuth = false) {
  const state = await requireEnabledAccount(request, `admin:${operation}`);
  await rateLimit(request, `admin:store:${operation}`, { perUid: 15, perIp: 40, windowSeconds: 60 });
  requireRole(state.caller, "admin");
  requireMfa(state.caller);
  if (freshAuth) requireRecentLogin(state.caller, 300);
  const input = validate(schema, request.data);
  return handler(input, state);
}

export function ensureAdminMayActOnStore(caller, ownerUid) {
  if (caller.uid === ownerUid && roleFor(caller) !== "superadmin") {
    throw new HttpsError("permission-denied", "Permission denied.");
  }
  return auth.getUser(ownerUid).then((owner) => {
    if (roleFor(caller) === "admin" && owner.customClaims?.role === "admin") {
      throw new HttpsError("permission-denied", "Permission denied.");
    }
  });
}
