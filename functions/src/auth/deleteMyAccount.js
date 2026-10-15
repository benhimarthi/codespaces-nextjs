import { onCall } from "firebase-functions/v2/https";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import { emptyInputSchema } from "../schemas/auth.js";
import { callableOptions } from "../utils/callableOptions.js";
import { runSafely } from "../utils/errors.js";
import { auth, db } from "../utils/firebase.js";

export const deleteMyAccount = onCall(callableOptions("deleteMyAccount"), async (request) =>
  runSafely("delete_my_account", async () => {
    const caller = requireAuth(request);
    await rateLimit(request, "deleteMyAccount", {
      perUid: 3,
      perIp: 20,
      windowSeconds: 3600,
    });
    validate(emptyInputSchema, request.data);

    await db.recursiveDelete(db.collection("users").doc(caller.uid));
    try {
      await auth.deleteUser(caller.uid);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "auth/user-not-found"
      ) {
        return { success: true };
      }
      throw error;
    }

    return { success: true };
  }),
);
