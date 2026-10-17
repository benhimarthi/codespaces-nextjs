import { FieldPath } from "firebase-admin/firestore";
import { db } from "../utils/firebase.js";
import { deny, productOperation } from "./shared/operations.js";
import { toProductDto } from "./shared/mappers.js";
import { myProductsSchema } from "./shared/schemas.js";

export async function getMyProductsOperation(request) {
  return productOperation(request, "getMyProducts", myProductsSchema, async (input, caller) => {
    const pageSize = input.pageSize ?? 20;
    let query = db.collection("products")
      .where("sellerId", "==", caller.uid)
      .orderBy("createdAt", "desc")
      .orderBy(FieldPath.documentId(), "desc");
    if (input.status) query = query.where("status", "==", input.status);
    if (input.pageToken) {
      const cursor = await db.collection("products").doc(input.pageToken).get();
      if (!cursor.exists || cursor.get("sellerId") !== caller.uid) {
        deny("PRODUCT_PAGE_TOKEN_INVALID", "invalid-argument", "Invalid page token.");
      }
      query = query.startAfter(cursor);
    }

    const result = await query.limit(pageSize + 1).get();
    const hasMore = result.size > pageSize;
    const page = result.docs.slice(0, pageSize);
    return {
      products: page.map(toProductDto),
      nextPageToken: hasMore ? page.at(-1).id : null,
    };
  });
}
