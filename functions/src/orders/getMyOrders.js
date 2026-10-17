import { FieldPath } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase.js";
import { orderListSchema } from "./shared/schemas.js";
import { makeOperation, ratePolicy } from "./shared/operation.js";
import { toOrderDto } from "./shared/mappers.js";

export const getMyOrders = makeOperation({
  name: "getMyOrders",
  schema: orderListSchema,
  policy: ratePolicy("buyerRead"),
  handler: async (input, { caller }) => {
    const pageSize = input.pageSize ?? 20;
    let query = db.collection("orders").where("buyerUid", "==", caller.uid);
    if (input.status) query = query.where("status", "==", input.status);
    if (input.paymentMethod) query = query.where("paymentMethod", "==", input.paymentMethod);
    query = query.orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc");
    if (input.pageToken) {
      const cursor = await db.collection("orders").doc(input.pageToken).get();
      if (!cursor.exists || cursor.get("buyerUid") !== caller.uid) {
        throw new HttpsError("not-found", "Order not found.");
      }
      query = query.startAfter(cursor);
    }
    const page = await query.limit(pageSize + 1).get();
    const hasMore = page.size > pageSize;
    const documents = page.docs.slice(0, pageSize);
    const privateSnapshots = await Promise.all(documents.map((document) =>
      db.collection("orderPrivate").doc(document.id).get()));
    return {
      orders: documents.map((document, index) => toOrderDto(document, {
        buyerView: true,
        privateData: privateSnapshots[index].data() ?? null,
      })),
      nextPageToken: hasMore ? documents.at(-1).id : null,
    };
  },
});
