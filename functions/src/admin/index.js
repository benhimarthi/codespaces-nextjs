import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import {
  requireAuth,
  requireMfa,
  requireRecentLogin,
  requireRole,
  roleFor,
  roleRank,
} from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import { auth, db } from "../utils/firebase.js";
import {
  bulkDisableUsersSchema,
  createUserByAdminSchema,
  deleteUserSchema,
  disableUserSchema,
  enableUserSchema,
  generatePasswordResetLinkSchema,
  getAuditLogsSchema,
  getUserByIdSchema,
  legacySetUserRoleSchema,
  listUsersSchema,
  revokeUserSessionsSchema,
  setUserRoleSchema,
} from "./schemas.js";

const auditCollection = db.collection("auditLogs");
const adminRatePolicies = {
  disable_user: { perUid: 3, windowSeconds: 3600 },
  delete_user: { perUid: 2, windowSeconds: 3600 },
  create_user: { perUid: 2, windowSeconds: 3600 },
  password_reset: { perUid: 2, windowSeconds: 3600 },
  bulk_disable_users: { perUid: 1, windowSeconds: 3600 },
};

function requestId(request) {
  const supplied = request.rawRequest?.get("x-request-id");
  return typeof supplied === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied)
    ? supplied
    : randomUUID();
}

function safeReason(reason) {
  if (typeof reason !== "string") return null;
  return reason
    .replace(/\bBearer\s+\S+/gi, "[REDACTED]")
    .replace(/\b(?:password|token|oobCode)\s*[:=]\s*\S+/gi, "[REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]");
}

function receiptDocumentId(uid, id) {
  return createHash("sha256").update(`${uid}:${id}`).digest("hex");
}

function auditData(request, context, outcome, denialCode) {
  return {
    actorUid: request.auth?.uid ?? null,
    actorRole: request.auth ? roleFor(request.auth) : null,
    action: context.action,
    targetUid: context.targetUid ?? null,
    beforeRole: context.beforeRole ?? null,
    afterRole: context.afterRole ?? null,
    reason: safeReason(context.reason),
    timestamp: FieldValue.serverTimestamp(),
    requestId: context.requestId,
    ip: request.rawRequest?.ip ?? null,
    outcome,
    ...(context.targetUids ? { targetUids: context.targetUids } : {}),
    ...(denialCode ? { denialCode } : {}),
  };
}

async function writeAudit(request, context, outcome, denialCode) {
  await auditCollection.add(auditData(request, context, outcome, denialCode));
  context.auditWritten = true;
}

function denialCode(error, action) {
  if (typeof error?.internalCode === "string") return error.internalCode;
  if (error instanceof HttpsError) {
    if (error.code === "permission-denied") return `ADMIN_${action.toUpperCase()}_DENIED`;
    if (error.code === "invalid-argument") return "ADMIN_INVALID_ARGUMENT";
    if (error.code === "resource-exhausted") return "ADMIN_RATE_LIMITED";
  }
  return `ADMIN_${action.toUpperCase()}_FAILED`;
}

async function runAdminAction(request, data, action, handler, options = {}) {
  const context = {
    action,
    requestId: requestId(request),
    ...(typeof data?.uid === "string" ? { targetUid: data.uid } : {}),
    ...(typeof data?.reason === "string" ? { reason: data.reason } : {}),
  };

  try {
    const caller = requireAuth(request);
    await rateLimit(request, `admin:${action}`, adminRatePolicies[action] ?? {
      perUid: 4,
      windowSeconds: 60,
    });
    requireRole(caller, options.minimumRole ?? "admin");
    requireMfa(caller);
    if (options.recentLogin) requireRecentLogin(caller);
    if (options.idempotent) {
      context.receiptRef = db.collection("adminRequests").doc(
        receiptDocumentId(caller.uid, context.requestId),
      );
      const receipt = await context.receiptRef.get();
      if (receipt.exists) {
        const value = receipt.data();
        if (
          value.action !== action ||
          value.payloadHash !== createHash("sha256").update(JSON.stringify(data)).digest("hex")
        ) {
          deny("ADMIN_REQUEST_ID_REUSED");
        }
        return value.result;
      }
      context.payloadHash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    }
    const result = await handler(data, caller, context);
    if (!context.auditWritten) await writeAudit(request, context, "success");
    logger.info("Admin action completed", {
      event: "admin_action",
      action,
      actorUid: caller.uid,
      actorRole: roleFor(caller),
      targetUid: context.targetUid ?? null,
      beforeRole: context.beforeRole ?? null,
      afterRole: context.afterRole ?? null,
      ...(context.targetCount === undefined ? {} : { targetCount: context.targetCount }),
      outcome: "success",
      requestId: context.requestId,
    });
    return result;
  } catch (error) {
    const code = denialCode(error, action);
    if (!context.auditWritten) {
      try {
        await writeAudit(request, context, "denied", code);
      } catch (auditError) {
        logger.error("Admin audit write failed", {
          event: "admin_audit",
          code: "ADMIN_AUDIT_WRITE_FAILED",
          action,
          requestId: context.requestId,
          errorName: auditError instanceof Error ? auditError.name : typeof auditError,
        });
        throw new HttpsError("internal", "Unable to complete the request.");
      }
    }
    logger.warn("Admin action rejected", {
      event: "admin_action",
      action,
      actorUid: request.auth?.uid ?? null,
      targetUid: context.targetUid ?? null,
      outcome: "denied",
      code,
      requestId: context.requestId,
    });
    throw error;
  }
}

function toIso(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  return null;
}

function roleOf(user) {
  const role = user.customClaims?.role;
  return Object.hasOwn(roleRank, role) ? role : "user";
}

function userDto(user, profile) {
  return {
    uid: user.uid,
    email: user.email ?? null,
    displayName: user.displayName ?? profile?.displayName ?? null,
    emailVerified: user.emailVerified,
    disabled: user.disabled,
    role: roleOf(user),
    createdAt: user.metadata.creationTime ?? null,
    lastSignInTime: user.metadata.lastSignInTime ?? null,
    profile: profile
      ? {
        ...(typeof profile.displayName === "string" ? { displayName: profile.displayName } : {}),
        ...(toIso(profile.createdAt) ? { createdAt: toIso(profile.createdAt) } : {}),
        ...(typeof profile.deleted === "boolean" ? { deleted: profile.deleted } : {}),
      }
      : null,
  };
}

function targetRole(user) {
  return roleOf(user);
}

function deny(code, codeName = "permission-denied") {
  logger.warn("Admin policy denied", {
    event: "admin_authorization",
    outcome: "denied",
    code,
  });
  const error = new HttpsError(codeName, codeName === "invalid-argument"
    ? "Invalid request."
    : "Permission denied.");
  error.internalCode = code;
  throw error;
}

function assertCanManage(caller, target, requestedRole) {
  const actorRole = roleFor(caller);
  const targetCurrentRole = targetRole(target);
  if (target.uid === caller.uid) deny("ADMIN_SELF_ACTION");
  if (roleRank[targetCurrentRole] >= roleRank[actorRole]) {
    deny("ADMIN_TARGET_ROLE_NOT_LOWER");
  }
  if (requestedRole !== undefined && (
    roleRank[requestedRole] > roleRank[actorRole] ||
    (roleRank[requestedRole] === roleRank[actorRole] && actorRole !== "superadmin")
  )) {
    deny("ADMIN_CANNOT_ASSIGN_EQUAL_OR_HIGHER_ROLE");
  }
  return targetCurrentRole;
}

function authNotFound(error) {
  return error && typeof error === "object" && error.code === "auth/user-not-found";
}

function invalidAuthPageToken(error) {
  return error && typeof error === "object" && error.code === "auth/invalid-page-token";
}

function authFailure(error) {
  if (authNotFound(error)) {
    throw new HttpsError("not-found", "User not found.");
  }
  throw error;
}

function auditReference() {
  return auditCollection.doc();
}

async function commitProfileAndAudit(request, context, profileRef, patch, options = {}) {
  const auditRef = auditReference(context);
  await db.runTransaction(async (transaction) => {
    const profile = await transaction.get(profileRef);
    if (options.preventLastSuperadmin) {
      const superadmins = await transaction.get(
        db.collection("users").where("role", "==", "superadmin"),
      );
      if (superadmins.size <= 1) deny("ADMIN_LAST_SUPERADMIN_PROTECTED");
    }
    transaction.set(profileRef, patch, { merge: true });
    transaction.create(auditRef, auditData(request, context, "success"));
    if (context.receiptRef) {
      transaction.create(context.receiptRef, {
        action: context.action,
        payloadHash: context.payloadHash,
        result: { success: true },
      });
    }
    if (profile.exists && options.deleteProfile) transaction.delete(profileRef);
  });
  context.auditWritten = true;
}

async function commitAuditAndReceipt(request, context, result) {
  await db.runTransaction(async (transaction) => {
    transaction.create(auditReference(), auditData(request, context, "success"));
    transaction.create(context.receiptRef, {
      action: context.action,
      payloadHash: context.payloadHash,
      result,
    });
  });
  context.auditWritten = true;
}

async function updateAuthAndProfile(request, context, user, updates, patch, options = {}) {
  const previousRole = targetRole(user);
  const previousDisabled = user.disabled;
  const nextRole = updates.role ?? previousRole;
  try {
    await auth.setCustomUserClaims(user.uid, { role: nextRole });
    if (updates.disabled !== undefined) {
      await auth.updateUser(user.uid, { disabled: updates.disabled });
    }
    await auth.revokeRefreshTokens(user.uid);
    await commitProfileAndAudit(
      request,
      context,
      db.collection("users").doc(user.uid),
      patch,
      options,
    );
  } catch (error) {
    try {
      await auth.setCustomUserClaims(user.uid, { role: previousRole });
      if (updates.disabled !== undefined) {
        await auth.updateUser(user.uid, { disabled: previousDisabled });
      }
      await auth.revokeRefreshTokens(user.uid);
    } catch (rollbackError) {
      logger.error("Admin action compensation failed", {
        event: "admin_action",
        code: "ADMIN_COMPENSATION_FAILED",
        action: context.action,
        targetUid: user.uid,
        requestId: context.requestId,
        errorName: rollbackError instanceof Error ? rollbackError.name : typeof rollbackError,
      });
      throw new HttpsError("internal", "Unable to complete the request.");
    }
    throw error;
  }
}

async function sendPasswordSetupEmail(email) {
  const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const apiKey = process.env.FIREBASE_WEB_API_KEY ?? (emulatorHost ? "fake-api-key" : "");
  if (!apiKey) {
    throw new HttpsError("failed-precondition", "Unable to complete the request.");
  }
  const endpoint = emulatorHost
    ? `http://${emulatorHost}/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(apiKey)}`
    : `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestType: "PASSWORD_RESET", email }),
  });
  if (!response.ok) {
    logger.warn("Password setup email delivery failed", {
      event: "admin_email_delivery",
      outcome: "failure",
      code: "ADMIN_PASSWORD_SETUP_EMAIL_FAILED",
    });
    throw new HttpsError("internal", "Unable to complete the request.");
  }
}

async function auditDeniedUnauthenticated(request, action) {
  const context = { action, requestId: requestId(request) };
  await writeAudit(request, context, "denied", "ADMIN_UNAUTHENTICATED");
  logger.warn("Unauthenticated admin action rejected", {
    event: "admin_action",
    action,
    outcome: "denied",
    code: "ADMIN_UNAUTHENTICATED",
    requestId: context.requestId,
  });
}

export async function listUsers(request, data) {
  return runAdminAction(request, data, "list_users", async (raw, caller) => {
    const input = validate(listUsersSchema, raw);
    const start = input.createdAtStart ? Date.parse(input.createdAtStart) : -Infinity;
    const end = input.createdAtEnd ? Date.parse(input.createdAtEnd) : Infinity;
    const users = [];
    let pageToken = input.pageToken;
    let scans = 0;

    while (users.length < input.maxResults && scans < 10) {
      let page;
      try {
        page = await auth.listUsers(input.maxResults, pageToken);
      } catch (error) {
        if (invalidAuthPageToken(error)) {
          throw new HttpsError("invalid-argument", "Invalid request.");
        }
        throw error;
      }
      const matchingUsers = page.users.filter((user) => {
        const createdAt = Date.parse(user.metadata.creationTime);
        return roleRank[roleOf(user)] < roleRank[roleFor(caller)] &&
          (!input.role || roleOf(user) === input.role) &&
          (input.disabled === undefined || user.disabled === input.disabled) &&
          createdAt >= start &&
          createdAt <= end;
      }).slice(0, input.maxResults - users.length);
      const profiles = matchingUsers.length > 0
        ? await db.getAll(...matchingUsers.map(({ uid }) => db.collection("users").doc(uid)))
        : [];
      matchingUsers.forEach((user, index) => {
        const profile = profiles[index];
        users.push(userDto(user, profile.exists ? profile.data() : null));
      });
      pageToken = page.pageToken;
      scans += 1;
      if (!pageToken) break;
    }
    return { users, nextPageToken: pageToken ?? null };
  });
}

export async function getUserById(request, data) {
  return runAdminAction(request, data, "get_user", async (raw, caller, context) => {
    const input = validate(getUserByIdSchema, raw);
    context.targetUid = input.uid;
    let user;
    try {
      user = await auth.getUser(input.uid);
    } catch (error) {
      authFailure(error);
    }
    assertCanManage(caller, user);
    const profile = await db.collection("users").doc(user.uid).get();
    return { user: userDto(user, profile.exists ? profile.data() : null) };
  });
}

async function changeRole(request, data, caller, context, user) {
  context.targetUid = user.uid;
  const oldRole = assertCanManage(caller, user, data.role);
  context.beforeRole = oldRole;
  context.afterRole = data.role;
  context.reason = data.reason;
  await updateAuthAndProfile(
    request,
    context,
    user,
    { role: data.role },
    { role: data.role, updatedAt: FieldValue.serverTimestamp() },
    { preventLastSuperadmin: oldRole === "superadmin" && data.role !== "superadmin" },
  );
  return { success: true };
}

export async function setUserRole(request, data) {
  return runAdminAction(request, data, "set_user_role", async (raw, caller, context) => {
    const input = validate(setUserRoleSchema, raw);
    context.targetUid = input.uid;
    context.reason = input.reason;
    let user;
    try {
      user = await auth.getUser(input.uid);
    } catch (error) {
      authFailure(error);
    }
    return changeRole(request, input, caller, context, user);
  }, { recentLogin: true });
}

export async function setUserRoleByEmail(request, data) {
  return runAdminAction(request, data, "set_user_role", async (raw, caller, context) => {
    const input = validate(legacySetUserRoleSchema, raw);
    context.reason = input.reason;
    let user;
    try {
      user = await auth.getUserByEmail(input.email);
    } catch (error) {
      authFailure(error);
    }
    return changeRole(request, input, caller, context, user);
  }, { recentLogin: true });
}

async function getTarget(uid) {
  try {
    return await auth.getUser(uid);
  } catch (error) {
    authFailure(error);
  }
}

export async function disableUser(request, data) {
  return runAdminAction(request, data, "disable_user", async (raw, caller, context) => {
    const input = validate(disableUserSchema, raw);
    context.targetUid = input.uid;
    context.reason = input.reason;
    const user = await getTarget(input.uid);
    const role = assertCanManage(caller, user);
    context.beforeRole = role;
    context.afterRole = role;
    await updateAuthAndProfile(request, context, user, { disabled: true }, {
      role,
      disabled: true,
      deleted: false,
      updatedAt: FieldValue.serverTimestamp(),
    }, { preventLastSuperadmin: role === "superadmin" });
    return { success: true };
  });
}

export async function enableUser(request, data) {
  return runAdminAction(request, data, "enable_user", async (raw, caller, context) => {
    const input = validate(enableUserSchema, raw);
    context.targetUid = input.uid;
    const user = await getTarget(input.uid);
    const role = assertCanManage(caller, user);
    context.beforeRole = role;
    context.afterRole = role;
    await updateAuthAndProfile(request, context, user, { disabled: false }, {
      role,
      disabled: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { success: true };
  });
}

export async function revokeUserSessions(request, data) {
  return runAdminAction(request, data, "revoke_user_sessions", async (raw, caller, context) => {
    const input = validate(revokeUserSessionsSchema, raw);
    context.targetUid = input.uid;
    const user = await getTarget(input.uid);
    const role = assertCanManage(caller, user);
    context.beforeRole = role;
    context.afterRole = role;
    await auth.revokeRefreshTokens(user.uid);
    return { success: true };
  });
}

export async function deleteUser(request, data) {
  return runAdminAction(request, data, "delete_user", async (raw, caller, context) => {
    const input = validate(deleteUserSchema, raw);
    context.targetUid = input.uid;
    context.reason = input.reason;
    if (input.hardDelete && roleFor(caller) !== "superadmin") {
      deny("ADMIN_HARD_DELETE_REQUIRES_SUPERADMIN");
    }
    let user;
    try {
      user = await auth.getUser(input.uid);
    } catch (error) {
      if (!authNotFound(error)) throw error;
      user = null;
    }
    const profileRef = db.collection("users").doc(input.uid);
    const profileSnapshot = await profileRef.get();
    if (!user && !(input.hardDelete && profileSnapshot.get("deletePending") === true)) {
      throw new HttpsError("not-found", "User not found.");
    }
    const role = user ? assertCanManage(caller, user) : profileSnapshot.get("role");
    if (!user && (!Object.hasOwn(roleRank, role) || roleRank[role] >= roleRank[roleFor(caller)])) {
      deny("ADMIN_TARGET_ROLE_NOT_LOWER");
    }
    context.beforeRole = role;
    context.afterRole = role;

    if (!input.hardDelete) {
      context.afterRole = role;
      await updateAuthAndProfile(request, context, user, { disabled: true }, {
        role,
        disabled: true,
        deleted: true,
        deletedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { preventLastSuperadmin: role === "superadmin" });
      return { success: true };
    }

    if (user) {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(profileRef);
        if (role === "superadmin") {
          const superadmins = await transaction.get(
            db.collection("users").where("role", "==", "superadmin"),
          );
          if (superadmins.size <= 1) deny("ADMIN_LAST_SUPERADMIN_PROTECTED");
        }
        transaction.set(profileRef, {
          role,
          deletePending: true,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        if (!snapshot.exists) {
          transaction.set(profileRef, { role, deletePending: true });
        }
      });
      await auth.deleteUser(user.uid);
    }
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(profileRef);
      if (snapshot.exists) transaction.delete(profileRef);
      transaction.create(
        auditReference(context),
        auditData(request, context, "success"),
      );
      if (context.receiptRef) {
        transaction.create(context.receiptRef, {
          action: context.action,
          payloadHash: context.payloadHash,
          result: { success: true },
        });
      }
    });
    await db.recursiveDelete(profileRef);
    context.auditWritten = true;
    return { success: true };
  }, { recentLogin: true, idempotent: true });
}

export async function createUserByAdmin(request, data) {
  return runAdminAction(request, data, "create_user", async (raw, caller, context) => {
    const input = validate(createUserByAdminSchema, raw);
    if (
      roleRank[input.role] > roleRank[roleFor(caller)] ||
      (roleRank[input.role] === roleRank[roleFor(caller)] && roleFor(caller) !== "superadmin")
    ) {
      deny("ADMIN_CANNOT_ASSIGN_EQUAL_OR_HIGHER_ROLE");
    }
    context.afterRole = input.role;
    let user;
    try {
      user = await auth.createUser({
        email: input.email,
        displayName: input.displayName,
        emailVerified: false,
      });
      context.targetUid = user.uid;
      await auth.setCustomUserClaims(user.uid, { role: input.role });
      await sendPasswordSetupEmail(input.email);
      await db.runTransaction(async (transaction) => {
        const profileRef = db.collection("users").doc(user.uid);
        const auditRef = auditReference(context);
        transaction.create(profileRef, {
          displayName: input.displayName,
          role: input.role,
          disabled: false,
          createdAt: FieldValue.serverTimestamp(),
        });
        transaction.create(context.receiptRef, {
          action: context.action,
          payloadHash: context.payloadHash,
          result: { success: true, uid: user.uid },
        });
        transaction.create(auditRef, auditData(request, context, "success"));
      });
      context.auditWritten = true;
    } catch (error) {
      if (user) {
        try {
          await auth.deleteUser(user.uid);
        } catch (rollbackError) {
          logger.error("Admin account creation compensation failed", {
            event: "admin_action",
            code: "ADMIN_COMPENSATION_FAILED",
            action: context.action,
            targetUid: user.uid,
            requestId: context.requestId,
            errorName: rollbackError instanceof Error ? rollbackError.name : typeof rollbackError,
          });
        }
      }
      throw error;
    }
    return { success: true, uid: user.uid };
  }, { recentLogin: true, idempotent: true });
}

export async function generatePasswordResetLink(request, data) {
  return runAdminAction(request, data, "password_reset", async (raw, caller, context) => {
    const input = validate(generatePasswordResetLinkSchema, raw);
    context.targetUid = input.uid;
    const user = await getTarget(input.uid);
    assertCanManage(caller, user);
    if (!user.email) throw new HttpsError("failed-precondition", "Unable to complete the request.");
    await sendPasswordSetupEmail(user.email);
    const result = { success: true };
    await commitAuditAndReceipt(request, context, result);
    return result;
  }, { recentLogin: true, idempotent: true });
}

function auditDto(snapshot) {
  const value = snapshot.data();
  return {
    actorUid: value.actorUid ?? null,
    actorRole: value.actorRole ?? null,
    action: value.action,
    targetUid: value.targetUid ?? null,
    ...(Array.isArray(value.targetUids)
      ? { targetUids: value.targetUids.filter((uid) => typeof uid === "string") }
      : {}),
    beforeRole: value.beforeRole ?? null,
    afterRole: value.afterRole ?? null,
    reason: value.reason ?? null,
    timestamp: toIso(value.timestamp),
    requestId: value.requestId,
    ip: value.ip ?? null,
    outcome: value.outcome,
    ...(value.denialCode ? { denialCode: value.denialCode } : {}),
  };
}

export async function getAuditLogs(request, data) {
  return runAdminAction(request, data, "get_audit_logs", async (raw) => {
    const input = validate(getAuditLogsSchema, raw);
    if (input.pageToken && !/^[A-Za-z0-9]{20}$/.test(input.pageToken)) {
      throw new HttpsError("invalid-argument", "Invalid request.");
    }
    let cursor = null;
    if (input.pageToken) {
      cursor = await auditCollection.doc(input.pageToken).get();
      if (!cursor.exists) throw new HttpsError("invalid-argument", "Invalid request.");
    }

    const matches = [];
    let hasMore = true;
    let scanned = 0;
    let lastScanned = null;
    while (matches.length < input.maxResults && hasMore && scanned < 1000) {
      let query = auditCollection.orderBy("timestamp", "desc").limit(100);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      hasMore = page.size === 100;
      if (page.empty) break;
      for (const snapshot of page.docs) {
        lastScanned = snapshot;
        scanned += 1;
        const entry = snapshot.data();
        const time = entry.timestamp?.toDate?.().getTime() ?? 0;
        if (input.actorUid && entry.actorUid !== input.actorUid) continue;
        if (input.targetUid && entry.targetUid !== input.targetUid) continue;
        if (input.action && entry.action !== input.action) continue;
        if (input.startAt && time < Date.parse(input.startAt)) continue;
        if (input.endAt && time > Date.parse(input.endAt)) continue;
        matches.push(auditDto(snapshot));
        if (matches.length === input.maxResults) break;
      }
      cursor = page.docs.at(-1);
      if (page.size < 100) hasMore = false;
    }
    return {
      logs: matches,
      nextPageToken: hasMore && lastScanned ? lastScanned.id : null,
    };
  });
}

export async function bulkDisableUsers(request, data) {
  return runAdminAction(request, data, "bulk_disable_users", async (raw, caller, context) => {
    const input = validate(bulkDisableUsersSchema, raw);
    context.targetUid = null;
    context.targetUids = input.uids;
    context.reason = input.reason;
    const targets = [];
    for (const uid of input.uids) {
      const user = await getTarget(uid);
      const role = assertCanManage(caller, user);
      targets.push({ user, role });
    }
    context.targetCount = targets.length;
    const changed = [];
    try {
      for (const { user, role } of targets) {
        changed.push(user);
        await auth.setCustomUserClaims(user.uid, { role });
        await auth.updateUser(user.uid, { disabled: true });
        await auth.revokeRefreshTokens(user.uid);
      }
      const auditRef = auditReference(context);
      await db.runTransaction(async (transaction) => {
        const refs = targets.map(({ user }) => db.collection("users").doc(user.uid));
        const superadmins = await transaction.get(
          db.collection("users").where("role", "==", "superadmin"),
        );
        const removing = targets.filter(({ role }) => role === "superadmin").length;
        if (removing > 0 && superadmins.size - removing < 1) {
          deny("ADMIN_LAST_SUPERADMIN_PROTECTED");
        }
        targets.forEach(({ role }, index) => {
          transaction.set(refs[index], {
            role,
            disabled: true,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        });
        transaction.create(auditRef, auditData(request, context, "success"));
      });
      context.auditWritten = true;
    } catch (error) {
      for (const user of changed.reverse()) {
        try {
          await auth.setCustomUserClaims(user.uid, { role: targetRole(user) });
          await auth.updateUser(user.uid, { disabled: user.disabled });
          await auth.revokeRefreshTokens(user.uid);
        } catch (rollbackError) {
          logger.error("Bulk action compensation failed", {
            event: "admin_action",
            code: "ADMIN_COMPENSATION_FAILED",
            action: context.action,
            targetUid: user.uid,
            requestId: context.requestId,
            errorName: rollbackError instanceof Error ? rollbackError.name : typeof rollbackError,
          });
        }
      }
      throw error;
    }
    return { success: true, disabledCount: targets.length };
  });
}

export const adminRoutes = new Map([
  ["POST /users/list", listUsers],
  ["POST /users/get", getUserById],
  ["POST /users/set-role", setUserRole],
  ["POST /users/disable", disableUser],
  ["POST /users/enable", enableUser],
  ["POST /users/revoke-sessions", revokeUserSessions],
  ["POST /users/delete", deleteUser],
  ["POST /users/create", createUserByAdmin],
  ["POST /users/password-reset", generatePasswordResetLink],
  ["POST /audit-logs/list", getAuditLogs],
  ["POST /users/bulk-disable", bulkDisableUsers],
]);

export { auditDeniedUnauthenticated };
