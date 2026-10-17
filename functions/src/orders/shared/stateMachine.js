import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";

export const orderStatuses = Object.freeze([
  "pending_confirmation",
  "confirmed",
  "processing",
  "out_for_delivery",
  "ready_for_pickup",
  "delivered",
  "completed",
  "rejected",
  "cancelled",
  "expired",
  "failed_delivery",
  "returned",
]);

const transitions = Object.freeze({
  pending_confirmation: {
    confirmed: ["seller"],
    rejected: ["seller"],
    cancelled: ["buyer"],
    expired: ["scheduler"],
  },
  confirmed: {
    processing: ["seller"],
    cancelled: ["buyer", "seller"],
  },
  processing: {
    out_for_delivery: ["seller"],
    ready_for_pickup: ["seller"],
  },
  out_for_delivery: {
    delivered: ["seller"],
    failed_delivery: ["seller"],
  },
  ready_for_pickup: {
    delivered: ["seller"],
    failed_delivery: ["seller"],
  },
  delivered: {
    completed: ["scheduler"],
    returned: ["admin"],
  },
  completed: {},
  rejected: {},
  cancelled: {},
  expired: {},
  failed_delivery: {},
  returned: {},
});

const adminCancellable = new Set([
  "pending_confirmation",
  "confirmed",
  "processing",
  "out_for_delivery",
  "ready_for_pickup",
]);

export function assertTransition(order, nextStatus, actor, reason) {
  const allowedActors = actor === "admin" && nextStatus === "cancelled" &&
    adminCancellable.has(order.status)
    ? ["admin"]
    : transitions[order.status]?.[nextStatus];
  let valid = allowedActors?.includes(actor) === true;
  if (valid && order.status === "confirmed" && nextStatus === "cancelled" && actor === "buyer") {
    valid = order.paymentMethod === "cod" || order.paymentMethod === "pickup";
  }
  if (valid && order.status === "processing") {
    valid = order.paymentMethod === "cod"
      ? nextStatus === "out_for_delivery"
      : nextStatus === "ready_for_pickup";
  }
  if (valid && order.status === "out_for_delivery") {
    valid = order.paymentMethod === "cod";
  }
  if (valid && order.status === "ready_for_pickup") {
    valid = order.paymentMethod === "pickup";
  }
  if (valid && order.status === "confirmed" && nextStatus === "cancelled" && actor === "seller") {
    valid = typeof reason === "string" && reason.trim().length >= 10;
  }
  if (valid && nextStatus === "rejected") {
    valid = typeof reason === "string" && reason.trim().length >= 10;
  }
  if (valid && nextStatus === "failed_delivery") {
    valid = typeof reason === "string" && reason.trim().length >= 10;
  }
  if (!valid) {
    logger.warn("Invalid order transition", {
      event: "order_transition",
      outcome: "denied",
      code: "ORDER_INVALID_TRANSITION",
      fromStatus: order.status,
      toStatus: nextStatus,
      actor,
    });
    throw new HttpsError("failed-precondition", "Order transition is not allowed.");
  }
}

export function restoresStock(nextStatus) {
  return ["rejected", "cancelled", "expired", "failed_delivery"].includes(nextStatus);
}

export function leavesPendingConfirmation(status) {
  return status === "pending_confirmation";
}

export function showsBuyerContact(status) {
  return [
    "confirmed",
    "processing",
    "out_for_delivery",
    "ready_for_pickup",
    "delivered",
    "completed",
    "failed_delivery",
    "returned",
  ].includes(status);
}
