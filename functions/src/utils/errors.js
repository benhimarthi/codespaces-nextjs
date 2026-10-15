import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";

export async function runSafely(event, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }

    logger.error("Callable operation failed", {
      event,
      outcome: "failure",
    });
    throw new HttpsError("internal", "Unable to complete the request.");
  }
}
