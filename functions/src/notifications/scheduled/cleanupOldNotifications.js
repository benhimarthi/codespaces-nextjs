import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db } from "../../utils/firebase.js";
import { notificationLimits } from "../shared/config.js";
import { notificationTriggerOptions } from "../triggers/options.js";

async function deleteExpired(collection, cutoff, field) {
  let deleted = 0;
  while (true) {
    const snapshot = await db.collection(collection)
      .where(field, "<", cutoff)
      .limit(400)
      .get();
    if (snapshot.empty) return deleted;
    const batch = db.batch();
    snapshot.docs.forEach((document) => batch.delete(document.ref));
    await batch.commit();
    deleted += snapshot.size;
    if (snapshot.size < 400) return deleted;
  }
}

export const cleanupOldNotifications = onSchedule({
  ...notificationTriggerOptions,
  schedule: "every day 03:00",
  timeZone: "UTC",
}, async () => {
  const now = Date.now();
  const removed = await deleteExpired(
    "notifications",
    Timestamp.fromMillis(now - notificationLimits.retentionDays * 86_400_000),
    "createdAt",
  );
  const expiredOtp = await deleteExpired("whatsappOtpRecords", Timestamp.now(), "expiresAt");
  const expiredCommands = await deleteExpired("whatsappPendingCommands", Timestamp.now(), "expiresAt");
  const expiredInbound = await deleteExpired("whatsappInboundMessages", Timestamp.now(), "expiresAt");
  logger.info("Notification cleanup completed", {
    event: "notification_cleanup",
    outcome: "success",
    removedNotifications: removed,
    removedOtpRecords: expiredOtp,
    removedPendingCommands: expiredCommands,
    removedInboundMessages: expiredInbound,
  });
});
