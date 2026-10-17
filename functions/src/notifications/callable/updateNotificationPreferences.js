import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../utils/firebase.js";
import {
  auditNotification,
  notificationOperation,
} from "./shared.js";
import { preferencesSchema } from "../shared/schemas.js";

export const updateNotificationPreferencesOperation = notificationOperation(
  "updateNotificationPreferences",
  preferencesSchema,
  async (input, state) => {
    const update = { updatedAt: FieldValue.serverTimestamp() };
    if (input.language !== undefined) update.language = input.language;
    if (input.categories !== undefined) update.categories = input.categories;
    if (input.marketingOptIn !== undefined) {
      update.marketingOptIn = input.marketingOptIn;
      update.marketingConsentAt = input.marketingOptIn
        ? FieldValue.serverTimestamp()
        : null;
    }
    await db.collection("notificationPreferences").doc(state.caller.uid)
      .set(update, { merge: true });
    if (input.marketingOptIn !== undefined) {
      await auditNotification(state, "notification_marketing_consent", {
        consent: input.marketingOptIn,
        channel: "notifications",
      });
    }
    return { updated: true };
  },
);
