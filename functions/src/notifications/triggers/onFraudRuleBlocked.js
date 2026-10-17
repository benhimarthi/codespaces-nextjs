import { logger } from "firebase-functions";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { notificationTriggerOptions } from "./options.js";
import { notifyAdmins } from "./shared.js";

export const onFraudRuleBlocked = onDocumentCreated(
  { ...notificationTriggerOptions, document: "auditLogs/{auditId}" },
  async (event) => {
    const entry = event.data?.data();
    if (typeof entry?.action !== "string" || !entry.action.startsWith("fraud_block:")) return;
    try {
      await notifyAdmins({
        eventType: "admin_fraud_block",
        orderId: entry.orderId ?? event.params.auditId,
        status: entry.reason ?? "blocked",
      });
    } catch (error) {
      logger.error("Fraud block notification failed", {
        event: "notification_trigger",
        outcome: "failure",
        code: "FRAUD_BLOCK_NOTIFICATION_FAILED",
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  },
);
