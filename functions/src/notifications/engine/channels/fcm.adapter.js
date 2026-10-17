import { getMessaging } from "firebase-admin/messaging";
import { logger } from "firebase-functions";

export function buildFcmMessage(notification, tokens) {
  return {
    tokens,
    notification: {
      title: notification.title,
      body: notification.body,
    },
    data: {
      eventType: notification.eventType,
      notificationId: notification.id,
    },
  };
}

export const FcmAdapter = Object.freeze({
  name: "fcm",
  supports: () => true,
  async send(notification, recipient) {
    const tokens = recipient.deviceTokens ?? [];
    if (tokens.length === 0) return { ok: false, errorCode: "FCM_NO_DEVICE_TOKENS" };
    if (process.env.FIREBASE_EMULATOR_HUB || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      return { ok: true, messageId: "emulator:fcm" };
    }
    const result = await getMessaging().sendEachForMulticast(buildFcmMessage(notification, tokens));
    if (result.successCount > 0) return { ok: true, messageId: "fcm:sent" };
    logger.warn("FCM delivery failed", {
      event: "notification_delivery",
      channel: "fcm",
      outcome: "failure",
      code: "FCM_ALL_SENDS_FAILED",
    });
    return { ok: false, errorCode: "FCM_ALL_SENDS_FAILED" };
  },
});
