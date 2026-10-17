import { createHash, randomInt } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../../utils/firebase.js";
import { notificationLimits } from "../shared/config.js";
import { linkPhoneSchema } from "../shared/schemas.js";
import {
  auditNotification,
  linkWhatsAppRateLimit,
  notificationOperation,
  privateDocumentId,
  sendLinkCode,
} from "./shared.js";

export const linkWhatsAppNumberOperation = notificationOperation(
  "linkWhatsAppNumber",
  linkPhoneSchema,
  async ({ phoneNumber }, state) => {
    const uid = state.caller.uid;
    const phoneKey = privateDocumentId(phoneNumber);
    const ownerRef = db.collection("whatsappPhoneOwners").doc(phoneKey);
    const pendingRef = db.collection("whatsappOtpRecords").doc(uid);
    const preferenceRef = db.collection("notificationPreferences").doc(uid);
    const code = String(randomInt(100_000, 1_000_000));
    const codeHash = createHash("sha256").update(`${uid}:${code}`).digest("hex");
    const expiresAt = Timestamp.fromMillis(Date.now() + notificationLimits.otpExpiresMs);

    await db.runTransaction(async (transaction) => {
      const [owner, preferences] = await Promise.all([
        transaction.get(ownerRef),
        transaction.get(preferenceRef),
      ]);
      const currentOwner = owner.get("userId");
      const currentExpiry = owner.get("pending") === true
        ? owner.get("expiresAt")?.toMillis?.() ?? 0
        : Number.MAX_SAFE_INTEGER;
      if (currentOwner && currentOwner !== uid && currentExpiry > Date.now()) {
        throw new HttpsError("already-exists", "Number cannot be linked.");
      }
      transaction.set(ownerRef, { userId: uid, expiresAt, pending: true });
      transaction.set(pendingRef, {
        codeHash,
        phoneNumber,
        phoneKey,
        attempts: 0,
        expiresAt,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.set(preferenceRef, {
        whatsappConsentAt: preferences.get("whatsappConsentAt") ?? FieldValue.serverTimestamp(),
        whatsappConsentChannel: "callable",
        whatsappCriticalConsent: true,
        whatsappOptOutAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    await auditNotification(state, "whatsapp_consent", {
      consent: true,
      channel: "whatsapp",
    });
    await sendLinkCode(
      uid,
      phoneNumber,
      (await db.collection("notificationPreferences").doc(uid).get()).get("language") ?? "fr",
      code,
    );
    return { verificationSent: true, expiresInSeconds: notificationLimits.otpExpiresMs / 1000 };
  },
  linkWhatsAppRateLimit,
);
