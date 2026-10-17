import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { validate } from "../../middleware/validate.js";
import { runSafely } from "../../utils/errors.js";
import { db } from "../../utils/firebase.js";
import { orderConfig } from "../shared/config.js";
import { expireOrdersSchema } from "../shared/schemas.js";
import { scheduledOrderOptions } from "../shared/options.js";
import { expireOrder } from "../shared/transitions.js";

export const expireUnconfirmedOrders = onSchedule(
  scheduledOrderOptions,
  async (event) => runSafely("expireUnconfirmedOrders", async () => {
    validate(expireOrdersSchema, {});
    const request = { rawRequest: null, eventId: event.id };
    const now = Date.now();
    const expiryCutoff = Timestamp.fromMillis(
      now - orderConfig.unconfirmedExpiryHours * 3_600_000,
    );
    const pending = await db.collection("orders")
      .where("status", "==", "pending_confirmation")
      .where("createdAt", "<=", expiryCutoff)
      .orderBy("createdAt", "asc")
      .limit(100)
      .get();
    let expiredCount = 0;
    for (const order of pending.docs) {
      if (await expireOrder(request, order.id)) expiredCount += 1;
    }
    logger.info("Scheduled order maintenance completed", {
      event: "order_expiry",
      outcome: "success",
      expiredCount,
    });
    return { expiredCount };
  }),
);
