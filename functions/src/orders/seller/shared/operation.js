import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import { makeOperation, ratePolicy } from "../../shared/operation.js";

export function sellerOrderOperation(name, schema, handler) {
  return makeOperation({
    name,
    schema,
    policy: ratePolicy("seller"),
    handler: (input, state) => {
      if (state.caller.token.email_verified !== true) {
        logger.warn("Unverified seller account blocked", {
          event: "seller_order_account",
          action: name,
          outcome: "denied",
          code: "SELLER_ORDER_EMAIL_UNVERIFIED",
        });
        throw new HttpsError("permission-denied", "Permission denied.");
      }
      return handler(input, state);
    },
  });
}
