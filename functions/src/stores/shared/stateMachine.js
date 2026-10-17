import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";

const transitions = Object.freeze({
  draft: { pending_verification: ["owner"] },
  pending_verification: { active: ["admin"], rejected: ["admin"] },
  rejected: { draft: ["owner"] },
  active: { suspended: ["admin"], closed: ["owner"] },
  suspended: { active: ["admin"] },
  closed: { draft: ["admin"], active: ["admin"] },
});

export function assertStoreTransition(current, next, actor) {
  if (!transitions[current]?.[next]?.includes(actor)) {
    logger.warn("Invalid store state transition", {
      event: "store_transition",
      outcome: "denied",
      code: "STORE_INVALID_TRANSITION",
      fromStatus: current,
      toStatus: next,
      actor,
    });
    const error = new HttpsError("failed-precondition", "Store transition is not allowed.");
    error.internalCode = "STORE_INVALID_TRANSITION";
    throw error;
  }
}
