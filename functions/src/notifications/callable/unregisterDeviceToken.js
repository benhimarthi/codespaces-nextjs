import { createHash } from "node:crypto";
import { db } from "../../utils/firebase.js";
import { notificationOperation } from "./shared.js";
import { deviceTokenSchema } from "../shared/schemas.js";

export const unregisterDeviceTokenOperation = notificationOperation(
  "unregisterDeviceToken",
  deviceTokenSchema,
  async ({ token }, { caller }) => {
    const tokenId = createHash("sha256").update(token).digest("hex");
    await db.collection("deviceTokens").doc(caller.uid).collection("tokens").doc(tokenId).delete();
    return { unregistered: true };
  },
);
