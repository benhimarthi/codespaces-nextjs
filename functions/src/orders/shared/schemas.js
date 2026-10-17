import { z } from "zod";
import { orderConfig } from "./config.js";
import { orderStatuses } from "./stateMachine.js";

const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const text = (max) => z.string().trim().min(1).max(max);
const reason = z.string().trim().min(10).max(1000);
const phone = z.string().trim().min(9).max(16).regex(/^(?:\+212|0)[5-7]\d{8}$/);
const variantId = id.nullable().optional();
const item = z.object({
  productId: id,
  variantId,
  quantity: z.number().int().min(1).max(orderConfig.maxQuantity),
}).strict();
const address = z.object({
  fullName: text(100),
  street: text(200),
  city: text(80),
  region: text(80),
  postalCode: z.string().trim().min(2).max(12).regex(/^[A-Za-z0-9 -]+$/),
  countryCode: z.literal("MA"),
}).strict();
const pickupLocations = z.array(z.object({
  productId: id,
  pickupLocationId: id,
}).strict()).min(1).max(orderConfig.maxCartItems).optional();

export const createOrderSchema = z.object({
  requestId: z.string().uuid(),
  paymentMethod: z.enum(["cod", "pickup"]),
  items: z.array(item).min(1).max(orderConfig.maxCartItems).optional(),
  useCart: z.boolean().optional(),
  deliveryAddress: address.optional(),
  pickupLocationId: id.optional(),
  pickupLocations,
  phoneNumber: phone,
  note: z.string().trim().max(1000).optional(),
}).strict().superRefine((input, context) => {
  if ((input.items === undefined) === (input.useCart !== true)) {
    context.addIssue({ code: "custom", message: "Provide items or set useCart to true." });
  }
  if (input.paymentMethod === "cod") {
    if (!input.deliveryAddress) context.addIssue({ code: "custom", path: ["deliveryAddress"] });
    if (input.pickupLocationId !== undefined) context.addIssue({ code: "custom", path: ["pickupLocationId"] });
    if (input.pickupLocations !== undefined) context.addIssue({ code: "custom", path: ["pickupLocations"] });
  } else {
    if (
      (input.pickupLocationId === undefined) === (input.pickupLocations === undefined)
    ) {
      context.addIssue({ code: "custom", path: ["pickupLocationId"] });
    }
    if (input.deliveryAddress !== undefined) context.addIssue({ code: "custom", path: ["deliveryAddress"] });
  }
  if (input.pickupLocations) {
    const productIds = input.pickupLocations.map((entry) => entry.productId);
    if (new Set(productIds).size !== productIds.length) {
      context.addIssue({ code: "custom", path: ["pickupLocations"] });
    }
  }
});

export const orderIdSchema = z.object({ orderId: id }).strict();
export const cancelMyOrderSchema = orderIdSchema.extend({
  reason: z.string().trim().min(3).max(500).optional(),
}).strict();
export const transitionReasonSchema = orderIdSchema.extend({ reason }).strict();
export const markDeliveredSchema = orderIdSchema.extend({
  pickupCode: z.string().trim().length(8).regex(/^[0-9]{8}$/).optional(),
}).strict();
export const failDeliverySchema = orderIdSchema.extend({ reason }).strict();
export const pickupFailureSchema = orderIdSchema.extend({ reason }).strict();
export const forceCancelOrderSchema = orderIdSchema.extend({ reason }).strict();
export const resolveDisputeSchema = orderIdSchema.extend({ reason }).strict();

export const orderListSchema = z.object({
  status: z.enum(orderStatuses).optional(),
  paymentMethod: z.enum(["cod", "pickup"]).optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
  pageToken: id.optional(),
}).strict();

export const expireOrdersSchema = z.object({}).strict();
