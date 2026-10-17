import { forceCancelOrderSchema } from "../shared/schemas.js";
import { makeOperation, ratePolicy } from "../shared/operation.js";
import { transitionOrder } from "../shared/transitions.js";

export const forceCancelOrder = makeOperation({
  name: "admin:forceCancelOrder",
  schema: forceCancelOrderSchema,
  policy: ratePolicy("adminMutation"),
  admin: true,
  freshAuth: true,
  handler: (input, state) => transitionOrder({
    request: state.request,
    caller: state.caller,
    orderId: input.orderId,
    nextStatus: "cancelled",
    actor: "admin",
    reason: input.reason,
  }),
});
