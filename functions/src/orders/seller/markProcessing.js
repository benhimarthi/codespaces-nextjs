import { orderIdSchema } from "../shared/schemas.js";
import { transitionOrder } from "../shared/transitions.js";
import { sellerOrderOperation } from "./shared/operation.js";

export const markProcessing = sellerOrderOperation(
  "markProcessing",
  orderIdSchema,
  (input, state) => transitionOrder({
    request: state.request,
    caller: state.caller,
    orderId: input.orderId,
    nextStatus: "processing",
    actor: "seller",
    requireSellerOwnership: true,
  }),
);
