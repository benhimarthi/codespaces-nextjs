import { HttpsError } from "firebase-functions/v2/https";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { emptyInputSchema } from "../schemas/auth.js";
import { db } from "../utils/firebase.js";

export async function getMyProfileOperation(request, data) {
  const caller = requireAuth(request);
  validate(emptyInputSchema, data);

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
}
