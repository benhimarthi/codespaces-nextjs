const projectId =
  process.env.GCLOUD_PROJECT ??
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

export function authServiceOptions() {
  return {
    region: "us-central1",
    invoker: "public",
    cors: allowedOrigins,
    maxInstances: 3,
    timeoutSeconds: 30,
    memory: "256MiB",
    serviceAccount: `auth-service@${projectId}.iam.gserviceaccount.com`,
  };
}
