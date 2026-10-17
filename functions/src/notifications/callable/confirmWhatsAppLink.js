import { createHash, timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { db } from "../../utils/firebase.js";
import { confirmLinkSchema } from "../shared/schemas.js";
import {
  auditNotification,
  notificationOperation,
  privateDocumentId,
} from "./shared.js";

export const confirmWhatsAppLinkOperation = notificationOperation(
  "confirmWhatsAppLink",
  confirmLinkSchema,
  async ({ code }, state) => {
    const uid = state.caller.uid;
    const pendingRef = db.collection("whatsappOtpRecords").doc(uid);
    const confirmed = await db.runTransaction(async (transaction) => {
      const pending = await transaction.get(pendingRef);
      if (!pending.exists) throw new HttpsError("failed-precondition", "Verification failed.");
      const stored = pending.get("codeHash");
      const supplied = createHash("sha256").update(`${uid}:${code}`).digest("hex");
      const storedBuffer = Buffer.from(stored ?? "", "hex");
      const suppliedBuffer = Buffer.from(supplied, "hex");
      const matches = storedBuffer.length === suppliedBuffer.length &&
        timingSafeEqual(storedBuffer, suppliedBuffer);
      const expiresAt = pending.get("expiresAt")?.toMillis?.() ?? 0;
      const attempts = pending.get("attempts") ?? 0;
      if (expiresAt <= Date.now() || attempts >= 5) {
        transaction.delete(pendingRef);
        return null;
      }
      if (!matches) {
        if (attempts + 1 >= 5) transaction.delete(pendingRef);
        else transaction.update(pendingRef, { attempts: attempts + 1 });
        return false;
      }

      const phoneNumber = pending.get("phoneNumber");
      const phoneKey = pending.get("phoneKey");
      const ownerRef = db.collection("whatsappPhoneOwners").doc(phoneKey);
      const owner = await transaction.get(ownerRef);
      if (owner.get("userId") !== uid) {
        transaction.delete(pendingRef);
        throw new HttpsError("failed-precondition", "Verification failed.");
      }
      const linkRef = db.collection("whatsappLinks").doc(uid);
      const current = await transaction.get(linkRef);
      if (current.exists && current.get("phoneKey") !== phoneKey) {
        transaction.delete(db.collection("whatsappPhoneOwners").doc(current.get("phoneKey")));
      }
      transaction.set(linkRef, {
        phoneNumber,
        phoneKey,
        verifiedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(ownerRef, {
        userId: uid,
        linkedAt: FieldValue.serverTimestamp(),
        pending: false,
        expiresAt: FieldValue.delete(),
      }, { merge: true });
      transaction.delete(pendingRef);
      return { phoneSuffix: phoneNumber.slice(-2) };
    });
    if (!confirmed) {
      logger.warn("WhatsApp verification failed", {
        event: "whatsapp_verification",
        outcome: "denied",
        code: "WHATSAPP_OTP_INVALID_OR_EXPIRED",
        uid,
      });
      await auditNotification(state, "whatsapp_link_verification_failed", {
        code: "WHATSAPP_OTP_INVALID_OR_EXPIRED",
      });
      throw new HttpsError("failed-precondition", "Verification failed.");
    }
    await auditNotification(state, "whatsapp_link", {
      phoneSuffix: confirmed.phoneSuffix,
    });
    return { linked: true };
  },
);
