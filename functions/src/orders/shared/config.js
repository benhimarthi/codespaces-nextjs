import { HttpsError } from "firebase-functions/v2/https";

function positiveInteger(name) {
  const configured = process.env[name];
  if (configured === undefined || configured === "") {
    throw new Error(`${name} is required.`);
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function integerMap(name) {
  const configured = process.env[name];
  if (configured === undefined || configured === "") {
    throw new Error(`${name} is required.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(configured);
  } catch {
    throw new Error(`${name} must be a JSON object.`);
  }
  if (
    parsed === null ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    Object.values(parsed).some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error(`${name} must map currency codes to non-negative integers.`);
  }
  return parsed;
}

export const orderConfig = Object.freeze({
  maxCartItems: positiveInteger("CART_MAX_ITEMS"),
  maxQuantity: positiveInteger("CART_MAX_QUANTITY"),
  pendingOrdersLimit: positiveInteger("ORDER_MAX_PENDING"),
  dailyOrdersLimit: positiveInteger("ORDER_MAX_PER_DAY"),
  newAccountAgeDays: positiveInteger("ORDER_NEW_ACCOUNT_DAYS"),
  reliabilityStrikeLimit: positiveInteger("ORDER_RELIABILITY_STRIKES"),
  unconfirmedExpiryHours: positiveInteger("ORDER_UNCONFIRMED_EXPIRY_HOURS"),
  pickupFailureDays: positiveInteger("ORDER_PICKUP_FAILURE_DAYS"),
  autoCompleteDays: positiveInteger("ORDER_AUTO_COMPLETE_DAYS"),
  shippingFees: integerMap("ORDER_SHIPPING_FEES"),
  newAccountTotalLimits: integerMap("ORDER_NEW_ACCOUNT_TOTAL_LIMITS"),
  rateLimits: Object.freeze({
    cart: Object.freeze({
      perUid: positiveInteger("CART_RATE_PER_UID"),
      perIp: positiveInteger("CART_RATE_PER_IP"),
      windowSeconds: positiveInteger("CART_RATE_WINDOW_SECONDS"),
    }),
    createOrder: Object.freeze({
      perUid: positiveInteger("ORDER_CREATE_RATE_PER_UID"),
      perIp: positiveInteger("ORDER_CREATE_RATE_PER_IP"),
      windowSeconds: positiveInteger("ORDER_CREATE_RATE_WINDOW_SECONDS"),
    }),
    buyerRead: Object.freeze({
      perUid: positiveInteger("ORDER_READ_RATE_PER_UID"),
      perIp: positiveInteger("ORDER_READ_RATE_PER_IP"),
      windowSeconds: positiveInteger("ORDER_READ_RATE_WINDOW_SECONDS"),
    }),
    buyerMutation: Object.freeze({
      perUid: positiveInteger("ORDER_MUTATION_RATE_PER_UID"),
      perIp: positiveInteger("ORDER_MUTATION_RATE_PER_IP"),
      windowSeconds: positiveInteger("ORDER_MUTATION_RATE_WINDOW_SECONDS"),
    }),
    seller: Object.freeze({
      perUid: positiveInteger("SELLER_ORDER_RATE_PER_UID"),
      perIp: positiveInteger("SELLER_ORDER_RATE_PER_IP"),
      windowSeconds: positiveInteger("SELLER_ORDER_RATE_WINDOW_SECONDS"),
    }),
    adminRead: Object.freeze({
      perUid: positiveInteger("ADMIN_ORDER_READ_RATE_PER_UID"),
      perIp: positiveInteger("ADMIN_ORDER_READ_RATE_PER_IP"),
      windowSeconds: positiveInteger("ADMIN_ORDER_READ_RATE_WINDOW_SECONDS"),
    }),
    adminMutation: Object.freeze({
      perUid: positiveInteger("ADMIN_ORDER_MUTATION_RATE_PER_UID"),
      perIp: positiveInteger("ADMIN_ORDER_MUTATION_RATE_PER_IP"),
      windowSeconds: positiveInteger("ADMIN_ORDER_MUTATION_RATE_WINDOW_SECONDS"),
    }),
  }),
});

export function configuredCurrencyAmount(map, currency) {
  const amount = map[currency];
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new HttpsError("failed-precondition", "Order settings are unavailable.");
  }
  return amount;
}
