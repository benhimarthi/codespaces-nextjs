import { createHash } from "node:crypto";

export function notificationId(eventType, orderId, status, recipientUid) {
  return createHash("sha256")
    .update([eventType, orderId, status ?? "", recipientUid].join(":"))
    .digest("hex");
}

export function privateDocumentId(value) {
  return createHash("sha256").update(value).digest("hex");
}
