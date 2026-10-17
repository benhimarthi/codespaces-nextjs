import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { activeAccount } from "../../orders/shared/operation.js";
import { validate } from "../../middleware/validate.js";
import { runSafely } from "../../utils/errors.js";
import { db } from "../../utils/firebase.js";
import { privateDocumentId } from "../engine/dedupe.js";
import { reserveOutboundSlot } from "../engine/dispatcher.js";
import { whatsappConfig, WhatsAppAdapter } from "../engine/channels/whatsapp.adapter.js";
import { notificationLimits } from "../shared/config.js";

export function notificationOperation(name, schema, handler, policy) {
  return async (request) => runSafely(name, async () => {
    const state = await activeAccount(request, `notifications:${name}`, policy ?? {
      perUid: 60,
      perIp: 120,
      windowSeconds: 3600,
    });
    const input = validate(schema, request.data ?? {});
    return handler(input, state);
  });
}

export function auditNotification(state, action, details = {}) {
  return db.collection("auditLogs").add({
    actorUid: state.caller.uid,
    actorRole: state.caller.token.role ?? "user",
    action,
    source: "notifications",
    timestamp: FieldValue.serverTimestamp(),
    requestId: requestId(state.request),
    ip: state.request.rawRequest?.ip ?? null,
    ...details,
  });
}

function requestId(request) {
  const supplied = request.rawRequest?.get?.("x-request-id");
  return typeof supplied === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied)
    ? supplied
    : randomUUID();
}

export async function sendLinkCode(userId, phoneNumber, language, code) {
  await reserveOutboundSlot(userId, "whatsapp");
  const result = await WhatsAppAdapter.send({
    id: randomUUID(),
    eventType: "whatsapp_link_code",
    templateContext: { code },
  }, {
    phoneNumber,
    whatsappAllowed: true,
    language,
  });
  if (!result.ok) {
    throw new HttpsError("unavailable", "Unable to send a verification code.");
  }
}

export const linkWhatsAppRateLimit = notificationLimits.linkWhatsApp;
export { privateDocumentId };
