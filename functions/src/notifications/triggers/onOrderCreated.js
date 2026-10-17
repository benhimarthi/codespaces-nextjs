import { logger } from "firebase-functions";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { dispatchNotification } from "../engine/dispatcher.js";
import { notificationTriggerOptions } from "./options.js";
import { highValueThresholds } from "../shared/highValue.js";
import { notifyAdmins } from "./shared.js";

export const onOrderCreated = onDocumentCreated(
  { ...notificationTriggerOptions, document: "orders/{orderId}" },
  async (event) => {
    const order = event.data?.data();
    if (!order) return;
    try {
      await dispatchNotification({
        eventType: "order_created",
        recipientUid: order.sellerId,
        orderId: event.params.orderId,
        status: order.status,
      });
      const threshold = highValueThresholds[order.currency];
      if (Number.isSafeInteger(order.total) && Number.isSafeInteger(threshold) &&
        order.total >= threshold) {
        await notifyAdmins({
          eventType: "admin_high_value_order",
          orderId: event.params.orderId,
          status: order.status,
        });
      }
    } catch (error) {
      logger.error("Order-created notification failed", {
        event: "notification_trigger",
        outcome: "failure",
        code: "ORDER_CREATED_NOTIFICATION_FAILED",
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  },
);
