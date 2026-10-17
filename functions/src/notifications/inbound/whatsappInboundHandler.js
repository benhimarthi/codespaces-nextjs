import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onRequest } from "firebase-functions/v2/https";
import { auth, db } from "../../utils/firebase.js";
import { notificationLimits } from "../shared/config.js";
import { inboundMessageSchema } from "../shared/schemas.js";
import { privateDocumentId } from "../engine/dedupe.js";
import { reserveOutboundSlot } from "../engine/dispatcher.js";
import { WhatsAppAdapter } from "../engine/channels/whatsapp.adapter.js";
import { transitionOrder } from "../../orders/shared/transitions.js";

const projectId = process.env.GCLOUD_PROJECT ?? "your-firebase-project-id";
const options = Object.freeze({
  region: "us-central1",
  invoker: "private",
  maxInstances: 3,
  timeoutSeconds: 30,
  memory: "256MiB",
  serviceAccount: `store-notifications@${projectId}.iam.gserviceaccount.com`,
});

const transitions = Object.freeze({
  CONFIRMER: { actor: "seller", nextStatus: "confirmed", role: "seller" },
  REFUSER: {
    actor: "seller",
    nextStatus: "rejected",
    role: "seller",
    reason: "Order rejected by seller through WhatsApp.",
  },
  EXPEDIER: { actor: "seller", nextStatus: "out_for_delivery", role: "seller" },
  LIVRER: { actor: "seller", nextStatus: "delivered", role: "seller" },
  ANNULER: { actor: "buyer", nextStatus: "cancelled", role: "buyer" },
});

async function limitInbound(phoneNumber) {
  const minute = Math.floor(Date.now() / 60_000);
  const reference = db.collection("whatsappInboundLimits")
    .doc(privateDocumentId(`${phoneNumber}:${minute}`));
  await db.runTransaction(async (transaction) => {
    const current = await transaction.get(reference);
    if ((current.get("count") ?? 0) >= notificationLimits.inboundPerPhone) {
      const error = new Error("WHATSAPP_INBOUND_RATE_LIMITED");
      error.code = "WHATSAPP_INBOUND_RATE_LIMITED";
      throw error;
    }
    transaction.set(reference, {
      count: (current.get("count") ?? 0) + 1,
      expiresAt: Timestamp.fromMillis((minute + 2) * 60_000),
    });
  }).catch((error) => {
    if (error?.code === "WHATSAPP_INBOUND_RATE_LIMITED") {
      logger.warn("WhatsApp inbound rate limit exceeded", {
        event: "whatsapp_rate_limit",
        outcome: "denied",
        code: error.code,
        phoneSuffix: phoneNumber.slice(-2),
      });
    }
    throw error;
  });
}

async function sendReply(userId, phoneNumber, language, replyText) {
  await reserveOutboundSlot(userId, "whatsapp");
  const result = await WhatsAppAdapter.send({
    id: privateDocumentId(`${userId}:${Date.now()}:${replyText}`),
    eventType: "interaction_reply",
    templateContext: { replyText },
  }, {
    phoneNumber,
    whatsappAllowed: true,
    language,
  });
  if (!result.ok) {
    logger.warn("WhatsApp interaction reply failed", {
      event: "notification_delivery",
      channel: "whatsapp",
      outcome: "failure",
      code: result.errorCode,
      phoneSuffix: phoneNumber.slice(-2),
    });
  }
}

function commandFor(text) {
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  if (normalized === "AIDE" || normalized === "HELP") return { type: "help" };
  if (normalized === "STOP") return { type: "stop" };
  const match = normalized.match(/^(CONFIRMER|REFUSER|EXPEDIER|LIVRER|ANNULER|STATUT)\s+([A-Za-z0-9_-]{1,128})$/);
  if (!match) return { type: "unknown" };
  return { type: match[1], orderId: match[2] };
}

async function findLinkedUser(phoneNumber) {
  const owner = await db.collection("whatsappPhoneOwners")
    .doc(privateDocumentId(phoneNumber)).get();
  if (!owner.exists || owner.get("pending") === true) return null;
  return owner.get("userId");
}

async function getActiveCaller(uid) {
  const [account, profile] = await Promise.all([
    auth.getUser(uid),
    db.collection("users").doc(uid).get(),
  ]);
  if (!profile.exists || account.disabled ||
    profile.get("disabled") === true || profile.get("deleted") === true ||
    profile.get("status") === "disabled" || profile.get("status") === "deleted") return null;
  const claims = account.customClaims ?? {};
  return {
    uid,
    token: { ...claims, role: claims.role ?? profile.get("role") ?? "user" },
  };
}

async function sendHelp(uid, phoneNumber, language) {
  await sendReply(uid, phoneNumber, language,
    "Commandes: CONFIRMER, REFUSER, EXPEDIER, LIVRER ou ANNULER suivis de l'identifiant. STATUT <id>. Repondez OUI pour confirmer.");
}

async function processCommand(message, caller, phoneNumber, language) {
  const pendingRef = db.collection("whatsappPendingCommands").doc(privateDocumentId(phoneNumber));
  const command = commandFor(message.text);
  const preferencesRef = db.collection("notificationPreferences").doc(caller.uid);

  if (command.type === "stop") {
    await db.runTransaction(async (transaction) => {
      transaction.set(preferencesRef, {
        whatsappOptOutAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.delete(pendingRef);
    });
    await db.collection("auditLogs").add({
      actorUid: caller.uid,
      actorRole: caller.token.role,
      action: "whatsapp_consent",
      source: "whatsapp",
      consent: false,
      channel: "whatsapp",
      messageId: message.messageId,
      timestamp: FieldValue.serverTimestamp(),
      phoneSuffix: phoneNumber.slice(-2),
    });
    return;
  }

  const preference = await preferencesRef.get();
  if (preference.get("whatsappOptOutAt") != null) return;
  if (message.text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
    .match(/^OUI(?:\s+\d{8})?$/)) {
    const pending = await pendingRef.get();
    if (!pending.exists) {
      await sendHelp(caller.uid, phoneNumber, language);
      return;
    }
    const expiresAt = pending.get("expiresAt")?.toMillis?.() ?? 0;
    if (expiresAt <= Date.now() || pending.get("userId") !== caller.uid) {
      await pendingRef.delete();
      await sendReply(caller.uid, phoneNumber, language, "La confirmation a expire. Recommencez.");
      return;
    }
    const action = pending.get("command");
    const transition = transitions[action];
    if (!transition) {
      await pendingRef.delete();
      await sendHelp(caller.uid, phoneNumber, language);
      return;
    }
    const orderId = pending.get("orderId");
    const request = {
      auth: caller,
      rawRequest: { get: () => message.messageId, ip: null },
    };
    const pickupCode = message.text.match(/^OUI\s+(\d{8})$/i)?.[1];
    await transitionOrder({
      request,
      caller,
      orderId,
      nextStatus: transition.nextStatus,
      actor: transition.actor,
      ...(transition.reason ? { reason: transition.reason } : {}),
      ...(pickupCode ? { pickupCode } : {}),
      auditSource: "whatsapp",
      messageId: message.messageId,
      requireSellerOwnership: transition.role === "seller",
      requireBuyerOwnership: transition.role === "buyer",
    });
    await pendingRef.delete();
    await sendReply(caller.uid, phoneNumber, language, "La commande a ete mise a jour.");
    return;
  }
  if (command.type === "help" || command.type === "unknown") {
    await sendHelp(caller.uid, phoneNumber, language);
    return;
  }

  if (command.type === "STATUT") {
    const order = await db.collection("orders").doc(command.orderId).get();
    if (!order.exists ||
      (order.get("buyerUid") !== caller.uid && order.get("sellerId") !== caller.uid)) {
      await sendHelp(caller.uid, phoneNumber, language);
      return;
    }
    await sendReply(caller.uid, phoneNumber, language, `Statut: ${order.get("status")}.`);
    return;
  }

  const transition = transitions[command.type];
  if (!transition) {
    await sendHelp(caller.uid, phoneNumber, language);
    return;
  }
  const order = await db.collection("orders").doc(command.orderId).get();
  if (!order.exists ||
    (transition.role === "seller" && order.get("sellerId") !== caller.uid) ||
    (transition.role === "buyer" && order.get("buyerUid") !== caller.uid)) {
    await sendHelp(caller.uid, phoneNumber, language);
    return;
  }
  await pendingRef.set({
    userId: caller.uid,
    command: command.type,
    orderId: command.orderId,
    expiresAt: Timestamp.fromMillis(Date.now() + notificationLimits.pendingCommandExpiresMs),
    createdAt: FieldValue.serverTimestamp(),
  });
  await sendReply(caller.uid, phoneNumber, language, "Repondez OUI dans les 5 minutes pour confirmer.");
}

async function handleMessage(message) {
  await limitInbound(message.fromPhone);
  const uid = await findLinkedUser(message.fromPhone);
  if (!uid) {
    logger.warn("WhatsApp command from an unlinked number", {
      event: "whatsapp_inbound",
      outcome: "denied",
      code: "WHATSAPP_UNLINKED_NUMBER",
      phoneSuffix: message.fromPhone.slice(-2),
    });
    return;
  }
  const caller = await getActiveCaller(uid);
  if (!caller) return;
  const link = await db.collection("whatsappLinks").doc(uid).get();
  const language = (await db.collection("notificationPreferences").doc(uid).get())
    .get("language") ?? "fr";
  if (!link.exists || link.get("phoneNumber") !== message.fromPhone) return;

  const messageRef = db.collection("whatsappInboundMessages")
    .doc(privateDocumentId(message.messageId));
  let duplicate = false;
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(messageRef);
    if (existing.exists) {
      duplicate = true;
      return;
    }
    transaction.create(messageRef, {
      processedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 30 * 86_400_000),
      phoneSuffix: message.fromPhone.slice(-2),
    });
  });
  if (duplicate) {
    logger.info("Duplicate WhatsApp message ignored", {
      event: "whatsapp_inbound",
      outcome: "duplicate",
      code: "WHATSAPP_DUPLICATE_MESSAGE_ID",
      phoneSuffix: message.fromPhone.slice(-2),
    });
    return;
  }
  await processCommand(message, caller, message.fromPhone, language);
}

export const whatsappInboundHandler = onRequest(options, async (request, response) => {
  response.set("Cache-Control", "no-store");
  if (request.method !== "POST") {
    response.set("Allow", "POST").status(405).json({ error: "method_not_allowed" });
    return;
  }
  const parsed = inboundMessageSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "invalid_request" });
    return;
  }
  try {
    // Cloud Functions IAM rejects callers without an OIDC identity before this handler runs.
    await handleMessage(parsed.data);
    response.status(200).json({ accepted: true });
  } catch (error) {
    logger.error("WhatsApp inbound handler failed", {
      event: "whatsapp_inbound",
      outcome: "failure",
      code: typeof error?.code === "string" ? error.code : "WHATSAPP_INBOUND_FAILED",
      errorName: error instanceof Error ? error.name : typeof error,
    });
    response.status(500).json({ error: "unable_to_process" });
  }
});
