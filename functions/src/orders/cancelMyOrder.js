import { cancelMyOrderSchema } from "./shared/schemas.js";
import { makeOperation, ratePolicy } from "./shared/operation.js";
import { cancelOrderOperation } from "./shared/transitions.js";

export const cancelMyOrder = makeOperation({
  name: "cancelMyOrder",
  schema: cancelMyOrderSchema,
  policy: ratePolicy("buyerMutation"),
  handler: (input, state) => cancelOrderOperation(
    state.request,
    input,
    state,
    "buyer",
  ),
});
