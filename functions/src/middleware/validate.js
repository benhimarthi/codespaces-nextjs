import { HttpsError } from "firebase-functions/v2/https";

export function validate(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpsError("invalid-argument", "Invalid request.");
  }
  return result.data;
}
