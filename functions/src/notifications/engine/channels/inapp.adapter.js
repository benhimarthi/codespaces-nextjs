import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../../utils/firebase.js";

export const InAppAdapter = Object.freeze({
  name: "inapp",
  supports: () => true,
  async send(notification) {
    const reference = db.collection("notifications").doc(notification.id);
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(reference);
      if (!current.exists) {
        transaction.create(reference, {
          userId: notification.userId,
          eventType: notification.eventType,
          orderId: notification.orderId ?? null,
          resourceId: notification.resourceId,
          dedupeStatus: notification.dedupeStatus,
          channelsAttempted: [],
          status: "queued",
          readAt: null,
          title: notification.title,
          body: notification.body,
          createdAt: FieldValue.serverTimestamp(),
          delivery: {},
          channelChain: notification.channelChain,
          channelIndex: 0,
          templateContext: notification.templateContext,
          language: notification.language,
          critical: notification.critical,
          nextRetryAt: FieldValue.serverTimestamp(),
        });
      }
    });
    return { ok: true };
  },
});
