import { markDeliveredSchema } from "../shared/schemas.js";
import { transitionOrder } from "../shared/transitions.js";
import { sellerOrderOperation } from "./shared/operation.js";

export const markDelivered = sellerOrderOperation(
  "markDelivered",
  markDeliveredSchema,
  (input, state) => transitionOrder({
    request: state.request,
    caller: state.caller,
    orderId: input.orderId,
    nextStatus: "delivered",
    actor: "seller",
    pickupCode: input.pickupCode,
    requireSellerOwnership: true,
  }),
);
