import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { registerUserSchema } from "../schemas/auth.js";
import { auth, db } from "../utils/firebase.js";

export async function registerUserOperation(request, data) {
  const caller = requireAuth(request);
  await rateLimit(request, "registerUser", {
    perUid: 5,
    perIp: 100,
    windowSeconds: 60,
  });
  const input = validate(registerUserSchema, data);
  const profileRef = db.collection("users").doc(caller.uid);
  let created = false;

  await db.runTransaction(async (transaction) => {
    const profile = await transaction.get(profileRef);
    if (!profile.exists) {
      transaction.create(profileRef, {
        displayName: input.displayName,
        createdAt: FieldValue.serverTimestamp(),
      });
      created = true;
    }
  });

  const user = await auth.getUser(caller.uid);
  const role = ["user", "admin", "superadmin"].includes(user.customClaims?.role)
    ? user.customClaims.role
    : "user";
  const claims = user.customClaims ?? {};
  if (
    Object.keys(claims).length !== 1 ||
    claims.role !== role
  ) {
    await auth.setCustomUserClaims(caller.uid, { role });
  }
  await profileRef.set({ role }, { merge: true });

  const profile = await profileRef.get();
  const displayName = profile.get("displayName");
  const createdAt = profile.get("createdAt");
  if (
    typeof displayName !== "string" ||
    !createdAt ||
    typeof createdAt.toDate !== "function"
  ) {
    throw new HttpsError("internal", "Unable to complete the request.");
  }

  if (created) {
    logger.info("User profile registered", {
      event: "user_registration",
      outcome: "success",
    });
  }

  return {
    profile: {
      displayName,
      createdAt: createdAt.toDate().toISOString(),
    },
  };
}
