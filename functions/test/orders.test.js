import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { firestoreDatabaseId } from "../src/utils/firestoreDatabase.js";
import { completeOrder, expireOrder } from "../src/orders/shared/transitions.js";

const projectId = process.env.GCLOUD_PROJECT || "demo-auth-service";
const authEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const app = getApps().length ? getApps()[0] : initializeApp({ projectId });
const adminAuth = getAuth(app);
const adminDb = getFirestore(app, firestoreDatabaseId);
const callableNames = [
  "addToCart",
  "updateCartItem",
  "removeFromCart",
  "getMyCart",
  "clearCart",
  "createOrder",
  "cancelMyOrder",
  "getMyOrders",
  "getOrderById",
  "getSellerOrders",
  "confirmOrder",
  "markProcessing",
  "rejectOrder",
  "markOutForDelivery",
  "markReadyForPickup",
  "markDelivered",
  "markFailedDelivery",
  "cancelSellerOrder",
  "listOrders",
  "forceCancelOrder",
  "resolveDispute",
];
const endpointByOperation = {
  addToCart: "/cartService/cart/add",
  updateCartItem: "/cartService/cart/update",
  removeFromCart: "/cartService/cart/remove",
  getMyCart: "/cartService/cart/get",
  clearCart: "/cartService/cart/clear",
  createOrder: "/ordersService/orders/create",
  cancelMyOrder: "/ordersService/orders/cancel",
  getMyOrders: "/ordersService/orders/mine",
  getOrderById: "/ordersService/orders/get",
  getSellerOrders: "/ordersService/seller/orders/list",
  confirmOrder: "/ordersService/seller/orders/confirm",
  markProcessing: "/ordersService/seller/orders/processing",
  rejectOrder: "/ordersService/seller/orders/reject",
  markOutForDelivery: "/ordersService/seller/orders/out-for-delivery",
  markReadyForPickup: "/ordersService/seller/orders/ready-for-pickup",
  markDelivered: "/ordersService/seller/orders/delivered",
  markFailedDelivery: "/ordersService/seller/orders/failed-delivery",
  cancelSellerOrder: "/ordersService/seller/orders/cancel",
  listOrders: "/ordersService/admin/orders/list",
  forceCancelOrder: "/ordersService/admin/orders/force-cancel",
  resolveDispute: "/ordersService/admin/orders/resolve-dispute",
};
let accountNumber = 0;

async function createAccount({ role = "user", emailVerified = true, mfa = false } = {}) {
  accountNumber += 1;
  const user = await adminAuth.createUser({
    email: `orders-${accountNumber}-${randomUUID()}@example.test`,
    emailVerified,
  });
  await adminDb.collection("users").doc(user.uid).set({
    displayName: `Orders Test ${accountNumber}`,
    role,
    disabled: false,
    deleted: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  if (role !== "user" || mfa) {
    await adminAuth.setCustomUserClaims(user.uid, {
      role,
      ...(mfa ? { sign_in_second_factor: "phone" } : {}),
    });
  }
  const customToken = await adminAuth.createCustomToken(user.uid);
  const response = await fetch(
    `http://${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  assert.equal(response.ok, true, "Auth emulator sign-in should succeed");
  return { uid: user.uid, token: (await response.json()).idToken };
}

async function invoke(name, data = {}, token) {
  const response = await fetch(
    `http://${functionsHost}/${projectId}/us-central1${endpointByOperation[name]}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
    },
  );
  const body = await response.json();
  return {
    status: response.status,
    body: body.error ? body : { result: body },
  };
}

async function createProduct(seller, { stock = 5, price = 1250, currency = "MAD" } = {}) {
  const productId = randomUUID();
  await adminDb.collection("products").doc(productId).set({
    sellerId: seller.uid,
    name: `Product ${productId.slice(0, 8)}`,
    description: "Emulator order test product.",
    price,
    currency,
    images: [`products/${seller.uid}/test.png`],
    stock,
    status: "active",
    variants: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return productId;
}

function codOrder(productId, overrides = {}) {
  return {
    requestId: randomUUID(),
    paymentMethod: "cod",
    items: [{ productId, quantity: 1 }],
    phoneNumber: "+212612345678",
    deliveryAddress: {
      fullName: "Buyer Example",
      street: "1 Test Street",
      city: "Rabat",
      region: "Rabat-Sale-Kenitra",
      postalCode: "10000",
      countryCode: "MA",
    },
    ...overrides,
  };
}

async function setupPickup(seller) {
  const pickupLocationId = randomUUID();
  await adminDb.collection("users").doc(seller.uid)
    .collection("pickupLocations").doc(pickupLocationId).set({
      active: true,
      name: "Seller Shop",
      address: { city: "Rabat", street: "2 Shop Street" },
    });
  return pickupLocationId;
}

async function firestoreRequest(path, token, options = {}) {
  return fetch(
    `http://${firestoreHost}/v1/projects/${projectId}/databases/${firestoreDatabaseId}/documents${path}`,
    {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    },
  );
}

test("every cart and order callable rejects unauthenticated calls", async () => {
  for (const name of callableNames) {
    const response = await invoke(name);
    assert.equal(response.status, 401, `${name}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.status, "UNAUTHENTICATED");
  }
});

test("cart persists only line identity and quantity and reflects current price and stock", async () => {
  const buyer = await createAccount();
  const seller = await createAccount();
  const productId = await createProduct(seller, { stock: 4 });

  const added = await invoke("addToCart", { productId, quantity: 2 }, buyer.token);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.result.item.quantity, 2);
  const cartRef = adminDb.collection("carts").doc(buyer.uid).collection("items");
  const line = (await cartRef.get()).docs[0];
  assert.deepEqual(Object.keys(line.data()).sort(), ["productId", "quantity", "variantId"]);
  assert.equal(line.get("variantId"), null);

  await adminDb.collection("products").doc(productId).update({ price: 1750, stock: 1 });
  const cart = await invoke("getMyCart", {
    knownPrices: [{ productId, variantId: null, price: 1250, currency: "MAD" }],
  }, buyer.token);
  assert.equal(cart.body.result.items[0].priceChanged, true);
  assert.equal(cart.body.result.items[0].available, false);
  assert.equal(cart.body.result.items[0].unitPrice, 1750);

  const overshoot = await invoke("updateCartItem", { productId, quantity: 2 }, buyer.token);
  assert.equal(overshoot.body.error.status, "FAILED_PRECONDITION");
  assert.equal((await invoke("updateCartItem", { productId, quantity: 1 }, buyer.token)).status, 200);
  assert.equal((await invoke("removeFromCart", { productId }, buyer.token)).status, 200);
  await invoke("addToCart", { productId, quantity: 1 }, buyer.token);
  assert.equal((await invoke("clearCart", {}, buyer.token)).body.result.cleared, 1);
});

test("own products cannot be added or ordered", async () => {
  const buyer = await createAccount();
  const ownProduct = await createProduct(buyer);
  const cartAttempt = await invoke("addToCart", { productId: ownProduct, quantity: 1 }, buyer.token);
  assert.equal(cartAttempt.body.error.status, "FAILED_PRECONDITION");
  const orderAttempt = await invoke("createOrder", codOrder(ownProduct), buyer.token);
  assert.equal(orderAttempt.body.error.status, "FAILED_PRECONDITION");
  assert.equal((await adminDb.collection("orders").where("buyerUid", "==", buyer.uid).get()).size, 0);
  assert.equal(
    (await adminDb.collection("auditLogs").where("actorUid", "==", buyer.uid)
      .where("action", "==", "fraud_block:createOrder").get()).size,
    1,
  );
});

test("createOrder recomputes totals, decrements stock, snapshots data, and retries idempotently", async () => {
  const buyer = await createAccount();
  const seller = await createAccount();
  const productId = await createProduct(seller, { stock: 4, price: 1250 });
  const input = codOrder(productId, {
    items: [{ productId, quantity: 2, price: 1, total: 1 }],
    price: 1,
    total: 1,
    fee: 0,
    buyerId: "forged-buyer",
    status: "delivered",
  });
  const rejectedForged = await invoke("createOrder", input, buyer.token);
  assert.equal(rejectedForged.status, 400);

  const clean = codOrder(productId, { requestId: input.requestId });
  clean.items[0].quantity = 2;
  const first = await invoke("createOrder", clean, buyer.token);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const order = first.body.result.orders[0];
  assert.equal(order.status, "pending_confirmation");
  assert.equal(order.paymentStatus, "unpaid");
  assert.equal(order.subtotal, 2500);
  assert.equal(order.shippingFee, 3000);
  assert.equal(order.total, 5500);
  assert.match(order.orderNumber, /^ORD-/);
  assert.equal((await adminDb.collection("products").doc(productId).get()).get("stock"), 2);
  await adminDb.collection("products").doc(productId).update({
    name: "Edited after purchase",
    price: 999999,
  });
  assert.equal(order.items[0].name.startsWith("Product "), true);
  assert.equal(order.items[0].unitPrice, 1250);

  const retry = await invoke("createOrder", clean, buyer.token);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.result.orderGroupId, first.body.result.orderGroupId);
  assert.equal(retry.body.result.orders[0].id, order.id);
  assert.equal((await adminDb.collection("orders").where("buyerUid", "==", buyer.uid).get()).size, 1);
});

test("multi-seller cart checkout splits into seller sub-orders", async () => {
  const buyer = await createAccount();
  const sellerA = await createAccount();
  const sellerB = await createAccount();
  const productA = await createProduct(sellerA, { price: 1000 });
  const productB = await createProduct(sellerB, { price: 2000 });
  const result = await invoke("createOrder", codOrder(productA, {
    items: [
      { productId: productA, quantity: 1 },
      { productId: productB, quantity: 1 },
    ],
  }), buyer.token);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.orders.length, 2);
  assert.deepEqual(
    new Set(result.body.result.orders.map((order) => order.items[0].sellerId)),
    new Set([sellerA.uid, sellerB.uid]),
  );
  assert.equal(result.body.result.orders.every((order) => order.orderGroupId === result.body.result.orderGroupId), true);

  const pickupLocationA = await setupPickup(sellerA);
  const pickupLocationB = await setupPickup(sellerB);
  const pickupResult = await invoke("createOrder", {
    requestId: randomUUID(),
    paymentMethod: "pickup",
    items: [
      { productId: productA, quantity: 1 },
      { productId: productB, quantity: 1 },
    ],
    pickupLocations: [
      { productId: productA, pickupLocationId: pickupLocationA },
      { productId: productB, pickupLocationId: pickupLocationB },
    ],
    phoneNumber: "+212612345678",
  }, buyer.token);
  assert.equal(pickupResult.status, 200, JSON.stringify(pickupResult.body));
  assert.equal(pickupResult.body.result.orders.length, 2);
  assert.deepEqual(
    new Set(pickupResult.body.result.orders.map((order) => order.pickupLocation.id)),
    new Set([pickupLocationA, pickupLocationB]),
  );
});

test("buyers and sellers cannot access another party's sub-order", async () => {
  const buyer = await createAccount();
  const otherBuyer = await createAccount();
  const seller = await createAccount();
  const otherSeller = await createAccount();
  const productId = await createProduct(seller);
  const created = await invoke("createOrder", codOrder(productId), buyer.token);
  const orderId = created.body.result.orders[0].id;

  const otherBuyerRead = await invoke("getOrderById", { orderId }, otherBuyer.token);
  assert.equal(otherBuyerRead.status, 404);
  const otherSellerConfirm = await invoke("confirmOrder", { orderId }, otherSeller.token);
  assert.equal(otherSellerConfirm.status, 404);

  const pendingSellerRead = await invoke("getSellerOrders", {}, seller.token);
  assert.equal("buyer" in pendingSellerRead.body.result.orders[0], false);
  assert.equal("deliveryAddress" in pendingSellerRead.body.result.orders[0], false);
  const directPrivatePending = await firestoreRequest(`/orderPrivate/${orderId}`, seller.token);
  assert.equal(directPrivatePending.status, 403);
  await invoke("confirmOrder", { orderId }, seller.token);
  const confirmedSellerRead = await invoke("getSellerOrders", {}, seller.token);
  assert.equal(confirmedSellerRead.body.result.orders[0].buyer.phoneNumber, "+212612345678");
  assert.equal(confirmedSellerRead.body.result.orders[0].deliveryAddress.city, "Rabat");
  const directPrivateConfirmed = await firestoreRequest(`/orderPrivate/${orderId}`, seller.token);
  assert.equal(directPrivateConfirmed.status, 200);
  const crossRead = await firestoreRequest(`/orders/${orderId}`, otherBuyer.token);
  assert.equal(crossRead.status, 403);
});

test("pickup codes are one-time, hashed, required, and delivery collects payment", async () => {
  const buyer = await createAccount();
  const seller = await createAccount();
  const productId = await createProduct(seller);
  const pickupLocationId = await setupPickup(seller);
  const input = {
    requestId: randomUUID(),
    paymentMethod: "pickup",
    items: [{ productId, quantity: 1 }],
    pickupLocationId,
    phoneNumber: "+212612345678",
  };
  const created = await invoke("createOrder", input, buyer.token);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const order = created.body.result.orders[0];
  const code = created.body.result.pickupCodes[0].pickupCode;
  assert.match(code, /^[0-9]{8}$/);
  const orderDoc = await adminDb.collection("orders").doc(order.id).get();
  assert.equal(orderDoc.get("pickupCodeHash"), undefined);
  const secret = await adminDb.collection("orderSecrets").doc(order.id).get();
  assert.notEqual(secret.get("pickupCodeHash"), code);
  const fetched = await invoke("getOrderById", { orderId: order.id }, buyer.token);
  assert.equal("pickupCode" in fetched.body.result.order, false);
  const replay = await invoke("createOrder", input, buyer.token);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.result.pickupCodes, []);
  assert.equal(replay.body.result.orders[0].id, order.id);

  assert.equal((await invoke("confirmOrder", { orderId: order.id }, seller.token)).status, 200);
  assert.equal((await invoke("markProcessing", { orderId: order.id }, seller.token)).status, 200);
  assert.equal((await invoke("markReadyForPickup", { orderId: order.id }, seller.token)).status, 200);
  const wrongCode = await invoke("markDelivered", {
    orderId: order.id,
    pickupCode: code === "00000000" ? "00000001" : "00000000",
  }, seller.token);
  assert.equal(wrongCode.body.error.status, "FAILED_PRECONDITION");
  const pickupAttemptAudit = await adminDb.collection("auditLogs")
    .where("orderId", "==", order.id)
    .where("action", "==", "fraud_block:pickupCode")
    .get();
  assert.equal(pickupAttemptAudit.size, 1);
  assert.equal(pickupAttemptAudit.docs[0].get("reason"), "ORDER_PICKUP_CODE_INVALID");
  const delivered = await invoke("markDelivered", { orderId: order.id, pickupCode: code }, seller.token);
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  const completedOrder = await adminDb.collection("orders").doc(order.id).get();
  assert.equal(completedOrder.get("paymentStatus"), "collected");
  assert.equal((await adminDb.collection("orderSecrets").doc(order.id).get()).exists, false);
});

test("pickup failure waits three days and restores inventory", async () => {
  const buyer = await createAccount();
  const seller = await createAccount();
  const productId = await createProduct(seller, { stock: 2 });
  const pickupLocationId = await setupPickup(seller);
  const created = await invoke("createOrder", {
    requestId: randomUUID(),
    paymentMethod: "pickup",
    items: [{ productId, quantity: 1 }],
    pickupLocationId,
    phoneNumber: "+212612345678",
  }, buyer.token);
  const orderId = created.body.result.orders[0].id;
  await invoke("confirmOrder", { orderId }, seller.token);
  await invoke("markProcessing", { orderId }, seller.token);
  await invoke("markReadyForPickup", { orderId }, seller.token);
  const tooEarly = await invoke("markFailedDelivery", {
    orderId,
    reason: "Buyer did not collect order.",
  }, seller.token);
  assert.equal(tooEarly.body.error.status, "FAILED_PRECONDITION");
  await adminDb.collection("orders").doc(orderId).update({
    readyForPickupAt: new Date(Date.now() - 4 * 86_400_000),
  });
  const failed = await invoke("markFailedDelivery", {
    orderId,
    reason: "Buyer did not collect order.",
  }, seller.token);
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  assert.equal((await adminDb.collection("products").doc(productId).get()).get("stock"), 2);
});

test("stock is restored on seller rejection and buyer cancellation; rules deny client writes", async () => {
  const buyer = await createAccount();
  const seller = await createAccount();
  const productId = await createProduct(seller, { stock: 3 });
  const created = await invoke("createOrder", codOrder(productId), buyer.token);
  const orderId = created.body.result.orders[0].id;
  assert.equal((await adminDb.collection("products").doc(productId).get()).get("stock"), 2);
  const rejected = await invoke("rejectOrder", { orderId, reason: "Unable to fulfill inventory." }, seller.token);
  assert.equal(rejected.status, 200);
  assert.equal((await adminDb.collection("products").doc(productId).get()).get("stock"), 3);

  const second = await invoke("createOrder", codOrder(productId), buyer.token);
  const secondId = second.body.result.orders[0].id;
  const cancelled = await invoke("cancelMyOrder", { orderId: secondId }, buyer.token);
  assert.equal(cancelled.status, 200);
  assert.equal((await adminDb.collection("products").doc(productId).get()).get("stock"), 3);

  const third = await invoke("createOrder", codOrder(productId), buyer.token);
  const thirdId = third.body.result.orders[0].id;
  await invoke("confirmOrder", { orderId: thirdId }, seller.token);
  await invoke("markProcessing", { orderId: thirdId }, seller.token);
  const cancelledAfterProcessing = await invoke("cancelMyOrder", { orderId: thirdId }, buyer.token);
  assert.equal(cancelledAfterProcessing.body.error.status, "FAILED_PRECONDITION");
  await invoke("markOutForDelivery", { orderId: thirdId }, seller.token);
  const failedDelivery = await invoke("markFailedDelivery", {
    orderId: thirdId,
    reason: "Delivery attempt was unsuccessful.",
  }, seller.token);
  assert.equal(failedDelivery.status, 200);
  assert.equal((await adminDb.collection("products").doc(productId).get()).get("stock"), 3);

  const directWrite = await firestoreRequest(`/orders/${orderId}`, buyer.token, {
    method: "PATCH",
    body: JSON.stringify({ fields: { status: { stringValue: "delivered" } } }),
  });
  assert.equal(directWrite.status, 403);
  const cartWrite = await firestoreRequest(`/carts/${buyer.uid}/items/forged`, buyer.token, {
    method: "PATCH",
    body: JSON.stringify({ fields: { productId: { stringValue: productId } } }),
  });
  assert.equal(cartWrite.status, 403);
  const auditRead = await firestoreRequest("/auditLogs", buyer.token);
  assert.equal(auditRead.status, 403);
});

test("admin order actions require role, MFA, fresh login, and a reason", async () => {
  const buyer = await createAccount();
  const adminWithoutMfa = await createAccount({ role: "admin" });
  const seller = await createAccount();
  const productId = await createProduct(seller);
  const order = await invoke("createOrder", codOrder(productId), buyer.token);
  const orderId = order.body.result.orders[0].id;

  const denied = await invoke("forceCancelOrder", {
    orderId,
    reason: "Valid cancellation reason.",
  }, adminWithoutMfa.token);
  assert.equal(denied.status, 403);
  const admin = await createAccount({ role: "admin", mfa: true });
  const noReason = await invoke("forceCancelOrder", { orderId }, admin.token);
  assert.equal(noReason.status, 400);
  const cancelled = await invoke("forceCancelOrder", {
    orderId,
    reason: "Administrative cancellation.",
  }, admin.token);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const audits = await adminDb.collection("auditLogs").where("orderId", "==", orderId).get();
  assert.ok(audits.docs.some((entry) => entry.get("action") === "order_cancelled"));
});

test("concurrent checkouts cannot oversell; scheduled expiry is idempotent", async () => {
  const seller = await createAccount();
  const buyerA = await createAccount();
  const buyerB = await createAccount();
  const productId = await createProduct(seller, { stock: 1 });
  const attempts = await Promise.all([
    invoke("createOrder", codOrder(productId), buyerA.token),
    invoke("createOrder", codOrder(productId), buyerB.token),
  ]);
  assert.equal(attempts.filter((result) => result.status === 200).length, 1);
  assert.equal((await adminDb.collection("products").doc(productId).get()).get("stock"), 0);

  const successfulOrder = attempts.find((result) => result.status === 200).body.result.orders[0];
  const expiredProduct = await createProduct(seller, { stock: 1 });
  const pending = await invoke("createOrder", codOrder(expiredProduct), buyerA.token);
  const pendingId = pending.body.result.orders[0].id;
  assert.equal((await adminDb.collection("products").doc(expiredProduct).get()).get("stock"), 0);
  await adminDb.collection("orders").doc(pendingId).update({
    createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000),
  });
  assert.equal(await expireOrder({}, pendingId), true);
  assert.equal(await expireOrder({}, pendingId), false);
  assert.equal((await adminDb.collection("orders").doc(pendingId).get()).get("status"), "expired");
  assert.equal((await adminDb.collection("products").doc(expiredProduct).get()).get("stock"), 1);

  const deliveredProduct = await createProduct(seller);
  const delivered = await invoke("createOrder", codOrder(deliveredProduct), buyerB.token);
  const deliveredId = delivered.body.result.orders[0].id;
  await invoke("confirmOrder", { orderId: deliveredId }, seller.token);
  await invoke("markProcessing", { orderId: deliveredId }, seller.token);
  await invoke("markOutForDelivery", { orderId: deliveredId }, seller.token);
  await invoke("markDelivered", { orderId: deliveredId }, seller.token);
  await adminDb.collection("orders").doc(deliveredId).update({
    deliveredAt: new Date(Date.now() - 8 * 86_400_000),
  });
  assert.equal(await completeOrder({}, deliveredId), true);
  assert.equal(await completeOrder({}, deliveredId), false);
  assert.equal((await adminDb.collection("orders").doc(deliveredId).get()).get("status"), "completed");
  assert.ok(successfulOrder.id);
});

test("pending, daily, new-account, reliability, and rate limits are enforced and audited", async () => {
  const buyer = await createAccount();
  const seller = await createAccount();
  const productId = await createProduct(seller, { stock: 20 });
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await invoke("createOrder", codOrder(productId), buyer.token)).status, 200);
  }
  const pendingBlocked = await invoke("createOrder", codOrder(productId), buyer.token);
  assert.equal(pendingBlocked.body.error.status, "RESOURCE_EXHAUSTED");
  assert.ok((await adminDb.collection("auditLogs").where("actorUid", "==", buyer.uid)
    .where("action", "==", "fraud_block:createOrder").get()).size >= 1);

  const dailyBuyer = await createAccount();
  const dateKey = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  await adminDb.collection("_buyerDailyOrderCounts").doc(`${dailyBuyer.uid}_${dateKey}`).set({ count: 10 });
  const dailyProduct = await createProduct(seller);
  const dailyBlocked = await invoke("createOrder", codOrder(dailyProduct), dailyBuyer.token);
  assert.equal(dailyBlocked.body.error.status, "RESOURCE_EXHAUSTED");

  const newBuyer = await createAccount();
  const expensiveProduct = await createProduct(seller, { price: 200001 });
  const newAccountBlocked = await invoke("createOrder", codOrder(expensiveProduct), newBuyer.token);
  assert.equal(newAccountBlocked.body.error.status, "RESOURCE_EXHAUSTED");

  const unreliable = await createAccount();
  await adminDb.collection("_buyerReliability").doc(unreliable.uid).set({
    failedDelivery: 2,
    cancelledAfterConfirmation: 1,
  });
  const reliabilityProduct = await createProduct(seller);
  const codBlocked = await invoke("createOrder", codOrder(reliabilityProduct), unreliable.token);
  assert.equal(codBlocked.body.error.status, "FAILED_PRECONDITION");
  const pickupLocationId = await setupPickup(seller);
  const pickupAllowed = await invoke("createOrder", {
    requestId: randomUUID(),
    paymentMethod: "pickup",
    items: [{ productId: reliabilityProduct, quantity: 1 }],
    pickupLocationId,
    phoneNumber: "+212612345678",
  }, unreliable.token);
  assert.equal(pickupAllowed.status, 200);

  const unverified = await createAccount({ emailVerified: false });
  const unverifiedProduct = await createProduct(seller);
  const unverifiedResult = await invoke("createOrder", codOrder(unverifiedProduct), unverified.token);
  assert.equal(unverifiedResult.body.error.status, "FAILED_PRECONDITION");

  const limited = await createAccount();
  for (let index = 0; index < 5; index += 1) {
    const badInput = await invoke("createOrder", {}, limited.token);
    assert.equal(badInput.status, 400);
  }
  const rateBlocked = await invoke("createOrder", {}, limited.token);
  assert.equal(rateBlocked.body.error.status, "RESOURCE_EXHAUSTED");
});

test("disabled buyers and sellers are blocked; cart reads report disabled seller availability", async () => {
  const buyer = await createAccount();
  const seller = await createAccount();
  const productId = await createProduct(seller);
  await invoke("addToCart", { productId, quantity: 1 }, buyer.token);
  await adminAuth.updateUser(seller.uid, { disabled: true });
  const cart = await invoke("getMyCart", {}, buyer.token);
  assert.equal(cart.body.result.items[0].available, false);

  const disabledBuyer = await createAccount();
  await adminAuth.updateUser(disabledBuyer.uid, { disabled: true });
  const blocked = await invoke("getMyOrders", {}, disabledBuyer.token);
  assert.equal(blocked.body.error.status, "PERMISSION_DENIED");
});
