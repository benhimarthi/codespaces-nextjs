import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { validate } from "../../middleware/validate.js";
import { runSafely } from "../../utils/errors.js";
import { db } from "../../utils/firebase.js";
import { orderConfig } from "../shared/config.js";
import { expireOrdersSchema } from "../shared/schemas.js";
import { scheduledOrderOptions } from "../shared/options.js";
import { completeOrder } from "../shared/transitions.js";

export const completeDeliveredOrders = onSchedule(
  scheduledOrderOptions,
  async (event) => runSafely("completeDeliveredOrders", async () => {
    validate(expireOrdersSchema, {});
    const request = { rawRequest: null, eventId: event.id };
    const cutoff = Timestamp.fromMillis(Date.now() - orderConfig.autoCompleteDays * 86_400_000);
    const delivered = await db.collection("orders")
      .where("status", "==", "delivered")
      .where("deliveredAt", "<=", cutoff)
      .orderBy("deliveredAt", "asc")
      .limit(100)
      .get();
    let completedCount = 0;
    for (const order of delivered.docs) {
      if (await completeOrder(request, order.id)) completedCount += 1;
    }
    logger.info("Scheduled order completion completed", {
      event: "order_completion",
      outcome: "success",
      completedCount,
    });
    return { completedCount };
  }),
);
