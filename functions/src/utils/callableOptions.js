const projectId =
  process.env.GCLOUD_PROJECT ??
  process.env.FIREBASE_PROJECT_ID ??
  "your-firebase-project-id";

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (
  allowedOrigins.length === 0 ||
  allowedOrigins.some((origin) => {
    try {
      const parsed = new URL(origin);
      return !["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin;
    } catch {
      return true;
    }
  })
) {
  throw new Error("ALLOWED_ORIGINS must contain exact HTTP(S) origins.");
}

const serviceAccounts = {
  registerUser: "auth-register-user",
  setUserRole: "auth-set-user-role",
  getMyProfile: "auth-get-my-profile",
  deleteMyAccount: "auth-delete-my-account",
};

export function callableOptions(name) {
  return {
    region: "us-central1",
    enforceAppCheck: true,
    cors: allowedOrigins,
    maxInstances: 10,
    timeoutSeconds: 30,
    memory: "256MiB",
    serviceAccount: `${serviceAccounts[name]}@${projectId}.iam.gserviceaccount.com`,
  };
}
