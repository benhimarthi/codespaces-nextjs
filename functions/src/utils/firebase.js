import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { firestoreDatabaseId } from "./firestoreDatabase.js";

const app = getApps().length > 0 ? getApp() : initializeApp();

export const auth = getAuth(app);
export const db = getFirestore(app, firestoreDatabaseId);
