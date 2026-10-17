import { failDeliverySchema } from "../shared/schemas.js";
import { transitionOrder } from "../shared/transitions.js";
import { sellerOrderOperation } from "./shared/operation.js";

export const markFailedDelivery = sellerOrderOperation(
  "markFailedDelivery",
  failDeliverySchema,
  (input, state) => transitionOrder({
    request: state.request,
    caller: state.caller,
    orderId: input.orderId,
    nextStatus: "failed_delivery",
    actor: "seller",
    reason: input.reason,
    requireSellerOwnership: true,
  }),
);
