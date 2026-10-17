import { randomUUID } from "node:crypto";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { roleFor } from "../../middleware/auth.js";
import { db } from "../../utils/firebase.js";
import { orderListSchema } from "../shared/schemas.js";
import { makeOperation, ratePolicy } from "../shared/operation.js";
import { toOrderDto } from "../shared/mappers.js";

export const listOrders = makeOperation({
  name: "admin:listOrders",
  schema: orderListSchema,
  policy: ratePolicy("adminRead"),
  admin: true,
  handler: async (input, { caller, request }) => {
    const pageSize = input.pageSize ?? 20;
    let query = db.collection("orders");
    if (input.status) query = query.where("status", "==", input.status);
    if (input.paymentMethod) query = query.where("paymentMethod", "==", input.paymentMethod);
    query = query.orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc");
    if (input.pageToken) {
      const cursor = await db.collection("orders").doc(input.pageToken).get();
      if (!cursor.exists) throw new HttpsError("not-found", "Order not found.");
      query = query.startAfter(cursor);
    }
    const page = await query.limit(pageSize + 1).get();
    const hasMore = page.size > pageSize;
    const documents = page.docs.slice(0, pageSize);
    const privateSnapshots = await Promise.all(documents.map((document) =>
      db.collection("orderPrivate").doc(document.id).get()));
    const suppliedRequestId = request.rawRequest?.get?.("x-request-id");
    const requestId = typeof suppliedRequestId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedRequestId)
      ? suppliedRequestId
      : randomUUID();
    await db.collection("auditLogs").add({
      actorUid: caller.uid,
      actorRole: roleFor(caller),
      action: "admin_list_orders",
      orderId: null,
      beforeStatus: null,
      afterStatus: null,
      reason: null,
      timestamp: FieldValue.serverTimestamp(),
      requestId,
      ip: request.rawRequest?.ip ?? null,
    });
    return {
      orders: documents.map((document, index) => toOrderDto(document, {
        buyerView: true,
        privateData: privateSnapshots[index].data() ?? null,
      })),
      nextPageToken: hasMore ? documents.at(-1).id : null,
    };
  },
});
