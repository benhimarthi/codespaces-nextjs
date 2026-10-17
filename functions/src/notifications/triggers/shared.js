import { db } from "../../utils/firebase.js";
import { dispatchNotification } from "../engine/dispatcher.js";

export async function notifyAdmins({ eventType, orderId, status }) {
  const administrators = await db.collection("users")
    .where("role", "in", ["admin", "superadmin"])
    .get();
  await Promise.all(administrators.docs.map((administrator) =>
    dispatchNotification({
      eventType,
      recipientUid: administrator.id,
      orderId,
      status,
    }),
  ));
}
