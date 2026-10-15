import assert from "node:assert/strict";
import { test } from "node:test";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || "demo-auth-service";
const authEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const adminApp = getApps().length ? getApps()[0] : initializeApp({ projectId });
const adminAuth = getAuth(adminApp);
const adminDb = getFirestore(adminApp);

async function createAccount(email, role) {
  const user = await adminAuth.createUser({ email });
  if (role) {
    await adminAuth.setCustomUserClaims(user.uid, { role });
  }

  const customToken = await adminAuth.createCustomToken(user.uid);
  const response = await fetch(
    `http://${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: customToken,
        returnSecureToken: true,
      }),
    },
  );
  assert.equal(response.ok, true, "Auth emulator sign-in should succeed");
  const result = await response.json();
  return { uid: user.uid, email, token: result.idToken };
}

async function invoke(name, data, token) {
  const response = await fetch(
    `http://${functionsHost}/${projectId}/us-central1/${name}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
        "X-Firebase-AppCheck": `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"app_id":"local-emulator-test"}').toString("base64url")}.`,
      },
      body: JSON.stringify({ data }),
    },
  );
  return { status: response.status, body: await response.json() };
}

async function firestoreRequest(path, token, options = {}) {
  const host = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  return fetch(
    `http://${host}/v1/projects/${projectId}/databases/(default)/documents${path}`,
    {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...options.headers,
      },
    },
  );
}

test("callables reject unauthenticated callers", async () => {
  const response = await invoke("getMyProfile", {});
  assert.equal(response.body.error.status, "UNAUTHENTICATED");
});

test("role changes reject non-admins and prevent self-promotion", async () => {
  const user = await createAccount("regular@example.test");
  const other = await createAccount("other@example.test");
  const wrongRole = await invoke("setUserRole", {
    email: other.email,
    role: "admin",
  }, user.token);
  assert.equal(wrongRole.body.error.status, "PERMISSION_DENIED", JSON.stringify(wrongRole.body));

  const selfPromotion = await invoke("setUserRole", {
    email: user.email,
    role: "admin",
  }, user.token);
  assert.equal(selfPromotion.body.error.status, "PERMISSION_DENIED", JSON.stringify(selfPromotion.body));
});

test("Zod validation rejects unknown and malformed fields", async () => {
  const user = await createAccount("invalid-input@example.test");
  const response = await invoke("registerUser", {
    displayName: "Valid",
    uid: "attacker-controlled",
  }, user.token);
  assert.equal(response.body.error.status, "INVALID_ARGUMENT", JSON.stringify(response.body));

  const malformed = await invoke("registerUser", { displayName: " " }, user.token);
  assert.equal(malformed.body.error.status, "INVALID_ARGUMENT", JSON.stringify(malformed.body));
});

test("registration is idempotent and rate limits repeated calls", async () => {
  const user = await createAccount("rate-limit@example.test");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await invoke("registerUser", { displayName: "First name" }, user.token);
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  const limited = await invoke("registerUser", { displayName: "Changed name" }, user.token);
  assert.equal(limited.body.error.status, "RESOURCE_EXHAUSTED");

  const profile = await invoke("getMyProfile", {}, user.token);
  assert.equal(profile.body.result.profile.displayName, "First name");
  const claims = await adminAuth.getUser(user.uid);
  assert.equal(claims.customClaims.role, "user");
});

test("admins can change another account's role without accepting a UID", async () => {
  const admin = await createAccount("admin@example.test", "admin");
  const target = await createAccount("target@example.test");
  const response = await invoke("setUserRole", {
    email: target.email,
    role: "admin",
  }, admin.token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await adminAuth.getUser(target.uid)).customClaims.role, "admin");
});

test("account deletion removes the caller's Auth user and profile data", async () => {
  const user = await createAccount("delete-me@example.test");
  assert.equal((await invoke("registerUser", { displayName: "Delete me" }, user.token)).status, 200);

  const response = await invoke("deleteMyAccount", {}, user.token);
  assert.equal(response.status, 200);
  await assert.rejects(adminAuth.getUser(user.uid), { code: "auth/user-not-found" });
  assert.equal((await adminDb.collection("users").doc(user.uid).get()).exists, false);

  const retry = await invoke("deleteMyAccount", {}, user.token);
  assert.equal(retry.status, 200);
});

test("Firestore rules allow only own-profile reads and deny all direct writes", async () => {
  const user = await createAccount("rules-owner@example.test");
  const other = await createAccount("rules-other@example.test");
  await adminDb.collection("users").doc(user.uid).set({
    displayName: "Example",
    createdAt: new Date(),
  });

  const ownRead = await firestoreRequest(`/users/${user.uid}`, user.token);
  assert.equal(ownRead.status, 200);
  const otherRead = await firestoreRequest(`/users/${user.uid}`, other.token);
  assert.equal(otherRead.status, 403);

  const protectedWrite = await firestoreRequest(
    `/users/${user.uid}?updateMask.fieldPaths=displayName&updateMask.fieldPaths=role`,
    user.token,
    {
      method: "PATCH",
      body: JSON.stringify({
        fields: {
          displayName: { stringValue: "Changed" },
          role: { stringValue: "admin" },
        },
      }),
    },
  );
  assert.equal(protectedWrite.status, 403);

  const forgedRateLimit = await firestoreRequest("/_rateLimits?documentId=forged", user.token, {
    method: "POST",
    body: JSON.stringify({ fields: { count: { integerValue: "100" } } }),
  });
  assert.equal(forgedRateLimit.status, 403);
});

test("Storage rules deny client reads and writes", async () => {
  const user = await createAccount("storage-user@example.test");
  const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";
  const objectUrl = `http://${host}/v0/b/${projectId}.appspot.com/o`;
  const upload = await fetch(
    `${objectUrl}?uploadType=media&name=private%2Ffile.txt`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + user.token,
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array([1]),
    },
  );
  assert.equal(upload.status, 403);

  const read = await fetch(
    `${objectUrl}/private%2Ffile.txt?alt=media`,
    { headers: { authorization: "Bearer " + user.token } },
  );
  assert.equal(read.status, 403);
});
