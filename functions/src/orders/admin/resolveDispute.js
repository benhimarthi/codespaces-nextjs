import { resolveDisputeSchema } from "../shared/schemas.js";
import { makeOperation, ratePolicy } from "../shared/operation.js";
import { transitionOrder } from "../shared/transitions.js";

export const resolveDispute = makeOperation({
  name: "admin:resolveDispute",
  schema: resolveDisputeSchema,
  policy: ratePolicy("adminMutation"),
  admin: true,
  freshAuth: true,
  handler: (input, state) => transitionOrder({
    request: state.request,
    caller: state.caller,
    orderId: input.orderId,
    nextStatus: "returned",
    actor: "admin",
    reason: input.reason,
  }),
});
