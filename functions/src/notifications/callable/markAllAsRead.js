import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../utils/firebase.js";
import { notificationOperation } from "./shared.js";
import { emptySchema } from "../shared/schemas.js";

export const markAllAsReadOperation = notificationOperation(
  "markAllAsRead",
  emptySchema,
  async (_input, { caller }) => {
    let updated = 0;
    while (true) {
      const snapshot = await db.collection("notifications")
        .where("userId", "==", caller.uid)
        .where("readAt", "==", null)
        .limit(400)
        .get();
      if (snapshot.empty) break;
      const batch = db.batch();
      for (const doc of snapshot.docs) {
        batch.update(doc.ref, { readAt: FieldValue.serverTimestamp() });
      }
      await batch.commit();
      updated += snapshot.size;
      if (snapshot.size < 400) break;
    }
    return { updated };
  },
);
