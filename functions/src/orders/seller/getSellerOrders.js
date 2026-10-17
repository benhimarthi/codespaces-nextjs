import { FieldPath } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../../utils/firebase.js";
import { orderListSchema } from "../shared/schemas.js";
import { toOrderDto } from "../shared/mappers.js";
import { showsBuyerContact } from "../shared/stateMachine.js";
import { sellerOrderOperation } from "./shared/operation.js";

export const getSellerOrders = sellerOrderOperation(
  "getSellerOrders",
  orderListSchema,
  async (input, { caller }) => {
    const pageSize = input.pageSize ?? 20;
    let query = db.collection("orders").where("sellerId", "==", caller.uid);
    if (input.status) query = query.where("status", "==", input.status);
    if (input.paymentMethod) query = query.where("paymentMethod", "==", input.paymentMethod);
    query = query.orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc");
    if (input.pageToken) {
      const cursor = await db.collection("orders").doc(input.pageToken).get();
      if (!cursor.exists || cursor.get("sellerId") !== caller.uid) {
        throw new HttpsError("not-found", "Order not found.");
      }
      query = query.startAfter(cursor);
    }
    const page = await query.limit(pageSize + 1).get();
    const hasMore = page.size > pageSize;
    const documents = page.docs.slice(0, pageSize);
    const privateSnapshots = await Promise.all(documents.map((document) =>
      showsBuyerContact(document.get("status"))
        ? db.collection("orderPrivate").doc(document.id).get()
        : Promise.resolve(null)));
    return {
      orders: documents.map((document, index) => toOrderDto(document, {
        sellerView: true,
        privateData: privateSnapshots[index]?.data() ?? null,
      })),
      nextPageToken: hasMore ? documents.at(-1).id : null,
    };
  },
);
