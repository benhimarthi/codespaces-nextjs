import { logger } from "firebase-functions";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { dispatchNotification } from "../engine/dispatcher.js";
import { notificationTriggerOptions } from "./options.js";

export const onProductModerated = onDocumentUpdated(
  { ...notificationTriggerOptions, document: "products/{productId}" },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after || before.status === after.status ||
      !["active", "rejected"].includes(after.status)) return;
    try {
      await dispatchNotification({
        eventType: "product_moderated",
        recipientUid: after.sellerId,
        resourceId: event.params.productId,
        status: after.status,
        templateContext: {
          productReference: event.params.productId,
          productStatus: after.status,
        },
      });
    } catch (error) {
      logger.error("Product moderation notification failed", {
        event: "notification_trigger",
        outcome: "failure",
        code: "PRODUCT_MODERATION_NOTIFICATION_FAILED",
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  },
);
