import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { firestoreDatabaseId } from "../src/utils/firestoreDatabase.js";

const projectId = process.env.GCLOUD_PROJECT || "demo-auth-service";
const authEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const app = getApps().length ? getApps()[0] : initializeApp({ projectId });
const adminAuth = getAuth(app);
const adminDb = getFirestore(app, firestoreDatabaseId);
const baseUrl = `http://${functionsHost}/${projectId}/us-central1/notificationService`;

async function post(path, data = {}, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(data),
  });
  return { status: response.status, body: await response.json() };
}

async function createAccount() {
  const user = await adminAuth.createUser({
    email: `notifications-${randomUUID()}@example.test`,
    emailVerified: true,
  });
  await adminDb.collection("users").doc(user.uid).set({
    role: "user",
    disabled: false,
    deleted: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  const customToken = await adminAuth.createCustomToken(user.uid);
  const response = await fetch(
    `http://${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  assert.equal(response.ok, true, "Auth emulator sign-in should succeed");
  return (await response.json()).idToken;
}

test("notification service exposes one authenticated HTTP API", async () => {
  const unauthenticated = await post("/notifications/list");
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.error.status, "UNAUTHENTICATED");

  const unknownRoute = await post("/notifications/unknown");
  assert.equal(unknownRoute.status, 404);
  assert.equal(unknownRoute.body.error.status, "NOT_FOUND");

  const token = await createAccount();
  const result = await post("/notifications/list", {}, token);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, { notifications: [], nextPageToken: null });
});
