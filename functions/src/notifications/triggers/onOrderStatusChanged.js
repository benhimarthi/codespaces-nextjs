import { logger } from "firebase-functions";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { db } from "../../utils/firebase.js";
import { orderConfig } from "../../orders/shared/config.js";
import { dispatchNotification } from "../engine/dispatcher.js";
import { notificationTriggerOptions } from "./options.js";
import { notifyAdmins } from "./shared.js";

const eventByStatus = Object.freeze({
  confirmed: "order_confirmed",
  rejected: "order_rejected",
  cancelled: "order_cancelled",
  out_for_delivery: "order_out_for_delivery",
  ready_for_pickup: "order_ready_for_pickup",
  delivered: "order_delivered",
  expired: "order_expired",
  failed_delivery: "order_failed_delivery",
});

export const onOrderStatusChanged = onDocumentUpdated(
  { ...notificationTriggerOptions, document: "orders/{orderId}" },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after || before.status === after.status) return;
    try {
      const eventType = eventByStatus[after.status];
      if (eventType) {
        const recipientUid = after.status === "cancelled" &&
          after.lastTransition?.actorUid === after.buyerUid
          ? after.sellerId
          : after.buyerUid;
        await dispatchNotification({
          eventType,
          recipientUid,
          orderId: event.params.orderId,
          status: after.status,
        });
      }
      if (after.status === "failed_delivery") {
        const reliability = await db.collection("_buyerReliability").doc(after.buyerUid).get();
        if ((reliability.get("failedDelivery") ?? 0) >= orderConfig.reliabilityStrikeLimit) {
          await notifyAdmins({
            eventType: "admin_repeated_failed_delivery",
            orderId: event.params.orderId,
            status: after.status,
          });
        }
      }
    } catch (error) {
      logger.error("Order status notification failed", {
        event: "notification_trigger",
        outcome: "failure",
        code: "ORDER_STATUS_NOTIFICATION_FAILED",
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  },
);
