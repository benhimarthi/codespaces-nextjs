import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import { roleFor } from "../../middleware/auth.js";
import { db, auth } from "../../utils/firebase.js";
import { orderConfig, configuredCurrencyAmount } from "./config.js";
import { accountAgeDays, normalizeMoroccanPhone, requireVerifiedPhone, writeFraudBlock } from "./operation.js";
import { toOrderDto } from "./mappers.js";
import { productVariantId } from "./variants.js";

function requestIdentifier(request, supplied) {
  const header = request.rawRequest?.get?.("x-request-id");
  return typeof header === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(header)
    ? header
    : supplied;
}

function payloadHash(input) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function aggregateItems(items) {
  const result = new Map();
  for (const item of items) {
    const variantId = item.variantId ?? null;
    const key = `${item.productId}:${variantId ?? ""}`;
    const previous = result.get(key);
    const quantity = (previous?.quantity ?? 0) + item.quantity;
    if (quantity > orderConfig.maxQuantity) {
      throw new HttpsError("invalid-argument", "Invalid request.");
    }
    result.set(key, { productId: item.productId, variantId, quantity });
  }
  return [...result.values()];
}

function orderNumberCandidate() {
  const date = new Date().toISOString().slice(2, 10).replaceAll("-", "");
  return `ORD-${date}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function pickupCode() {
  return String(randomInt(0, 100_000_000)).padStart(8, "0");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function disabledProfile(profile) {
  return !profile.exists ||
    profile.get("disabled") === true ||
    profile.get("deleted") === true ||
    profile.get("status") === "disabled" ||
    profile.get("status") === "deleted";
}

function orderError(code, status = "resource-exhausted") {
  const error = new HttpsError(status, "Order cannot be completed.");
  error.internalCode = code;
  return error;
}

async function transactionCreateOrder(request, input, state) {
  const uid = state.caller.uid;
  const orderGroupId = randomUUID();
  const groupRef = db.collection("orderGroups").doc(orderGroupId);
  const receiptRef = db.collection("_orderRequests").doc(sha256(`${uid}:${input.requestId}`));
  const cartItemsRef = db.collection("carts").doc(uid).collection("items");
  const dailyKey = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const statsRef = db.collection("_buyerOrderStats").doc(uid);
  const dailyRef = db.collection("_buyerDailyOrderCounts").doc(`${uid}_${dailyKey}`);
  const reliabilityRef = db.collection("_buyerReliability").doc(uid);
  const initialItems = input.items ? aggregateItems(input.items) : null;
  const bodyHash = payloadHash(input);
  let replayGroupId;
  let codesForResponse = [];

  await db.runTransaction(async (transaction) => {
    const receipt = await transaction.get(receiptRef);
    if (receipt.exists) {
      if (receipt.get("payloadHash") !== bodyHash) {
        throw new HttpsError("already-exists", "Request identifier already used.");
      }
      replayGroupId = receipt.get("orderGroupId");
      return;
    }

    const cartSnapshot = await transaction.get(cartItemsRef);
    const items = initialItems ?? aggregateItems(cartSnapshot.docs.map((doc) => doc.data()));
    if (items.length === 0 || items.length > orderConfig.maxCartItems) {
      throw new HttpsError("failed-precondition", "Cart is empty or unavailable.");
    }

    const productRefs = items.map((item) => db.collection("products").doc(item.productId));
    const productSnapshots = await Promise.all(productRefs.map((reference) => transaction.get(reference)));
    const productById = new Map(productSnapshots.map((snapshot) => [snapshot.id, snapshot]));
    const sellerIds = [...new Set(productSnapshots.filter((snapshot) => snapshot.exists)
      .map((snapshot) => snapshot.get("sellerId")))];
    const sellerProfiles = new Map(await Promise.all(sellerIds.map(async (sellerId) => [
      sellerId,
      await transaction.get(db.collection("users").doc(sellerId)),
    ])));
    const pickupLocationByProduct = new Map(
      (input.pickupLocations ?? []).map((entry) => [entry.productId, entry.pickupLocationId]),
    );
    const selectedProductIds = new Set(items.map((item) => item.productId));
    if ([...pickupLocationByProduct.keys()].some((productId) => !selectedProductIds.has(productId))) {
      throw new HttpsError("invalid-argument", "Invalid request.");
    }
    const locationRefs = new Map();
    if (input.paymentMethod === "pickup") {
      for (const item of items) {
        const product = productById.get(item.productId);
        if (!product?.exists || typeof product.get("sellerId") !== "string") continue;
        const locationId = pickupLocationByProduct.get(item.productId) ?? input.pickupLocationId;
        if (!locationId) throw new HttpsError("invalid-argument", "Invalid request.");
        const key = `${product.get("sellerId")}:${locationId}`;
        if (!locationRefs.has(key)) {
          locationRefs.set(key, db.collection("users").doc(product.get("sellerId"))
            .collection("pickupLocations").doc(locationId));
        }
      }
    }
    const locations = new Map(await Promise.all([...locationRefs].map(async ([key, reference]) => [
      key,
      await transaction.get(reference),
    ])));
    const [statsSnapshot, dailySnapshot, reliabilitySnapshot] = await Promise.all([
      transaction.get(statsRef),
      transaction.get(dailyRef),
      transaction.get(reliabilityRef),
    ]);

    const plans = [];
    const stockByProduct = new Map();
    for (const item of items) {
      const productSnapshot = productById.get(item.productId);
      if (!productSnapshot?.exists) {
        throw new HttpsError("failed-precondition", "Product is unavailable.");
      }
      const product = productSnapshot.data();
      const sellerId = product.sellerId;
      const sellerProfile = sellerProfiles.get(sellerId);
      if (
        product.status !== "active" ||
        product.archived === true ||
        sellerId === uid ||
        disabledProfile(sellerProfile)
      ) {
        const ownProduct = sellerId === uid;
        logger.warn("Order product eligibility rejected", {
          event: "order_product",
          outcome: "denied",
          code: ownProduct ? "ORDER_OWN_PRODUCT" : "ORDER_PRODUCT_UNAVAILABLE",
        });
        const error = new HttpsError("failed-precondition", "Product is unavailable.");
        if (ownProduct) error.internalCode = "ORDER_OWN_PRODUCT";
        throw error;
      }
      const variant = item.variantId == null
        ? null
        : (product.variants ?? []).find((candidate) => productVariantId(candidate) === item.variantId);
      if (item.variantId != null && !variant) {
        throw new HttpsError("failed-precondition", "Product variant is unavailable.");
      }
      const stock = variant?.stock ?? product.stock;
      if (!Number.isSafeInteger(stock) || stock < item.quantity) {
        logger.warn("Order stock conflict", {
          event: "order_stock",
          outcome: "denied",
          code: "ORDER_STOCK_CONFLICT",
        });
        throw new HttpsError("failed-precondition", "Requested quantity is unavailable.");
      }
      const unitPrice = variant?.price ?? product.price;
      if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) {
        throw new HttpsError("failed-precondition", "Product is unavailable.");
      }
      const currency = product.currency;
      const groupKey = `${sellerId}:${currency}`;
      const locationId = input.paymentMethod === "pickup"
        ? pickupLocationByProduct.get(item.productId) ?? input.pickupLocationId
        : null;
      const locationKey = locationId === null ? null : `${sellerId}:${locationId}`;
      const location = locationKey ? locations.get(locationKey) : null;
      const locationData = location?.data();
      if (
        input.paymentMethod === "pickup" &&
        (!location?.exists ||
          location.get("active") !== true ||
          typeof locationData?.name !== "string" ||
          locationData.name.trim().length === 0 ||
          locationData.name.length > 100 ||
          !locationData.address ||
          typeof locationData.address !== "object" ||
          Array.isArray(locationData.address))
      ) {
        throw new HttpsError("failed-precondition", "Pickup location is unavailable.");
      }
      let plan = plans.find((candidate) => candidate.key === groupKey);
      if (!plan) {
        plan = {
          key: groupKey,
          sellerId,
          currency,
          subtotal: 0,
          items: [],
          pickupLocation: locationData
            ? { id: locationId, name: locationData.name.trim(), address: locationData.address }
            : null,
        };
        plans.push(plan);
      }
      if (
        input.paymentMethod === "pickup" &&
        plan.pickupLocation.id !== locationId
      ) {
        throw new HttpsError("invalid-argument", "Invalid request.");
      }
      const lineTotal = unitPrice * item.quantity;
      if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(plan.subtotal + lineTotal)) {
        throw new HttpsError("failed-precondition", "Order total is unavailable.");
      }
      plan.subtotal += lineTotal;
      const variantSnapshot = variant
        ? { attributes: variant.attributes ?? {}, sku: variant.sku ?? null, price: variant.price }
        : null;
      plan.items.push({
        productId: productSnapshot.id,
        name: product.name,
        variantId: item.variantId,
        variant: variantSnapshot,
        quantity: item.quantity,
        unitPrice,
        currency,
        imagePath: product.images?.[0] ?? null,
        sellerId,
      });
      const stockPlan = stockByProduct.get(productSnapshot.id) ?? {
        reference: productSnapshot.ref,
        product,
        deltas: new Map(),
      };
      stockPlan.deltas.set(item.variantId ?? "", (stockPlan.deltas.get(item.variantId ?? "") ?? 0) + item.quantity);
      stockByProduct.set(productSnapshot.id, stockPlan);
    }

    const authSellers = await Promise.all(sellerIds.map(async (sellerId) => [
      sellerId,
      await auth.getUser(sellerId),
    ]));
    if (authSellers.some(([, seller]) => seller.disabled)) {
      throw new HttpsError("failed-precondition", "Product is unavailable.");
    }
    const totalsByCurrency = {};
    for (const plan of plans) {
      plan.shippingFee = input.paymentMethod === "cod"
        ? configuredCurrencyAmount(orderConfig.shippingFees, plan.currency)
        : 0;
      plan.total = plan.subtotal + plan.shippingFee;
      if (!Number.isSafeInteger(plan.total)) {
        throw new HttpsError("failed-precondition", "Order total is unavailable.");
      }
      totalsByCurrency[plan.currency] = (totalsByCurrency[plan.currency] ?? 0) + plan.total;
    }

    if ((dailySnapshot.get("count") ?? 0) >= orderConfig.dailyOrdersLimit) {
      throw orderError("ORDER_DAILY_LIMIT");
    }
    if ((statsSnapshot.get("pendingGroups") ?? 0) >= orderConfig.pendingOrdersLimit) {
      throw orderError("ORDER_PENDING_LIMIT");
    }
    const reliability = reliabilitySnapshot.data() ?? {};
    const strikes = (reliability.failedDelivery ?? 0) + (reliability.cancelledAfterConfirmation ?? 0);
    if (input.paymentMethod === "cod" && strikes >= orderConfig.reliabilityStrikeLimit) {
      throw orderError("ORDER_COD_RELIABILITY_BLOCK", "failed-precondition");
    }
    if (accountAgeDays(state.account, state.profile) < orderConfig.newAccountAgeDays) {
      for (const [currency, total] of Object.entries(totalsByCurrency)) {
        const cap = configuredCurrencyAmount(orderConfig.newAccountTotalLimits, currency);
        if (total > cap) throw orderError("ORDER_NEW_ACCOUNT_TOTAL_LIMIT");
      }
    }

    const suborders = plans.map((plan) => ({
      id: randomUUID(),
      orderNumber: orderNumberCandidate(),
      pickupCode: input.paymentMethod === "pickup" ? pickupCode() : null,
      plan,
    }));
    codesForResponse = suborders
      .filter((order) => order.pickupCode)
      .map((order) => ({ orderId: order.id, pickupCode: order.pickupCode }));
    const numberRefs = suborders.map((order) => db.collection("_orderNumbers").doc(order.orderNumber));
    const numberSnapshots = await Promise.all(numberRefs.map((reference) => transaction.get(reference)));
    if (numberSnapshots.some((snapshot) => snapshot.exists)) {
      throw new HttpsError("aborted", "Unable to allocate order number.");
    }

    const buyerProfileName = state.profile.get("displayName");
    const buyerName = input.deliveryAddress?.fullName ??
      buyerProfileName ??
      state.account.displayName ??
      "Customer";
    const phoneNumber = normalizeMoroccanPhone(input.phoneNumber);
    const requestId = requestIdentifier(request, input.requestId);
    const now = FieldValue.serverTimestamp();
    const groupTotal = totalsByCurrency;
    const selectedCartIds = new Set(items.map((item) =>
      `${item.productId}:${item.variantId ?? ""}`));

    transaction.create(groupRef, {
      buyerUid: uid,
      subOrderIds: suborders.map((order) => order.id),
      pendingSubOrderCount: suborders.length,
      totalsByCurrency: groupTotal,
      createdAt: now,
      updatedAt: now,
      requestId,
    });
    transaction.create(receiptRef, {
      payloadHash: bodyHash,
      orderGroupId,
      createdAt: now,
    });
    transaction.set(statsRef, {
      pendingGroups: (statsSnapshot.get("pendingGroups") ?? 0) + 1,
      updatedAt: now,
    }, { merge: true });
    transaction.set(dailyRef, {
      count: (dailySnapshot.get("count") ?? 0) + 1,
      expiresAt: Timestamp.fromMillis(Date.now() + 45 * 86_400_000),
      updatedAt: now,
    }, { merge: true });

    for (const stockPlan of stockByProduct.values()) {
      if (stockPlan.product.variants?.length) {
        const variants = stockPlan.product.variants.map((variant) => {
          const id = productVariantId(variant);
          const delta = stockPlan.deltas.get(id) ?? 0;
          return delta
            ? { ...variant, stock: variant.stock - delta }
            : variant;
        });
        transaction.update(stockPlan.reference, { variants, updatedAt: now });
      } else {
        const delta = stockPlan.deltas.get("") ?? 0;
        transaction.update(stockPlan.reference, {
          stock: stockPlan.product.stock - delta,
          updatedAt: now,
        });
      }
    }

    for (const [index, order] of suborders.entries()) {
      const orderRef = db.collection("orders").doc(order.id);
      const auditRef = db.collection("auditLogs").doc();
      const plan = order.plan;
      transaction.create(numberRefs[index], {
        orderGroupId,
        subOrderId: order.id,
        createdAt: now,
      });
      transaction.create(orderRef, {
        orderGroupId,
        sellerId: plan.sellerId,
        buyerUid: uid,
        orderNumber: order.orderNumber,
        status: "pending_confirmation",
        paymentMethod: input.paymentMethod,
        paymentStatus: "unpaid",
        payment: {
          method: input.paymentMethod,
          status: "unpaid",
          provider: null,
          providerReference: null,
          collectedAt: null,
        },
        currency: plan.currency,
        subtotal: plan.subtotal,
        shippingFee: plan.shippingFee,
        total: plan.total,
        items: plan.items,
        ...(plan.pickupLocation ? {
          pickupLocation: {
            id: plan.pickupLocation.id,
            name: plan.pickupLocation.name,
            address: plan.pickupLocation.address,
          },
        } : {}),
        ...(input.note ? { note: input.note } : {}),
        createdAt: now,
        updatedAt: now,
        requestId,
        statusReason: null,
      });
      transaction.create(db.collection("orderPrivate").doc(order.id), {
        buyerUid: uid,
        sellerId: plan.sellerId,
        buyer: {
          displayName: buyerName,
          phoneNumber,
        },
        ...(input.deliveryAddress ? { deliveryAddress: input.deliveryAddress } : {}),
        createdAt: now,
      });
      if (order.pickupCode) {
        transaction.create(db.collection("orderSecrets").doc(order.id), {
          pickupCodeHash: sha256(order.pickupCode),
          createdAt: now,
        });
      }
      transaction.create(auditRef, {
        actorUid: uid,
        actorRole: roleFor(state.caller),
        action: "order_created",
        orderId: order.id,
        beforeStatus: null,
        afterStatus: "pending_confirmation",
        reason: null,
        timestamp: now,
        requestId,
        ip: request.rawRequest?.ip ?? null,
      });
    }

    for (const cartDoc of cartSnapshot.docs) {
      const line = cartDoc.data();
      if (selectedCartIds.has(`${line.productId}:${line.variantId ?? ""}`)) {
        transaction.delete(cartDoc.ref);
      }
    }
  });

  return {
    orderGroupId: replayGroupId ?? orderGroupId,
    replay: replayGroupId !== undefined,
    pickupCodes: replayGroupId === undefined ? codesForResponse : [],
  };
}

export async function createOrderOperation(request, input, state) {
  await requireVerifiedPhone(state.account, input.phoneNumber, request, state.caller);
  const phoneNumber = normalizeMoroccanPhone(input.phoneNumber);
  if (input.paymentMethod === "cod" && !input.deliveryAddress) {
    throw new HttpsError("invalid-argument", "Invalid request.");
  }
  if (!/^\+212[5-7]\d{8}$/.test(phoneNumber)) {
    throw new HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    const result = await transactionCreateOrder(request, input, state);
    const groupRef = db.collection("orderGroups").doc(result.orderGroupId);
    const group = await groupRef.get();
    if (!group.exists) throw new HttpsError("internal", "Unable to complete the request.");
    const suborderSnapshots = await db.getAll(
      ...group.get("subOrderIds").map((id) => db.collection("orders").doc(id)),
    );
    const subOrders = suborderSnapshots.map((snapshot) => toOrderDto(snapshot, { buyerView: true }));
    logger.info("Order created", {
      event: "order_create",
      outcome: "success",
      orderCount: subOrders.length,
    });
    return {
      orderGroupId: result.orderGroupId,
      orders: subOrders,
      pickupCodes: result.pickupCodes,
    };
  } catch (error) {
    const code = typeof error?.internalCode === "string" ? error.internalCode : "";
    if (code.startsWith("ORDER_")) {
      await writeFraudBlock(request, state.caller, "createOrder", code);
    }
    throw error;
  }
}
