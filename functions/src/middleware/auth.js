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

export function requireRole(caller, role) {
  const callerRole = caller.token.role;
  const hasRole = role === "user"
    ? callerRole === undefined || callerRole === "user"
    : callerRole === role;

  if (!hasRole) {
    logger.warn("Authorization denied", {
      event: "authorization",
      outcome: "denied",
      requiredRole: role,
    });
    throw new HttpsError("permission-denied", "Permission denied.");
  }
}
