import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../utils/firebase.js";
import { emptySchema } from "../shared/schemas.js";
import {
  auditNotification,
  notificationOperation,
} from "./shared.js";

export const unlinkWhatsAppNumberOperation = notificationOperation(
  "unlinkWhatsAppNumber",
  emptySchema,
  async (_input, state) => {
    const uid = state.caller.uid;
    const linkRef = db.collection("whatsappLinks").doc(uid);
    const preferenceRef = db.collection("notificationPreferences").doc(uid);
    await db.runTransaction(async (transaction) => {
      const link = await transaction.get(linkRef);
      if (link.exists) {
        transaction.delete(db.collection("whatsappPhoneOwners").doc(link.get("phoneKey")));
        transaction.delete(linkRef);
      }
      transaction.set(preferenceRef, {
        whatsappConsentAt: null,
        whatsappOptOutAt: FieldValue.serverTimestamp(),
        whatsappCriticalConsent: false,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    await auditNotification(state, "whatsapp_unlink", { channel: "whatsapp" });
    await auditNotification(state, "whatsapp_consent", {
      consent: false,
      channel: "whatsapp",
    });
    return { unlinked: true };
  },
);
