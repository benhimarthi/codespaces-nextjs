import { orderIdSchema } from "../shared/schemas.js";
import { transitionOrder } from "../shared/transitions.js";
import { sellerOrderOperation } from "./shared/operation.js";

export const markOutForDelivery = sellerOrderOperation(
  "markOutForDelivery",
  orderIdSchema,
  (input, state) => transitionOrder({
    request: state.request,
    caller: state.caller,
    orderId: input.orderId,
    nextStatus: "out_for_delivery",
    actor: "seller",
    requireSellerOwnership: true,
  }),
);
