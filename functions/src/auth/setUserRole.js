import { logger } from "firebase-functions";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import { setUserRoleSchema } from "../schemas/auth.js";
import { callableOptions } from "../utils/callableOptions.js";
import { runSafely } from "../utils/errors.js";
import { auth } from "../utils/firebase.js";

export const setUserRole = onCall(callableOptions("setUserRole"), async (request) =>
  runSafely("set_user_role", async () => {
    const caller = requireAuth(request);
    await rateLimit(request, "setUserRole", {
      perUid: 5,
      perIp: 100,
      windowSeconds: 60,
    });
    requireRole(caller, "admin");
    const input = validate(setUserRoleSchema, request.data);
    const target = await auth.getUserByEmail(input.email);

    if (target.uid === caller.uid) {
      logger.warn("Role change denied", {
        event: "role_change",
        outcome: "self_target_denied",
      });
      throw new HttpsError("permission-denied", "Permission denied.");
    }

    if (target.customClaims?.role !== input.role) {
      await auth.setCustomUserClaims(target.uid, {
        ...target.customClaims,
        role: input.role,
      });
      logger.info("User role changed", {
        event: "role_change",
        outcome: "success",
        role: input.role,
      });
    }

    return { success: true };
  }),
);
