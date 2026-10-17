import { FirebaseAuthError } from "firebase-admin/auth";
import { logger } from "firebase-functions";
import { HttpsError, onRequest } from "firebase-functions/v2/https";
import { registerUserOperation } from "./registerUser.js";
import { getMyProfileOperation } from "./getMyProfile.js";
import { deleteMyAccountOperation } from "./deleteMyAccount.js";
import {
  adminRoutes,
  auditDeniedUnauthenticated,
  setUserRoleByEmail,
} from "../admin/index.js";
import { authServiceOptions } from "../utils/authServiceOptions.js";
import { runSafely } from "../utils/errors.js";
import { auth } from "../utils/firebase.js";

const routes = new Map([
  ["POST /register", { event: "register_user", operation: registerUserOperation }],
  ["GET /profile", { event: "get_my_profile", operation: getMyProfileOperation }],
  ["DELETE /account", { event: "delete_my_account", operation: deleteMyAccountOperation }],
]);

for (const [path, operation] of adminRoutes) {
  const [method, routePath] = path.split(" ");
  routes.set(`${method} /admin${routePath}`, {
    event: `admin_${path.split("/").at(-1).replaceAll("-", "_")}`,
    operation,
    admin: true,
  });
}

routes.set("POST /role", {
  event: "set_user_role",
  operation: setUserRoleByEmail,
  admin: true,
});

const httpStatusByCode = {
  "invalid-argument": 400,
  "unauthenticated": 401,
  "permission-denied": 403,
  "not-found": 404,
  "already-exists": 409,
  "failed-precondition": 412,
  "resource-exhausted": 429,
  "unavailable": 503,
  "deadline-exceeded": 504,
  "internal": 500,
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
    logger.warn("Authentication required", {
      event: "authentication",
      outcome: "unauthenticated",
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
    logger.warn("Authentication token rejected", {
      event: "authentication",
      outcome: "unauthenticated",
    });
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
}

export const authService = onRequest(authServiceOptions(), async (request, response) => {
  response.set("Cache-Control", "no-store");
  const route = routes.get(`${request.method} ${request.path}`);
  if (!route) {
    response.status(404).json({
      error: {
        status: "NOT_FOUND",
        message: "Endpoint not found.",
      },
    });
    return;
  }

  try {
    const result = await runSafely(route.event, async () => {
      const caller = await verifyRequest(request);
      return route.operation(
        { auth: caller, rawRequest: request },
        request.body ?? {},
      );
    });
    response.status(200).json(result);
  } catch (error) {
    if (route.admin && error instanceof HttpsError && error.code === "unauthenticated") {
      try {
        const action = route.event.replace(/^admin_/, "");
        await auditDeniedUnauthenticated({ rawRequest: request }, action);
      } catch (auditError) {
        logger.error("Admin audit write failed", {
          event: "admin_audit",
          code: "ADMIN_AUDIT_WRITE_FAILED",
          errorName: auditError instanceof Error ? auditError.name : typeof auditError,
        });
      }
    }
    sendError(response, error);
  }
});
