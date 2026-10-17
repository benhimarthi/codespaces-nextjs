import { HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../utils/firebase.js";
import { notificationOperation } from "./shared.js";
import { notificationIdSchema } from "../shared/schemas.js";

export const markAsReadOperation = notificationOperation(
  "markAsRead",
  notificationIdSchema,
  async ({ notificationId }, { caller }) => {
    const reference = db.collection("notifications").doc(notificationId);
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists || snapshot.get("userId") !== caller.uid) {
        throw new HttpsError("not-found", "Notification not found.");
      }
      if (snapshot.get("readAt") == null) {
        transaction.update(reference, { readAt: FieldValue.serverTimestamp() });
      }
    });
    return { markedAsRead: true };
  },
);
