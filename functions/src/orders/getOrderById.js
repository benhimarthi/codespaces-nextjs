import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase.js";
import { orderIdSchema } from "./shared/schemas.js";
import { makeOperation, ratePolicy } from "./shared/operation.js";
import { toOrderDto } from "./shared/mappers.js";

export const getOrderById = makeOperation({
  name: "getOrderById",
  schema: orderIdSchema,
  policy: ratePolicy("buyerRead"),
  handler: async ({ orderId }, { caller }) => {
    const order = await db.collection("orders").doc(orderId).get();
    if (!order.exists || order.get("buyerUid") !== caller.uid) {
      throw new HttpsError("not-found", "Order not found.");
    }
    const privateSnapshot = await db.collection("orderPrivate").doc(orderId).get();
    return {
      order: toOrderDto(order, {
        buyerView: true,
        privateData: privateSnapshot.data() ?? null,
      }),
    };
  },
});
