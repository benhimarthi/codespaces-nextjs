import { FirebaseAuthError } from "firebase-admin/auth";
import { logger } from "firebase-functions";
import { HttpsError, onRequest } from "firebase-functions/v2/https";
import { runSafely } from "./errors.js";
import { auth } from "./firebase.js";

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

function sendError(response, error, serviceName) {
  const httpsError = error instanceof HttpsError
    ? error
    : new HttpsError("internal", "Unable to complete the request.");
  response.status(httpStatusByCode[httpsError.code] ?? 500).json({
    error: {
      status: httpsError.code.toUpperCase().replaceAll("-", "_"),
      message: httpsError.message,
    },
  });
  if (!(error instanceof HttpsError)) {
    logger.error("Module service request failed", {
      event: `${serviceName}_request`,
      outcome: "failure",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

async function verifyRequest(request, serviceName) {
  const authorization = request.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    logger.warn("Module authentication required", {
      event: `${serviceName}_authentication`,
      outcome: "unauthenticated",
      code: `${serviceName.toUpperCase()}_AUTH_REQUIRED`,
    });
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  try {
    const token = await auth.verifyIdToken(match[1], true);
    return { uid: token.uid, token };
  } catch (error) {
    if (error instanceof FirebaseAuthError && error.code === "auth/user-disabled") {
      logger.warn("Disabled account access blocked", {
        event: `${serviceName}_account`,
        outcome: "denied",
        code: `${serviceName.toUpperCase()}_ACCOUNT_DISABLED`,
      });
      throw new HttpsError("permission-denied", "Permission denied.");
    }
    if (!(error instanceof FirebaseAuthError) || !invalidAuthTokenCodes.has(error.code)) {
      throw error;
    }
    logger.warn("Module ID token rejected", {
      event: `${serviceName}_authentication`,
      outcome: "unauthenticated",
      code: `${serviceName.toUpperCase()}_AUTH_TOKEN_INVALID`,
    });
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
}

function sendNotFound(response) {
  response.status(404).json({
    error: { status: "NOT_FOUND", message: "Endpoint not found." },
  });
}

export function createModuleService(serviceName, options, routes) {
  const routeMap = new Map(routes);
  return onRequest(options, async (request, response) => {
    response.set("Cache-Control", "no-store");
    const operation = routeMap.get(`${request.method} ${request.path}`);
    if (!operation) {
      sendNotFound(response);
      return;
    }

    try {
      const result = await runSafely(`${serviceName}_service`, async () => {
        const data = request.body ?? {};
        if (
          typeof data !== "object" ||
          data === null ||
          Array.isArray(data) ||
          Buffer.byteLength(JSON.stringify(data), "utf8") > 100 * 1024
        ) {
          throw new HttpsError("invalid-argument", "Invalid request.");
        }
        const caller = await verifyRequest(request, serviceName);
        return operation({ auth: caller, rawRequest: request, data });
      });
      response.status(200).json(result);
    } catch (error) {
      sendError(response, error, serviceName);
    }
  });
}
