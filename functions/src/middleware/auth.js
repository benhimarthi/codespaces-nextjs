import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";

export function requireAuth(request) {
  if (!request.auth) {
    logger.warn("Authentication required", {
      event: "authentication",
      outcome: "unauthenticated",
    });
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  return request.auth;
}

export const roleRank = Object.freeze({
  user: 0,
  admin: 1,
  superadmin: 2,
});

export function roleFor(caller) {
  const role = caller.token.role;
  return Object.hasOwn(roleRank, role) ? role : "user";
}

export function requireRole(caller, role) {
  const hasRole = roleRank[role] !== undefined &&
    roleRank[roleFor(caller)] >= roleRank[role];

  if (!hasRole) {
    logger.warn("Authorization denied", {
      event: "authorization",
      outcome: "denied",
      requiredRole: role,
      code: "ADMIN_INSUFFICIENT_ROLE",
    });
    const error = new HttpsError("permission-denied", "Permission denied.");
    error.internalCode = "ADMIN_INSUFFICIENT_ROLE";
    throw error;
  }
}

export function requireRecentLogin(caller, maxAgeSeconds = 300) {
  const authTime = caller.token.auth_time;
  if (
    !Number.isInteger(authTime) ||
    authTime > Math.floor(Date.now() / 1000) ||
    Math.floor(Date.now() / 1000) - authTime > maxAgeSeconds
  ) {
    logger.warn("Recent authentication required", {
      event: "authorization",
      outcome: "denied",
      code: "ADMIN_STALE_AUTH_TIME",
    });
    const error = new HttpsError("permission-denied", "Permission denied.");
    error.internalCode = "ADMIN_STALE_AUTH_TIME";
    throw error;
  }
}

export function requireMfa(caller) {
  if (typeof caller.token.sign_in_second_factor !== "string" ||
    caller.token.sign_in_second_factor.length === 0) {
    logger.warn("Multi-factor authentication required", {
      event: "authorization",
      outcome: "denied",
      code: "ADMIN_MFA_REQUIRED",
    });
    const error = new HttpsError("permission-denied", "Permission denied.");
    error.internalCode = "ADMIN_MFA_REQUIRED";
    throw error;
  }
}
