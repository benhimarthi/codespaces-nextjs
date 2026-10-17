import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";

export async function runSafely(event, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }

    const errorName = error instanceof Error
      ? error.name
      : typeof error === "object" && error !== null && "name" in error &&
          typeof error.name === "string"
        ? error.name
        : typeof error;
    const errorCode = typeof error === "object" && error !== null && "code" in error &&
      (typeof error.code === "string" || typeof error.code === "number")
      ? error.code
      : undefined;

    logger.error("Auth operation failed", {
      event,
      outcome: "failure",
      errorName,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
    throw new HttpsError("internal", "Unable to complete the request.");
  }
}
