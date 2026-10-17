import { transitionReasonSchema } from "../shared/schemas.js";
import { cancelOrderOperation } from "../shared/transitions.js";
import { sellerOrderOperation } from "./shared/operation.js";

export const cancelSellerOrder = sellerOrderOperation(
  "cancelSellerOrder",
  transitionReasonSchema,
  (input, state) => cancelOrderOperation(state.request, input, state, "seller"),
);
