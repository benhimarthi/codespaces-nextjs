import { defineSecret, defineString } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { templateFor } from "../templates.js";
import { fromWhatsAppResponse, toWhatsAppRequest } from "./whatsapp.mapper.js";

export const whatsappSendUrl = defineString("WHATSAPP_SEND_URL", {
  default: "https://us-central1-glass-arcanum-480721-n7.cloudfunctions.net/whatsapp/send",
});
export const whatsappOidcAudience = defineString("WHATSAPP_OIDC_AUDIENCE", {
  default: "https://us-central1-glass-arcanum-480721-n7.cloudfunctions.net/whatsapp",
});
export const whatsappConfig = Object.freeze({
  sendUrl: whatsappSendUrl,
  oidcAudience: whatsappOidcAudience,
  timeoutMs: 10_000,
});

async function identityToken(audience) {
  const metadataUrl = new URL(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
  );
  metadataUrl.searchParams.set("audience", audience);
  const response = await fetch(metadataUrl, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("WHATSAPP_OIDC_TOKEN_UNAVAILABLE");
  const token = await response.text();
  if (!token) throw new Error("WHATSAPP_OIDC_TOKEN_UNAVAILABLE");
  return token;
}

export const WhatsAppAdapter = Object.freeze({
  name: "whatsapp",
  supports: (eventType) => templateFor(eventType, "fr") !== null ||
    templateFor(eventType, "en") !== null ||
    templateFor(eventType, "ar") !== null,
  async send(notification, recipient) {
    if (!recipient.phoneNumber || !recipient.whatsappAllowed) {
      return { ok: false, errorCode: "WHATSAPP_RECIPIENT_NOT_CONSENTED" };
    }
    if (process.env.FUNCTIONS_EMULATOR === "true" ||
      process.env.FIREBASE_EMULATOR_HUB ||
      process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      return { ok: true, messageId: "emulator:whatsapp" };
    }
    const url = whatsappConfig.sendUrl.value();
    if (!url) return { ok: false, errorCode: "WHATSAPP_ENDPOINT_NOT_CONFIGURED" };
    const template = templateFor(
      notification.eventType,
      recipient.language ?? "fr",
      notification.templateContext,
    );
    if (!template) return { ok: false, errorCode: "WHATSAPP_TEMPLATE_NOT_CONFIGURED" };

    const request = toWhatsAppRequest({ ...notification, recipient }, template);
    const body = JSON.stringify(request);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await identityToken(whatsappConfig.oidcAudience.value())}`,
      },
      body,
      signal: AbortSignal.timeout(whatsappConfig.timeoutMs),
    });
    if (!response.ok) {
      logger.warn("WhatsApp delivery failed", {
        event: "notification_delivery",
        channel: "whatsapp",
        outcome: "failure",
        code: `WHATSAPP_HTTP_${response.status}`,
        phoneSuffix: recipient.phoneNumber.slice(-2),
      });
      return { ok: false, errorCode: `WHATSAPP_HTTP_${response.status}` };
    }
    try {
      return { ok: true, ...fromWhatsAppResponse(await response.json()) };
    } catch (error) {
      logger.warn("WhatsApp response could not be mapped", {
        event: "notification_delivery",
        channel: "whatsapp",
        outcome: "failure",
        code: "WHATSAPP_RESPONSE_INVALID",
        phoneSuffix: recipient.phoneNumber.slice(-2),
      });
      throw error;
    }
  },
});
