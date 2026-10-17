import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { auth, db } from "../../utils/firebase.js";
import { notificationLimits } from "../shared/config.js";
import { notificationId, privateDocumentId } from "./dedupe.js";
import { channelChain, isCritical } from "./router.js";
import { EmailAdapter } from "./channels/email.adapter.js";
import { FcmAdapter } from "./channels/fcm.adapter.js";
import { InAppAdapter } from "./channels/inapp.adapter.js";
import { WhatsAppAdapter } from "./channels/whatsapp.adapter.js";

const adapters = new Map([
  ["whatsapp", WhatsAppAdapter],
  ["fcm", FcmAdapter],
  ["email", EmailAdapter],
]);

function enabledFor(preferences, channel, critical) {
  const category = preferences?.categories?.orderUpdates?.[channel];
  return critical || category !== false;
}

async function recipientFor(userId, eventType) {
  const [profileSnapshot, preferenceSnapshot, deviceSnapshots, linkSnapshot] = await Promise.all([
    db.collection("users").doc(userId).get(),
    db.collection("notificationPreferences").doc(userId).get(),
    db.collection("deviceTokens").doc(userId).collection("tokens").get(),
    db.collection("whatsappLinks").doc(userId).get(),
  ]);
  if (!profileSnapshot.exists || profileSnapshot.get("disabled") === true ||
    profileSnapshot.get("deleted") === true || profileSnapshot.get("status") === "disabled" ||
    profileSnapshot.get("status") === "deleted") return null;

  let account;
  try {
    account = await auth.getUser(userId);
  } catch (error) {
    if (error?.code === "auth/user-not-found") return null;
    throw error;
  }
  if (account.disabled) return null;

  const preferences = preferenceSnapshot.data() ?? {};
  const link = linkSnapshot.data();
  const critical = isCritical(eventType);
  const whatsappAllowed = Boolean(link?.phoneNumber && preferences.whatsappConsentAt &&
    (!preferences.whatsappOptOutAt ||
      (critical && preferences.whatsappCriticalConsent === true)) &&
    enabledFor(preferences, "whatsapp", critical));
  return {
    userId,
    email: account.email ?? null,
    phoneNumber: whatsappAllowed ? link.phoneNumber : null,
    whatsappAllowed,
    language: preferences.language ?? "fr",
    deviceTokens: deviceSnapshots.docs.map((doc) => doc.get("token")).filter(Boolean),
    preferences,
  };
}

export async function reserveOutboundSlot(userId, channel) {
  const now = new Date();
  const hour = Math.floor(now.getTime() / 3_600_000);
  const day = now.toISOString().slice(0, 10);
  const hourlyRef = db.collection("notificationUsage")
    .doc(privateDocumentId(`${userId}:${channel}:hour:${hour}`));
  const dailyRef = db.collection("notificationUsage")
    .doc(privateDocumentId(`${userId}:${channel}:day:${day}`));
  const globalRef = db.collection("notificationUsage")
    .doc(privateDocumentId(`global:whatsapp:day:${day}`));
  const hourlyMax = notificationLimits.userChannelHourly[channel];
  const dailyMax = notificationLimits.userChannelDaily[channel];

  await db.runTransaction(async (transaction) => {
    const refs = channel === "whatsapp" ? [hourlyRef, dailyRef, globalRef] : [hourlyRef, dailyRef];
    const snapshots = await Promise.all(refs.map((reference) => transaction.get(reference)));
    if (snapshots[0].get("count") >= hourlyMax || snapshots[1].get("count") >= dailyMax) {
      throw new Error("NOTIFICATION_USER_CHANNEL_LIMIT");
    }
    if (channel === "whatsapp" &&
      snapshots[2].get("count") >= notificationLimits.whatsappGlobalDailyBudget) {
      logger.error("WhatsApp daily budget exhausted", {
        event: "notification_budget",
        channel,
        outcome: "blocked",
        code: "WHATSAPP_DAILY_BUDGET_EXHAUSTED",
      });
      throw new Error("WHATSAPP_DAILY_BUDGET_EXHAUSTED");
    }
    transaction.set(hourlyRef, { count: (snapshots[0].get("count") ?? 0) + 1, day, hour });
    transaction.set(dailyRef, { count: (snapshots[1].get("count") ?? 0) + 1, day });
    if (channel === "whatsapp") {
      const count = (snapshots[2].get("count") ?? 0) + 1;
      transaction.set(globalRef, { count, day, channel });
      if (count === Math.floor(notificationLimits.whatsappGlobalDailyBudget * 0.8)) {
        logger.warn("WhatsApp daily budget alert threshold reached", {
          event: "notification_budget",
          channel,
          outcome: "alert",
          code: "WHATSAPP_DAILY_BUDGET_80_PERCENT",
        });
      }
    }
  });
}

function localizedCopy(eventType, language) {
  const status = eventType.replace("order_", "").replaceAll("_", " ");
  if (language === "ar") {
    return {
      title: "تحديث طلبك",
      body: "تم تحديث طلبك. افتح التطبيق للاطلاع على التفاصيل.",
    };
  }
  if (language === "en") {
    return {
      title: "Order update",
      body: `Your order was updated (${status}). Open the app for details.`,
    };
  }
  return {
    title: "Mise à jour de votre commande",
    body: `Votre commande a été mise à jour (${status}). Ouvrez l'application pour les détails.`,
  };
}

async function writeAttempt(reference, channel, attempt, outcome, errorCode = null) {
  const update = {
    [`delivery.${channel}`]: {
      attempts: attempt,
      status: outcome,
      lastErrorCode: errorCode,
      nextRetryAt: outcome === "retrying" ? Timestamp.fromDate(nextRetryDate(attempt)) : null,
    },
    channelsAttempted: FieldValue.arrayUnion(channel),
    dispatchLeaseUntil: FieldValue.delete(),
  };
  if (outcome === "sent") {
    update.status = "sent";
    update.sentAt = FieldValue.serverTimestamp();
    update.nextRetryAt = null;
  } else if (outcome === "retrying") {
    update.status = "queued";
    update.nextRetryAt = Timestamp.fromDate(nextRetryDate(attempt));
  }
  await reference.update(update);
}

function nextRetryDate(attempt) {
  return new Date(Date.now() + Math.min(
    notificationLimits.retryBaseMs * (2 ** Math.max(0, attempt - 1)),
    notificationLimits.retryMaxMs,
  ));
}

async function deadLetter(reference, notification, errorCode) {
  const data = {
    notificationId: notification.id,
    userId: notification.userId,
    eventType: notification.eventType,
    orderId: notification.orderId ?? null,
    errorCode,
    createdAt: FieldValue.serverTimestamp(),
  };
  await db.collection("notificationDeadLetters").doc(notification.id).set(data, { merge: true });
  await reference.update({
    status: "failed",
    nextRetryAt: null,
    dispatchLeaseUntil: FieldValue.delete(),
  });
  logger.error("Notification permanently failed", {
    event: "notification_delivery",
    outcome: "failure",
    code: "NOTIFICATION_DEAD_LETTER",
    eventType: notification.eventType,
  });
}

export async function dispatchNotification({
  eventType,
  recipientUid,
  orderId = null,
  status = null,
  resourceId = orderId,
  templateContext = {},
}) {
  const recipient = await recipientFor(recipientUid, eventType);
  if (!recipient) return { skipped: true };

  const route = channelChain(eventType);
  const critical = isCritical(eventType);
  const id = notificationId(eventType, resourceId, status, recipientUid);
  const copy = localizedCopy(eventType, recipient.language);
  const notification = {
    id,
    userId: recipientUid,
    eventType,
    orderId,
    resourceId,
    dedupeStatus: status,
    title: copy.title,
    body: copy.body,
    channelChain: route,
    templateContext: { orderReference: orderId ?? resourceId, ...templateContext },
    language: recipient.language,
    critical,
  };
  const reference = db.collection("notifications").doc(id);
  await InAppAdapter.send(notification);

  while (true) {
    const claimed = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists || ["sent", "delivered", "failed"].includes(snapshot.get("status"))) return null;
      const lease = snapshot.get("dispatchLeaseUntil")?.toMillis?.() ?? 0;
      if (lease > Date.now()) return null;
      const index = snapshot.get("channelIndex") ?? 0;
      const channels = snapshot.get("channelChain") ?? route;
      if (index >= channels.length) return { exhausted: true, data: snapshot.data() };
      const nextRetry = snapshot.get("nextRetryAt")?.toMillis?.() ?? 0;
      if (nextRetry > Date.now()) return null;
      transaction.update(reference, {
        dispatchLeaseUntil: Timestamp.fromMillis(Date.now() + 60_000),
        channelIndex: index,
      });
      return {
        channel: channels[index],
        index,
        attempt: (snapshot.get(`delivery.${channels[index]}.attempts`) ?? 0) + 1,
        data: snapshot.data(),
      };
    });

    if (!claimed) return { queued: true };
    if (claimed.exhausted) {
      const latestError = Object.values(claimed.data.delivery ?? {})
        .map((delivery) => delivery.lastErrorCode)
        .filter(Boolean)
        .at(-1) ?? "NOTIFICATION_NO_CHANNELS";
      await deadLetter(reference, notification, latestError);
      return { failed: true };
    }

    const channel = claimed.channel;
    const adapter = adapters.get(channel);
    if (!adapter || !adapter.supports(eventType)) {
      await writeAttempt(reference, channel, claimed.attempt, "failed", "CHANNEL_UNSUPPORTED");
      await reference.update({ channelIndex: claimed.index + 1, nextRetryAt: Timestamp.fromMillis(0) });
      continue;
    }
    const unavailable = (channel === "whatsapp" && !recipient.whatsappAllowed) ||
      (channel === "fcm" && recipient.deviceTokens.length === 0) ||
      (channel === "email" && !recipient.email);
    if (unavailable) {
      await writeAttempt(reference, channel, claimed.attempt, "failed", `${channel.toUpperCase()}_NOT_AVAILABLE`);
      await reference.update({ channelIndex: claimed.index + 1, nextRetryAt: Timestamp.fromMillis(0) });
      continue;
    }
    if (!enabledFor(recipient.preferences, channel, critical) && channel !== "whatsapp") {
      await writeAttempt(reference, channel, claimed.attempt, "failed", "CHANNEL_DISABLED_BY_PREFERENCE");
      await reference.update({ channelIndex: claimed.index + 1, nextRetryAt: Timestamp.fromMillis(0) });
      continue;
    }

    let result;
    try {
      await reserveOutboundSlot(recipientUid, channel);
      result = await adapter.send(notification, recipient);
    } catch (error) {
      result = {
        ok: false,
        errorCode: typeof error?.message === "string" &&
          /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : `${channel.toUpperCase()}_SEND_FAILED`,
      };
    }

    if (result.ok) {
      await writeAttempt(reference, channel, claimed.attempt, "sent");
      return { sent: true, channel };
    }

    const lastAttempt = claimed.attempt >= notificationLimits.maxAttempts;
    const errorCode = result.errorCode ?? `${channel.toUpperCase()}_SEND_FAILED`;
    logger.warn("Notification channel delivery failed", {
      event: "notification_delivery",
      channel,
      outcome: "failure",
      code: errorCode,
      attempt: claimed.attempt,
      recipientUid,
    });
    await writeAttempt(reference, channel, claimed.attempt, lastAttempt ? "failed" : "retrying", errorCode);
    if (lastAttempt) {
      await reference.update({
        channelIndex: claimed.index + 1,
        nextRetryAt: Timestamp.fromMillis(0),
      });
      continue;
    }
    return { queued: true, channel, nextRetryAt: nextRetryDate(claimed.attempt) };
  }
}

export async function retryNotification(notificationSnapshot) {
  const data = notificationSnapshot.data();
  if (!data?.userId) return { skipped: true };
  return dispatchNotification({
    eventType: data.eventType,
    recipientUid: data.userId,
    orderId: data.orderId ?? null,
    status: data.dedupeStatus ?? null,
    resourceId: data.resourceId ?? data.orderId,
    templateContext: data.templateContext ?? { orderReference: data.orderId ?? data.resourceId },
  });
}
