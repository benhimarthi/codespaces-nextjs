import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db } from "../../utils/firebase.js";
import { orderConfig } from "../../orders/shared/config.js";
import { notificationLimits } from "../shared/config.js";
import { dispatchNotification } from "../engine/dispatcher.js";
import { notificationTriggerOptions } from "../triggers/options.js";

export const remindSellerBeforeExpiry = onSchedule({
  ...notificationTriggerOptions,
  schedule: "every 15 minutes",
  timeZone: "UTC",
}, async () => {
  const now = Date.now();
  const expiryMs = orderConfig.unconfirmedExpiryHours * 3_600_000;
  const cutoff = Timestamp.fromMillis(now - expiryMs + notificationLimits.reminderLeadMs);
  const oldestIncluded = Timestamp.fromMillis(now - expiryMs);
  const orders = await db.collection("orders")
    .where("status", "==", "pending_confirmation")
    .where("createdAt", ">=", oldestIncluded)
    .where("createdAt", "<=", cutoff)
    .orderBy("createdAt", "asc")
    .limit(100)
    .get();
  let sent = 0;
  for (const order of orders.docs) {
    const result = await dispatchNotification({
      eventType: "seller_expiry_reminder",
      recipientUid: order.get("sellerId"),
      orderId: order.id,
      status: "pending_confirmation",
    });
    if (result.sent || result.queued) sent += 1;
  }
  logger.info("Seller expiry reminders processed", {
    event: "notification_reminder",
    outcome: "success",
    count: sent,
  });
});
