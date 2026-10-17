import { orderConfig } from "../../orders/shared/config.js";
import { makeOperation } from "../../orders/shared/operation.js";

export function cartOperation(name, schema, handler) {
  return makeOperation({
    name: `cart:${name}`,
    schema,
    policy: orderConfig.rateLimits.cart,
    handler: (input, { caller }) => handler(input, caller),
  });
}
