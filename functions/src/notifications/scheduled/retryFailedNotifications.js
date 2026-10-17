import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db } from "../../utils/firebase.js";
import { retryNotification } from "../engine/dispatcher.js";
import { notificationTriggerOptions } from "../triggers/options.js";

export const retryFailedNotifications = onSchedule({
  ...notificationTriggerOptions,
  schedule: "every 1 minutes",
  timeZone: "UTC",
}, async () => {
  const due = await db.collection("notifications")
    .where("status", "==", "queued")
    .where("nextRetryAt", "<=", Timestamp.now())
    .orderBy("nextRetryAt", "asc")
    .limit(100)
    .get();
  for (const notification of due.docs) await retryNotification(notification);

  const recentFailure = await db.collection("notifications")
    .where("status", "==", "failed")
    .where("createdAt", ">=", Timestamp.fromMillis(Date.now() - 60 * 60_000))
    .limit(10)
    .get();
  if (recentFailure.size >= 10) {
    logger.error("Notification failure rate alert threshold exceeded", {
      event: "notification_failure_rate",
      outcome: "alert",
      code: "NOTIFICATION_FAILURE_RATE_HIGH",
      failedNotificationsInLastHour: recentFailure.size,
    });
  }
});
