import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import { createOrderSchema } from "./shared/schemas.js";
import { activeAccount, writeFraudBlock } from "./shared/operation.js";
import { orderConfig } from "./shared/config.js";
import { runSafely } from "../utils/errors.js";
import { createOrderOperation } from "./shared/create.js";
import { validate } from "../middleware/validate.js";

export async function createOrder(request) {
  return runSafely("createOrder", async () => {
    const state = await activeAccount(request, "createOrder", {
      ...orderConfig.rateLimits.createOrder,
    });
    const input = validate(createOrderSchema, request.data);
    if (request.auth.token.email_verified !== true) {
      await writeFraudBlock(request, state.caller, "createOrder", "ORDER_EMAIL_UNVERIFIED");
      throw new HttpsError("failed-precondition", "Account verification is required.");
    }
    try {
      return await createOrderOperation(request, input, state);
    } catch (error) {
      const code = typeof error?.internalCode === "string" ? error.internalCode : "";
      if (code.startsWith("ORDER_")) {
        logger.warn("Order creation blocked", {
          event: "order_fraud",
          outcome: "denied",
          code,
        });
      }
      throw error;
    }
  });
}
