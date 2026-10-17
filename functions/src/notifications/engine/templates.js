const registry = Object.freeze({
  order_created: {
    name: "order_created",
    params: (context) => [context.orderReference],
    text: {
      fr: (reference) => `Nouvelle commande ${reference}. Ouvrez l'application pour les détails.`,
      ar: (reference) => `طلب جديد ${reference}. افتح التطبيق للاطلاع على التفاصيل.`,
      en: (reference) => `New order ${reference}. Open the app for details.`,
    },
  },
  order_confirmed: {
    name: "order_confirmed",
    params: (context) => [context.orderReference],
    text: {
      fr: (reference) => `Votre commande ${reference} a été confirmée.`,
      ar: (reference) => `تم تأكيد طلبك ${reference}.`,
      en: (reference) => `Your order ${reference} has been confirmed.`,
    },
  },
  order_rejected: {
    name: "order_rejected",
    params: (context) => [context.orderReference],
    text: {
      fr: (reference) => `Votre commande ${reference} a été refusée.`,
      ar: (reference) => `تم رفض طلبك ${reference}.`,
      en: (reference) => `Your order ${reference} was rejected.`,
    },
  },
  order_cancelled: {
    name: "order_cancelled",
    params: (context) => [context.orderReference],
    text: {
      fr: (reference) => `La commande ${reference} a été annulée.`,
      ar: (reference) => `تم إلغاء الطلب ${reference}.`,
      en: (reference) => `Order ${reference} was cancelled.`,
    },
  },
  order_out_for_delivery: {
    name: "order_out_for_delivery",
    params: (context) => [context.orderReference],
    text: {
      fr: (reference) => `Votre commande ${reference} est en cours de livraison.`,
      ar: (reference) => `طلبك ${reference} في طريقه إليك.`,
      en: (reference) => `Order ${reference} is out for delivery.`,
    },
  },
  order_ready_for_pickup: {
    name: "order_ready_for_pickup",
    params: (context) => [context.orderReference],
    text: {
      fr: (reference) => `Votre commande ${reference} est prête au retrait.`,
      ar: (reference) => `طلبك ${reference} جاهز للاستلام.`,
      en: (reference) => `Order ${reference} is ready for pickup.`,
    },
  },
  order_delivered: {
    name: "order_delivered",
    params: (context) => [context.orderReference],
    text: {
      fr: (reference) => `Votre commande ${reference} a été livrée.`,
      ar: (reference) => `تم تسليم طلبك ${reference}.`,
      en: (reference) => `Order ${reference} has been delivered.`,
    },
  },
  order_expired: {
    name: "order_expired",
    params: (context) => [context.orderReference],
    text: {
      fr: (reference) => `La commande ${reference} a expiré.`,
      ar: (reference) => `انتهت صلاحية الطلب ${reference}.`,
      en: (reference) => `Order ${reference} has expired.`,
    },
  },
  order_failed_delivery: {
    name: "order_failed_delivery",
    params: (context) => [context.orderReference],
    text: {
      fr: (reference) => `La livraison de la commande ${reference} a échoué.`,
      ar: (reference) => `تعذر تسليم الطلب ${reference}.`,
      en: (reference) => `Delivery of order ${reference} failed.`,
    },
  },
  seller_expiry_reminder: {
    name: "seller_expiry_reminder",
    params: (context) => [context.orderReference],
    text: {
      fr: (reference) => `La commande ${reference} attend votre confirmation.`,
      ar: (reference) => `الطلب ${reference} بانتظار تأكيدك.`,
      en: (reference) => `Order ${reference} is awaiting your confirmation.`,
    },
  },
  product_moderated: {
    name: "product_moderated",
    params: (context) => [context.productReference, context.productStatus],
    text: {
      fr: (reference, status) => `Le produit ${reference} a été modéré : ${status}.`,
      ar: (reference, status) => `تمت مراجعة المنتج ${reference}: ${status}.`,
      en: (reference, status) => `Product ${reference} was moderated: ${status}.`,
    },
  },
  admin_fraud_block: {
    name: "admin_fraud_block",
    params: (context) => [context.orderReference],
    text: {
      fr: (reference) => `Une règle de fraude a bloqué la commande ${reference}.`,
      ar: (reference) => `حظرت قاعدة مكافحة الاحتيال الطلب ${reference}.`,
      en: (reference) => `A fraud rule blocked order ${reference}.`,
    },
  },
  admin_repeated_failed_delivery: {
    name: "admin_repeated_failed_delivery",
    params: (context) => [context.orderReference],
    text: {
      fr: (reference) => `Échecs de livraison répétés pour la commande ${reference}.`,
      ar: (reference) => `تكررت محاولات فشل تسليم الطلب ${reference}.`,
      en: (reference) => `Repeated delivery failures for order ${reference}.`,
    },
  },
  admin_high_value_order: {
    name: "admin_high_value_order",
    params: (context) => [context.orderReference],
    text: {
      fr: (reference) => `La commande ${reference} nécessite une vérification prioritaire.`,
      ar: (reference) => `يحتاج الطلب ${reference} إلى مراجعة ذات أولوية.`,
      en: (reference) => `Order ${reference} needs priority review.`,
    },
  },
  interaction_reply: {
    name: "interaction_reply",
    params: (context) => [context.replyText],
    text: {
      fr: (reply) => reply,
      ar: (reply) => reply,
      en: (reply) => reply,
    },
  },
  whatsapp_link_code: {
    name: "whatsapp_link_code",
    params: (context) => [context.code],
    text: {
      fr: (code) => `Votre code de vérification WhatsApp est ${code}. Il expire dans 10 minutes.`,
      ar: (code) => `رمز التحقق من واتساب هو ${code}. تنتهي صلاحيته خلال 10 دقائق.`,
      en: (code) => `Your WhatsApp verification code is ${code}. It expires in 10 minutes.`,
    },
  },
});

const languages = Object.freeze(["fr", "ar", "en"]);

export function escapeTemplateParameter(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function templateFor(eventType, language, context = {}) {
  const template = registry[eventType];
  if (!template || !languages.includes(language)) return null;
  const params = template.params(context).map(escapeTemplateParameter);
  return Object.freeze({
    eventType,
    templateName: `${template.name}_${language}`,
    language,
    params,
    text: template.text[language](...params),
  });
}

export const templateEventTypes = Object.freeze(Object.keys(registry));
