import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import { roleFor } from "../../middleware/auth.js";
import { db } from "../../utils/firebase.js";
import { orderConfig } from "./config.js";
import { assertTransition, leavesPendingConfirmation, restoresStock } from "./stateMachine.js";
import { productVariantId } from "./variants.js";

function hash(value) {
  return createHash("sha256").update(value).digest();
}

function requestIdentifier(request) {
  const supplied = request.rawRequest?.get?.("x-request-id");
  return typeof supplied === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied)
    ? supplied
    : randomUUID();
}

function denyOwnership() {
  logger.warn("Order ownership check denied", {
    event: "order_ownership",
    outcome: "denied",
    code: "ORDER_NOT_FOUND",
  });
  throw new HttpsError("not-found", "Order not found.");
}

function pickupCodeMatches(expectedHash, pickupCode) {
  if (typeof expectedHash !== "string" || typeof pickupCode !== "string") return false;
  const expected = Buffer.from(expectedHash, "hex");
  const actual = hash(pickupCode);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function restoreProductStock(product, orderItems) {
  const updated = { ...product };
  let productStock = updated.stock;
  let variants = Array.isArray(updated.variants) ? [...updated.variants] : [];
  for (const item of orderItems) {
    if (item.variantId == null) {
      productStock += item.quantity;
      continue;
    }
    let index = variants.findIndex((variant) => productVariantId(variant) === item.variantId);
    if (index < 0 && item.variant) {
      variants.push({
        attributes: item.variant.attributes,
        ...(item.variant.sku ? { sku: item.variant.sku } : {}),
        price: item.variant.price,
        stock: item.quantity,
      });
      index = variants.length - 1;
    } else if (index >= 0) {
      variants[index] = { ...variants[index], stock: variants[index].stock + item.quantity };
    } else {
      throw new HttpsError("failed-precondition", "Order stock could not be restored.");
    }
  }
  const update = {};
  if (Number.isSafeInteger(productStock) && productStock !== product.stock) update.stock = productStock;
  if (variants.length && variants !== product.variants) update.variants = variants;
  return update;
}

export async function transitionOrder({
  request,
  caller,
  orderId,
  nextStatus,
  actor,
  reason = null,
  pickupCode,
  auditSource,
  messageId,
  requireSellerOwnership = false,
  requireBuyerOwnership = false,
}) {
  const orderRef = db.collection("orders").doc(orderId);
  try {
    return await db.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(orderRef);
    if (!orderSnapshot.exists) denyOwnership();
    const order = orderSnapshot.data();
    if (
      (requireSellerOwnership && order.sellerId !== caller.uid) ||
      (requireBuyerOwnership && order.buyerUid !== caller.uid)
    ) {
      denyOwnership();
    }
    if (requireSellerOwnership && order.sellerId !== caller.uid) denyOwnership();
    if (
      actor === "scheduler" &&
      ((nextStatus === "expired" && order.status !== "pending_confirmation") ||
        (nextStatus === "completed" && order.status !== "delivered"))
    ) {
      return false;
    }
    if (actor === "scheduler" && nextStatus === "expired") {
      const createdAt = order.createdAt?.toMillis?.();
      if (
        !Number.isInteger(createdAt) ||
        Date.now() - createdAt < orderConfig.unconfirmedExpiryHours * 3_600_000
      ) return false;
    }
    if (actor === "scheduler" && nextStatus === "completed") {
      const deliveredAt = order.deliveredAt?.toMillis?.();
      if (
        !Number.isInteger(deliveredAt) ||
        Date.now() - deliveredAt < orderConfig.autoCompleteDays * 86_400_000
      ) return false;
    }
    assertTransition(order, nextStatus, actor, reason);

    let secretRef;
    if (nextStatus === "delivered" && order.paymentMethod === "pickup") {
      secretRef = db.collection("orderSecrets").doc(orderId);
      const secret = await transaction.get(secretRef);
      if (!pickupCodeMatches(secret.get("pickupCodeHash"), pickupCode)) {
        logger.warn("Pickup code validation failed", {
          event: "order_pickup",
          outcome: "denied",
          code: "ORDER_PICKUP_CODE_INVALID",
        });
        const error = new HttpsError("failed-precondition", "Pickup code is invalid.");
        error.internalCode = "ORDER_PICKUP_CODE_INVALID";
        throw error;
      }
    }
    if (nextStatus === "delivered") {
      if (order.paymentMethod !== "pickup" && pickupCode !== undefined) {
        throw new HttpsError("invalid-argument", "Invalid request.");
      }
    }

    if (nextStatus === "failed_delivery" && order.status === "ready_for_pickup") {
      const readyAt = order.readyForPickupAt?.toMillis?.();
      const waitMs = orderConfig.pickupFailureDays * 86_400_000;
      if (!Number.isInteger(readyAt) || Date.now() - readyAt < waitMs) {
        throw new HttpsError("failed-precondition", "Order transition is not allowed.");
      }
    }

    const groupRef = db.collection("orderGroups").doc(order.orderGroupId);
    const groupPromise = transaction.get(groupRef);
    const statsRef = db.collection("_buyerOrderStats").doc(order.buyerUid);
    const statsPromise = leavesPendingConfirmation(order.status)
      ? transaction.get(statsRef)
      : Promise.resolve(null);
    const restore = restoresStock(nextStatus);
    const productRefs = restore
      ? [...new Set(order.items.map((item) => item.productId))]
        .map((productId) => db.collection("products").doc(productId))
      : [];
    const productSnapshotsPromise = Promise.all(productRefs.map((reference) => transaction.get(reference)));
    const reliabilityRef = db.collection("_buyerReliability").doc(order.buyerUid);
    const reliabilityUpdate = nextStatus === "failed_delivery" ||
      (nextStatus === "cancelled" && order.status === "confirmed" && actor === "buyer");
    const [groupSnapshot, statsSnapshot, productSnapshots] = await Promise.all([
      groupPromise,
      statsPromise,
      productSnapshotsPromise,
    ]);
    if (!groupSnapshot.exists) throw new HttpsError("internal", "Unable to complete the request.");
    if (restore && productSnapshots.some((product) => !product.exists)) {
      throw new HttpsError("failed-precondition", "Order stock could not be restored.");
    }

    const now = FieldValue.serverTimestamp();
    const update = {
      status: nextStatus,
      updatedAt: now,
      statusReason: reason,
      lastTransition: {
        actorUid: caller.uid,
        actorRole: actor === "scheduler" ? "system" : roleFor(caller),
        action: nextStatus,
        timestamp: now,
        reason,
      },
    };
    if (nextStatus === "confirmed") update.confirmedAt = now;
    if (nextStatus === "ready_for_pickup") update.readyForPickupAt = now;
    if (nextStatus === "delivered") {
      update.deliveredAt = now;
      update.paymentStatus = "collected";
      update["payment.status"] = "collected";
      update["payment.collectedAt"] = now;
    }

    if (restore) {
      const productsById = new Map(productSnapshots.map((product) => [product.id, product]));
      const changesById = new Map();
      for (const item of order.items) {
        const productSnapshot = productsById.get(item.productId);
        const product = changesById.get(item.productId) ?? productSnapshot.data();
        changesById.set(item.productId, product);
      }
      const updates = new Map();
      for (const [productId, product] of changesById) {
        const restoreItems = order.items.filter((item) => item.productId === productId);
        updates.set(productId, restoreProductStock(product, restoreItems));
      }
      for (const [productId, productUpdate] of updates) {
        transaction.update(productsById.get(productId).ref, {
          ...productUpdate,
          updatedAt: now,
        });
      }
    }

    if (leavesPendingConfirmation(order.status)) {
      const pendingCount = Math.max(0, groupSnapshot.get("pendingSubOrderCount") - 1);
      transaction.update(groupRef, { pendingSubOrderCount: pendingCount, updatedAt: now });
      if (pendingCount === 0) {
        transaction.set(statsRef, {
          pendingGroups: Math.max(0, (statsSnapshot?.get("pendingGroups") ?? 0) - 1),
          updatedAt: now,
        }, { merge: true });
      }
    }
    if (reliabilityUpdate) {
      const field = nextStatus === "failed_delivery" ? "failedDelivery" : "cancelledAfterConfirmation";
      transaction.set(reliabilityRef, {
        [field]: FieldValue.increment(1),
        updatedAt: now,
      }, { merge: true });
    }

    const auditRef = db.collection("auditLogs").doc();
    transaction.update(orderRef, update);
    if (secretRef) transaction.delete(secretRef);
    transaction.create(auditRef, {
      actorUid: caller.uid,
      actorRole: actor === "scheduler" ? "system" : roleFor(caller),
      action: `order_${nextStatus}`,
      orderId,
      beforeStatus: order.status,
      afterStatus: nextStatus,
      reason,
      timestamp: now,
      requestId: requestIdentifier(request),
      ip: request.rawRequest?.ip ?? null,
      ...(auditSource ? { source: auditSource } : {}),
      ...(messageId ? { messageId } : {}),
    });
    return true;
    });
  } catch (error) {
    if (error?.internalCode === "ORDER_PICKUP_CODE_INVALID") {
      await db.collection("auditLogs").doc().create({
        actorUid: caller.uid,
        actorRole: roleFor(caller),
        action: "fraud_block:pickupCode",
        orderId,
        beforeStatus: "ready_for_pickup",
        afterStatus: null,
        reason: "ORDER_PICKUP_CODE_INVALID",
        timestamp: FieldValue.serverTimestamp(),
        requestId: requestIdentifier(request),
        ip: request.rawRequest?.ip ?? null,
      });
    }
    throw error;
  }
}

export async function cancelOrderOperation(request, input, state, actor = "buyer") {
  return transitionOrder({
    request,
    caller: state.caller,
    orderId: input.orderId,
    nextStatus: "cancelled",
    actor,
    reason: input.reason ?? null,
    requireBuyerOwnership: actor === "buyer",
    requireSellerOwnership: actor === "seller",
  });
}

export async function expireOrder(request, orderId) {
  const scheduler = { uid: "order-scheduler", token: { role: "admin" } };
  return transitionOrder({
    request,
    caller: scheduler,
    orderId,
    nextStatus: "expired",
    actor: "scheduler",
    reason: "Unconfirmed order expired.",
  });
}

export async function completeOrder(request, orderId) {
  const scheduler = { uid: "order-scheduler", token: { role: "admin" } };
  return transitionOrder({
    request,
    caller: scheduler,
    orderId,
    nextStatus: "completed",
    actor: "scheduler",
    reason: "Order completion period elapsed.",
  });
}
