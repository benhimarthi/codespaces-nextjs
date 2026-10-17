export const notificationLimits = Object.freeze({
  callable: Object.freeze({ perUid: 60, perIp: 120, windowSeconds: 3600 }),
  linkWhatsApp: Object.freeze({ perUid: 3, perIp: 5, windowSeconds: 3600 }),
  inboundPerPhone: 10,
  otpAttempts: 5,
  otpExpiresMs: 10 * 60 * 1000,
  pendingCommandExpiresMs: 5 * 60 * 1000,
  maxAttempts: 3,
  retryBaseMs: 60_000,
  retryMaxMs: 60 * 60 * 1000,
  userChannelHourly: Object.freeze({ whatsapp: 20, fcm: 60, email: 10 }),
  userChannelDaily: Object.freeze({ whatsapp: 100, fcm: 500, email: 50 }),
  whatsappGlobalDailyBudget: 1000,
  reminderLeadMs: 60 * 60 * 1000,
  retentionDays: 90,
});

export const routingConfig = Object.freeze({
  default: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: false }),
  order_created: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: true }),
  order_confirmed: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: true }),
  order_rejected: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: true }),
  order_cancelled: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: true }),
  order_out_for_delivery: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: true }),
  order_ready_for_pickup: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: true }),
  order_delivered: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: true }),
  order_expired: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: true }),
  order_failed_delivery: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: true }),
  seller_expiry_reminder: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: true }),
  product_moderated: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: false }),
  admin_fraud_block: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: true }),
  admin_repeated_failed_delivery: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: true }),
  admin_high_value_order: Object.freeze({ primary: "whatsapp", fallback: ["fcm", "email"], critical: true }),
  interaction_reply: Object.freeze({ primary: "whatsapp", fallback: [], critical: true }),
});

export function routeFor(eventType) {
  return routingConfig[eventType] ?? routingConfig.default;
}
