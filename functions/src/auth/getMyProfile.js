import { onCall, HttpsError } from "firebase-functions/v2/https";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { emptyInputSchema } from "../schemas/auth.js";
import { callableOptions } from "../utils/callableOptions.js";
import { runSafely } from "../utils/errors.js";
import { db } from "../utils/firebase.js";

export const getMyProfile = onCall(callableOptions("getMyProfile"), async (request) =>
  runSafely("get_my_profile", async () => {
    const caller = requireAuth(request);
    validate(emptyInputSchema, request.data);

    const profile = await db.collection("users").doc(caller.uid).get();
    const displayName = profile.get("displayName");
    const createdAt = profile.get("createdAt");
    if (
      !profile.exists ||
      typeof displayName !== "string" ||
      !createdAt ||
      typeof createdAt.toDate !== "function"
    ) {
      throw new HttpsError("not-found", "Profile not found.");
    }

    return {
      profile: {
        displayName,
        createdAt: createdAt.toDate().toISOString(),
      },
    };
  }),
);
