import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../../utils/firebase.js";
import { notificationOperation } from "./shared.js";
import { notificationPageSchema } from "../shared/schemas.js";

export const getMyNotificationsOperation = notificationOperation(
  "getMyNotifications",
  notificationPageSchema,
  async ({ pageSize = 20, pageToken, unreadOnly = false }, { caller }) => {
    let query = db.collection("notifications").where("userId", "==", caller.uid)
      .orderBy("createdAt", "desc").limit(pageSize + 1);
    if (unreadOnly) query = query.where("readAt", "==", null);
    if (pageToken) {
      const cursor = await db.collection("notifications").doc(pageToken).get();
      if (!cursor.exists || cursor.get("userId") !== caller.uid) {
        throw new HttpsError("not-found", "Notification not found.");
      }
      query = query.startAfter(cursor);
    }
    const result = await query.get();
    const docs = result.docs.slice(0, pageSize);
    return {
      notifications: docs.map((doc) => ({
        id: doc.id,
        eventType: doc.get("eventType"),
        orderId: doc.get("orderId") ?? null,
        title: doc.get("title"),
        body: doc.get("body"),
        status: doc.get("status"),
        channelsAttempted: doc.get("channelsAttempted") ?? [],
        readAt: doc.get("readAt")?.toDate?.().toISOString() ?? null,
        createdAt: doc.get("createdAt")?.toDate?.().toISOString() ?? null,
      })),
      nextPageToken: result.docs.length > pageSize ? docs.at(-1)?.id ?? null : null,
    };
  },
);
