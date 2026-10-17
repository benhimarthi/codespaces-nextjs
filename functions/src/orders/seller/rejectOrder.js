import { transitionReasonSchema } from "../shared/schemas.js";
import { transitionOrder } from "../shared/transitions.js";
import { sellerOrderOperation } from "./shared/operation.js";

export const rejectOrder = sellerOrderOperation("rejectOrder", transitionReasonSchema, (input, state) =>
  transitionOrder({
    request: state.request,
    caller: state.caller,
    orderId: input.orderId,
    nextStatus: "rejected",
    actor: "seller",
    reason: input.reason,
    requireSellerOwnership: true,
  }));
