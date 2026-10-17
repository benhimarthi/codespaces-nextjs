const projectId = process.env.GCLOUD_PROJECT ?? "your-firebase-project-id";

export const notificationTriggerOptions = Object.freeze({
  region: "us-central1",
  maxInstances: 5,
  timeoutSeconds: 60,
  memory: "256MiB",
  serviceAccount: `store-notifications@${projectId}.iam.gserviceaccount.com`,
});
