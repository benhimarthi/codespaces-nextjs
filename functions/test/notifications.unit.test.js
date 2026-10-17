import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFcmMessage } from "../src/notifications/engine/channels/fcm.adapter.js";
import { WhatsAppAdapter } from "../src/notifications/engine/channels/whatsapp.adapter.js";
import {
  fromWhatsAppResponse,
  toWhatsAppRequest,
} from "../src/notifications/engine/channels/whatsapp.mapper.js";
import { channelChain } from "../src/notifications/engine/router.js";
import { escapeTemplateParameter, templateFor } from "../src/notifications/engine/templates.js";
import { inboundMessageSchema, linkPhoneSchema } from "../src/notifications/shared/schemas.js";
import { createMockWhatsAppServer } from "./support/mockWhatsAppServer.js";

test("default order routing prefers WhatsApp then FCM then email", () => {
  assert.deepEqual(channelChain("order_confirmed"), ["whatsapp", "fcm", "email"]);
});

test("WhatsApp registry renders localized messages and escapes parameters", () => {
  const template = templateFor("order_confirmed", "fr", {
    orderReference: "<order&1>",
  });
  assert.equal(template.templateName, "order_confirmed_fr");
  assert.deepEqual(template.params, ["&lt;order&amp;1&gt;"]);
  assert.equal(escapeTemplateParameter(`"'`), "&quot;&#39;");
  assert.equal(templateFor("unregistered", "fr"), null);
});

test("WhatsApp mapper keeps request and response shapes in one integration boundary", () => {
  const request = toWhatsAppRequest({
    id: "deterministic-id",
    recipient: { phoneNumber: "+212612345678" },
  }, {
    templateName: "order_confirmed_fr",
    language: "fr",
    params: ["ORD-123"],
    text: "Votre commande ORD-123 a été confirmée.",
  });
  assert.deepEqual(request, {
    to: "+212612345678",
    text: "Votre commande ORD-123 a été confirmée.",
  });
  assert.deepEqual(fromWhatsAppResponse({
    success: true,
    data: { msgId: "provider-123", jid: "+212612345678@s.whatsapp.net", status: "in_progress" },
  }), {
    messageId: "provider-123",
  });
  assert.throws(() => fromWhatsAppResponse({ success: true, data: { messageId: "provider-123" } }),
    /WHATSAPP_RESPONSE_INVALID/);
  assert.equal(templateFor("order_confirmed", "fr", {
    orderReference: "ORD-123",
  }).text, "Votre commande ORD-123 a été confirmée.");
});

test("emulator WhatsApp mock server verifies Bearer auth and returns the service response", async () => {
  const token = "emulator-oidc-token";
  const mock = createMockWhatsAppServer({ token });
  const url = await mock.listen();
  try {
    const payload = JSON.stringify({
      to: "+212612345678",
      text: "Votre commande ORD-123 a été confirmée.",
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: payload,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      data: {
        msgId: "mock-1",
        jid: "+212612345678@s.whatsapp.net",
        status: "in_progress",
      },
    });
    assert.equal(mock.messages.length, 1);

    const rejected = await fetch(url, { method: "POST", body: payload });
    assert.equal(rejected.status, 401);
  } finally {
    await mock.close();
  }
});

test("WhatsApp adapter never calls the configured live endpoint in the Functions emulator", async () => {
  const previousValue = process.env.FUNCTIONS_EMULATOR;
  process.env.FUNCTIONS_EMULATOR = "true";
  try {
    const result = await WhatsAppAdapter.send({
      id: "notification-1",
      eventType: "order_confirmed",
      templateContext: { orderReference: "ORD-123" },
    }, {
      phoneNumber: "+212612345678",
      whatsappAllowed: true,
    });
    assert.deepEqual(result, { ok: true, messageId: "emulator:whatsapp" });
  } finally {
    if (previousValue === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = previousValue;
  }
});

test("FCM payload contains no delivery details, amounts, phone numbers, or pickup codes", () => {
  const payload = buildFcmMessage({
    id: "notification-id",
    eventType: "order_ready_for_pickup",
    title: "Order update",
    body: "Your order was updated. Open the app for details.",
    address: "private address",
    phoneNumber: "+212612345678",
    amount: 9000,
    pickupCode: "12345678",
  }, ["device-token"]);
  assert.deepEqual(Object.keys(payload).sort(), ["data", "notification", "tokens"]);
  assert.deepEqual(Object.keys(payload.data).sort(), ["eventType", "notificationId"]);
  assert.equal(JSON.stringify(payload).includes("+212"), false);
  assert.equal(JSON.stringify(payload).includes("12345678"), false);
  assert.equal(JSON.stringify(payload).includes("private address"), false);
  assert.equal(JSON.stringify(payload).includes("9000"), false);
});

test("WhatsApp callables validate E.164 numbers and inbound messages strictly", () => {
  assert.equal(linkPhoneSchema.safeParse({
    phoneNumber: "+212612345678",
    consent: true,
  }).success, true);
  assert.equal(linkPhoneSchema.safeParse({
    phoneNumber: "0612345678",
    consent: true,
  }).success, false);
  assert.equal(inboundMessageSchema.safeParse({
    fromPhone: "+212612345678",
    messageId: "wamid-test",
    text: "AIDE",
    timestamp: Date.now(),
    ignored: true,
  }).success, false);
});
