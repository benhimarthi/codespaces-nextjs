import assert from "node:assert/strict";
import { test } from "node:test";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { firestoreDatabaseId } from "../src/utils/firestoreDatabase.js";
import { requireRecentLogin } from "../src/middleware/auth.js";

const projectId = process.env.GCLOUD_PROJECT || "demo-auth-service";
const authEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const adminApp = getApps().length ? getApps()[0] : initializeApp({ projectId });
const adminAuth = getAuth(adminApp);
const adminDb = getFirestore(adminApp, firestoreDatabaseId);

async function createAccount(email, role, mfa = false) {
  const user = await adminAuth.createUser({ email });
  if (role) {
    await adminAuth.setCustomUserClaims(user.uid, {
      role,
      ...(mfa ? { sign_in_second_factor: "phone" } : {}),
    });
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

async function invoke(
  path,
  data = {},
  token,
  method = "POST",
  includeAppCheck = true,
  extraHeaders = {},
) {
  const response = await fetch(
    `http://${functionsHost}/${projectId}/us-central1/authService${path}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...(includeAppCheck
          ? { "X-Firebase-AppCheck": "local-emulator-test-token" }
          : {}),
        ...extraHeaders,
      },
      ...(method !== "GET" && data !== undefined
        ? { body: JSON.stringify(data) }
        : {}),
    },
  );
  return { status: response.status, body: await response.json() };
}

async function firestoreRequest(path, token, options = {}) {
  const host = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  return fetch(
    `http://${host}/v1/projects/${projectId}/databases/${firestoreDatabaseId}/documents${path}`,
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

test("HTTP routes reject unauthenticated callers", async () => {
  const response = await invoke("/profile", {}, undefined, "GET");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.status, "UNAUTHENTICATED");

  const invalidToken = await invoke("/profile", {}, "not-a-valid-id-token", "GET");
  assert.equal(invalidToken.status, 401);
  assert.equal(invalidToken.body.error.status, "UNAUTHENTICATED");
});

test("routes do not require App Check and unknown routes are not exposed", async () => {
  const user = await createAccount("app-check@example.test");
  const missingAppCheck = await invoke(
    "/register",
    { displayName: "Test user" },
    user.token,
    "POST",
    false,
  );
  assert.equal(missingAppCheck.status, 200, JSON.stringify(missingAppCheck.body));

  const unknownRoute = await invoke("/unknown", {}, user.token);
  assert.equal(unknownRoute.status, 404);
  assert.equal(unknownRoute.body.error.status, "NOT_FOUND");

  const wrongMethod = await invoke("/profile", {}, user.token, "POST");
  assert.equal(wrongMethod.status, 404);
});

test("role changes reject non-admins and prevent self-promotion", async () => {
  const user = await createAccount("regular@example.test");
  const other = await createAccount("other@example.test");
  const wrongRole = await invoke("/role", {
    email: other.email,
    role: "admin",
  }, user.token);
  assert.equal(wrongRole.status, 403, JSON.stringify(wrongRole.body));
  assert.equal(wrongRole.body.error.status, "PERMISSION_DENIED");

  const selfPromotion = await invoke("/role", {
    email: user.email,
    role: "admin",
  }, user.token);
  assert.equal(selfPromotion.status, 403, JSON.stringify(selfPromotion.body));
  assert.equal(selfPromotion.body.error.status, "PERMISSION_DENIED");
});

test("Zod validation rejects unknown and malformed fields", async () => {
  const user = await createAccount("invalid-input@example.test");
  const response = await invoke("/register", {
    displayName: "Valid",
    uid: "attacker-controlled",
  }, user.token);
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.error.status, "INVALID_ARGUMENT");

  const malformed = await invoke("/register", { displayName: " " }, user.token);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.status, "INVALID_ARGUMENT", JSON.stringify(malformed.body));
});

test("registration is idempotent and rate limits repeated calls", async () => {
  const user = await createAccount("rate-limit@example.test");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await invoke("/register", { displayName: "First name" }, user.token);
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  const limited = await invoke("/register", { displayName: "Changed name" }, user.token);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.status, "RESOURCE_EXHAUSTED");

  const profile = await invoke("/profile", {}, user.token, "GET");
  assert.equal(profile.body.profile.displayName, "First name");
  const claims = await adminAuth.getUser(user.uid);
  assert.deepEqual(claims.customClaims, { role: "user" });
});

test("admins can change another account's role without accepting a UID", async () => {
  const admin = await createAccount("superadmin@example.test", "superadmin", true);
  const target = await createAccount("target@example.test");
  const response = await invoke("/role", {
    email: target.email,
    role: "admin",
    reason: "Approving elevated access",
  }, admin.token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual((await adminAuth.getUser(target.uid)).customClaims, { role: "admin" });

  const newSuperadmin = await createAccount("new-superadmin-target@example.test");
  const promoted = await invoke("/admin/users/set-role", {
    uid: newSuperadmin.uid,
    role: "superadmin",
    reason: "Grant superadmin access",
  }, admin.token);
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.deepEqual(
    (await adminAuth.getUser(newSuperadmin.uid)).customClaims,
    { role: "superadmin" },
  );
});

test("admin endpoints deny non-admin calls and audit every denial", async () => {
  const caller = await createAccount("admin-routes-user@example.test", "user");
  const target = await createAccount("admin-routes-target@example.test");
  const calls = [
    ["/admin/users/list", { maxResults: 1 }],
    ["/admin/users/get", { uid: target.uid }],
    ["/admin/users/set-role", { uid: target.uid, role: "admin", reason: "Grant access" }],
    ["/admin/users/disable", { uid: target.uid, reason: "Suspicious activity" }],
    ["/admin/users/enable", { uid: target.uid }],
    ["/admin/users/revoke-sessions", { uid: target.uid }],
    ["/admin/users/delete", { uid: target.uid, reason: "Account cleanup" }],
    ["/admin/users/create", {
      email: "denied-created@example.test",
      displayName: "Denied",
      role: "user",
    }],
    ["/admin/users/password-reset", { uid: target.uid }],
    ["/admin/audit-logs/list", { maxResults: 1 }],
    ["/admin/users/bulk-disable", { uids: [target.uid], reason: "Bulk cleanup" }],
  ];

  for (const [path, body] of calls) {
    const response = await invoke(path, body, caller.token);
    assert.equal(response.status, 403, `${path}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.status, "PERMISSION_DENIED");
  }

  const entries = await adminDb.collection("auditLogs")
    .where("actorUid", "==", caller.uid).get();
  assert.equal(entries.size, calls.length);
  assert.equal(entries.docs.every((entry) => entry.get("outcome") === "denied"), true);
});

test("admins cannot modify peer or higher-ranked accounts, and self actions are blocked", async () => {
  const admin = await createAccount("hierarchy-admin@example.test", "admin", true);
  const peer = await createAccount("hierarchy-peer@example.test", "admin");
  const superadmin = await createAccount("hierarchy-superadmin@example.test", "superadmin");

  for (const target of [peer, superadmin]) {
    const response = await invoke("/admin/users/disable", {
      uid: target.uid,
      reason: "Review account access",
    }, admin.token);
    assert.equal(response.status, 403, JSON.stringify(response.body));
  }

  const selfRole = await invoke("/admin/users/set-role", {
    uid: admin.uid,
    role: "user",
    reason: "Change administrator role",
  }, admin.token);
  assert.equal(selfRole.status, 403);
  const selfDisable = await invoke("/admin/users/disable", {
    uid: admin.uid,
    reason: "Disable administrator",
  }, admin.token);
  assert.equal(selfDisable.status, 403);
  const selfDelete = await invoke("/admin/users/delete", {
    uid: admin.uid,
    reason: "Delete administrator",
  }, admin.token);
  assert.equal(selfDelete.status, 403);

  const lastSuperadminDelete = await invoke("/admin/users/delete", {
    uid: superadmin.uid,
    reason: "Remove final superadmin",
  }, superadmin.token);
  assert.equal(lastSuperadminDelete.status, 403);
  assert.equal((await adminAuth.getUser(superadmin.uid)).disabled, false);
});

test("MFA, recent login, reason, role changes, and session revocation are enforced", async () => {
  const admin = await createAccount("sensitive-admin@example.test", "superadmin", true);
  const target = await createAccount("sensitive-target@example.test");
  const missingReason = await invoke("/admin/users/disable", {
    uid: target.uid,
  }, admin.token);
  assert.equal(missingReason.status, 400);
  assert.equal(missingReason.body.error.status, "INVALID_ARGUMENT");

  const noMfa = await createAccount("no-mfa-admin@example.test", "admin");
  const mfaDenied = await invoke("/admin/users/list", { maxResults: 1 }, noMfa.token);
  assert.equal(mfaDenied.status, 403);

  assert.throws(() => requireRecentLogin({
    token: { auth_time: Math.floor(Date.now() / 1000) - 301 },
  }), { code: "permission-denied" });

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const changed = await invoke("/admin/users/set-role", {
    uid: target.uid,
    role: "admin",
    reason: "Promote trusted user",
  }, admin.token);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal((await adminAuth.getUser(target.uid)).customClaims.role, "admin");
  await assert.rejects(adminAuth.verifyIdToken(target.token, true), {
    code: "auth/id-token-revoked",
  });

  const entries = await adminDb.collection("auditLogs")
    .where("targetUid", "==", target.uid).get();
  assert.equal(entries.docs.some((entry) =>
    entry.get("action") === "set_user_role" &&
    entry.get("outcome") === "success" &&
    entry.get("reason") === "Promote trusted user"
  ), true);
});

test("admin pagination, bulk caps, and strict per-admin rate limits are enforced", async () => {
  const admin = await createAccount("pagination-admin@example.test", "superadmin", true);
  const badPageSize = await invoke("/admin/users/list", { maxResults: 101 }, admin.token);
  assert.equal(badPageSize.status, 400);

  const invalidBulk = await invoke("/admin/users/bulk-disable", {
    uids: Array.from({ length: 51 }, (_, index) => `uid-${index}`),
    reason: "Bulk account cleanup",
  }, admin.token);
  assert.equal(invalidBulk.status, 400);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await invoke("/admin/users/list", { maxResults: 1 }, admin.token);
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  const limited = await invoke("/admin/users/list", { maxResults: 1 }, admin.token);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.status, "RESOURCE_EXHAUSTED");
});

test("admin audit reads are filterable and contain no reset links or credentials", async () => {
  const admin = await createAccount("audit-reader@example.test", "admin", true);
  const target = await createAccount("audit-target@example.test");
  const disabled = await invoke("/admin/users/disable", {
    uid: target.uid,
    reason: "Disable test account",
  }, admin.token, "POST", true, {
    "X-Request-Id": "8cf32863-9aaf-43a8-8c51-5f89e287c24f",
  });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));

  const response = await invoke("/admin/audit-logs/list", {
    actorUid: admin.uid,
    targetUid: target.uid,
    action: "disable_user",
    maxResults: 10,
  }, admin.token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.logs.some((entry) =>
    entry.reason === "Disable test account" &&
    entry.requestId === "8cf32863-9aaf-43a8-8c51-5f89e287c24f"
  ), true);
  assert.equal(JSON.stringify(response.body).includes("resetLink"), false);
});

test("admin account creation is idempotent and reset links are never returned", async () => {
  const admin = await createAccount("account-creation-admin@example.test", "superadmin", true);
  const requestId = "c99c101e-b92d-4a33-8f3e-9e7d6dd17654";
  const body = {
    email: "created-by-admin@example.test",
    displayName: "Created User",
    role: "user",
  };
  const first = await invoke("/admin/users/create", body, admin.token, "POST", true, {
    "X-Request-Id": requestId,
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { success: true, uid: first.body.uid });
  const retry = await invoke("/admin/users/create", body, admin.token, "POST", true, {
    "X-Request-Id": requestId,
  });
  assert.deepEqual(retry.body, first.body);
  const createdUser = await adminAuth.getUser(first.body.uid);
  assert.equal(createdUser.customClaims.role, "user");
  assert.equal(JSON.stringify(first.body).toLowerCase().includes("password"), false);
  const profile = await invoke("/admin/users/get", { uid: first.body.uid }, admin.token);
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  assert.equal(profile.body.user.role, "user");
  assert.equal("customClaims" in profile.body.user, false);
  assert.equal("passwordHash" in profile.body.user, false);

  const reset = await invoke("/admin/users/password-reset", {
    uid: first.body.uid,
  }, admin.token);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.deepEqual(reset.body, { success: true });
});

test("enable, soft-delete, and bulk-disable actions update Auth state and audit", async () => {
  const admin = await createAccount("state-admin@example.test", "superadmin", true);
  const first = await createAccount("state-first@example.test");
  const second = await createAccount("state-second@example.test");
  const third = await createAccount("state-third@example.test");
  const revoke = await invoke("/admin/users/revoke-sessions", { uid: first.uid }, admin.token);
  assert.equal(revoke.status, 200);
  const disabled = await invoke("/admin/users/disable", {
    uid: first.uid,
    reason: "Temporary account block",
  }, admin.token);
  assert.equal(disabled.status, 200);
  const enabled = await invoke("/admin/users/enable", { uid: first.uid }, admin.token);
  assert.equal(enabled.status, 200);
  assert.equal((await adminAuth.getUser(first.uid)).disabled, false);

  const bulk = await invoke("/admin/users/bulk-disable", {
    uids: [first.uid, second.uid],
    reason: "Bulk security response",
  }, admin.token);
  assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
  assert.equal(bulk.body.disabledCount, 2);
  assert.equal((await adminAuth.getUser(first.uid)).disabled, true);
  assert.equal((await adminAuth.getUser(second.uid)).disabled, true);

  const deleted = await invoke("/admin/users/delete", {
    uid: second.uid,
    reason: "Remove test account",
  }, admin.token);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await adminAuth.getUser(second.uid)).disabled, true);
  assert.equal((await adminDb.collection("users").doc(second.uid).get()).get("deleted"), true);

  const hardDeleted = await invoke("/admin/users/delete", {
    uid: third.uid,
    reason: "Permanently remove test user",
    hardDelete: true,
  }, admin.token);
  assert.equal(hardDeleted.status, 200, JSON.stringify(hardDeleted.body));
  await assert.rejects(adminAuth.getUser(third.uid), { code: "auth/user-not-found" });
});

test("account deletion removes the caller's Auth user and profile data", async () => {
  const user = await createAccount("delete-me@example.test");
  assert.equal((await invoke("/register", { displayName: "Delete me" }, user.token)).status, 200);

  const response = await invoke("/account", {}, user.token, "DELETE");
  assert.equal(response.status, 200);
  await assert.rejects(adminAuth.getUser(user.uid), { code: "auth/user-not-found" });
  assert.equal((await adminDb.collection("users").doc(user.uid).get()).exists, false);
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

  const auditRead = await firestoreRequest("/auditLogs", user.token);
  assert.equal(auditRead.status, 403);
  const auditWrite = await firestoreRequest("/auditLogs?documentId=forged", user.token, {
    method: "POST",
    body: JSON.stringify({ fields: { action: { stringValue: "forged" } } }),
  });
  assert.equal(auditWrite.status, 403);
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
