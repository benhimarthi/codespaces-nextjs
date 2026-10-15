import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { registerUserSchema } from "../schemas/auth.js";
import { callableOptions } from "../utils/callableOptions.js";
import { runSafely } from "../utils/errors.js";
import { auth, db } from "../utils/firebase.js";

export const registerUser = onCall(callableOptions("registerUser"), async (request) =>
  runSafely("register_user", async () => {
    const caller = requireAuth(request);
    await rateLimit(request, "registerUser", {
      perUid: 5,
      perIp: 100,
      windowSeconds: 60,
    });
    const input = validate(registerUserSchema, request.data);
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
    if (user.customClaims?.role !== "admin" && user.customClaims?.role !== "user") {
      await auth.setCustomUserClaims(caller.uid, {
        ...user.customClaims,
        role: "user",
      });
    }

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
  }),
);
