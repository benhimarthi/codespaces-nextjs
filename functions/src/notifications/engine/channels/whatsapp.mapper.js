export function toWhatsAppRequest(notification, template) {
  if (typeof template?.text !== "string" || !template.text) {
    throw new Error("WHATSAPP_TEMPLATE_TEXT_INVALID");
  }
  return {
    to: notification.recipient.phoneNumber,
    text: template.text,
  };
}

export function fromWhatsAppResponse(response) {
  if (response?.success !== true ||
    typeof response.data?.msgId !== "string" || !response.data.msgId) {
    throw new Error("WHATSAPP_RESPONSE_INVALID");
  }
  return { messageId: response.data.msgId };
}
