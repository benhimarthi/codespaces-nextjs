import { orderIdSchema } from "../shared/schemas.js";
import { transitionOrder } from "../shared/transitions.js";
import { sellerOrderOperation } from "./shared/operation.js";

export const markReadyForPickup = sellerOrderOperation(
  "markReadyForPickup",
  orderIdSchema,
  (input, state) => transitionOrder({
    request: state.request,
    caller: state.caller,
    orderId: input.orderId,
    nextStatus: "ready_for_pickup",
    actor: "seller",
    requireSellerOwnership: true,
  }),
);
