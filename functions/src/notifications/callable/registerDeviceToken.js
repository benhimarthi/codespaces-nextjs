import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../utils/firebase.js";
import { notificationOperation } from "./shared.js";
import { deviceTokenSchema } from "../shared/schemas.js";

export const registerDeviceTokenOperation = notificationOperation(
  "registerDeviceToken",
  deviceTokenSchema,
  async ({ token, platform }, { caller }) => {
    const tokenId = createHash("sha256").update(token).digest("hex");
    await db.collection("deviceTokens").doc(caller.uid).collection("tokens").doc(tokenId).set({
      token,
      platform,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { registered: true };
  },
);
