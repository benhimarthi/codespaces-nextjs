import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase.js";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function rateLimit(request, action, policy) {
  const identities = [];
  const uid = request.auth?.uid;
  const ip = request.rawRequest.ip;

  if (uid) identities.push({ type: "uid", value: uid, limit: policy.perUid });
  if (ip) identities.push({ type: "ip", value: ip, limit: policy.perIp });
  if (identities.length === 0) {
    throw new HttpsError("unavailable", "Request could not be processed.");
  }

  const now = Date.now();
  const windowMs = policy.windowSeconds * 1000;
  const bucket = Math.floor(now / windowMs);
  const expiresAt = Timestamp.fromMillis((bucket + 1) * windowMs + windowMs);
  const references = identities.map(({ type, value }) =>
    db.collection("_rateLimits").doc(hash(`${action}:${type}:${value}:${bucket}`)),
  );

  await db.runTransaction(async (transaction) => {
    const snapshots = await Promise.all(references.map((reference) => transaction.get(reference)));
    if (snapshots.some((snapshot, index) => (snapshot.get("count") ?? 0) >= identities[index].limit)) {
      logger.warn("Rate limit exceeded", {
        event: "rate_limit",
        action,
        outcome: "denied",
      });
      throw new HttpsError("resource-exhausted", "Too many requests.");
    }

    snapshots.forEach((snapshot, index) => {
      transaction.set(references[index], {
        count: (snapshot.get("count") ?? 0) + 1,
        expiresAt,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  });
}
