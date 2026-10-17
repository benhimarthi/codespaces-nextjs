import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
const projectId = process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT;

if (!email || !projectId) {
  throw new Error("Set SUPERADMIN_EMAIL and FIREBASE_PROJECT_ID before running this script.");
}

const app = getApps().length ? getApp() : initializeApp({ projectId });
const auth = getAuth(app);
const db = getFirestore(app, "ai-studio-1a058e78-fda1-403c-bc1b-85c0814c2690");

let pageToken;
let existingSuperadmin;
do {
  const page = await auth.listUsers(1000, pageToken);
  existingSuperadmin = page.users.find(
    (user) => user.customClaims?.role === "superadmin" && user.email !== email,
  );
  pageToken = page.pageToken;
} while (!existingSuperadmin && pageToken);

if (existingSuperadmin) {
  throw new Error("A different superadmin already exists; bootstrap is one-time only.");
}

const user = await auth.getUserByEmail(email);
const profileRef = db.collection("users").doc(user.uid);
await db.runTransaction(async (transaction) => {
  const profile = await transaction.get(profileRef);
  transaction.set(profileRef, {
    ...(user.displayName ? { displayName: user.displayName } : {}),
    role: "superadmin",
    disabled: user.disabled,
    ...(!profile.exists ? { createdAt: FieldValue.serverTimestamp() } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
});
await auth.setCustomUserClaims(user.uid, { role: "superadmin" });
await auth.revokeRefreshTokens(user.uid);

console.log(`Bootstrapped superadmin ${user.uid} in ${projectId}.`);
