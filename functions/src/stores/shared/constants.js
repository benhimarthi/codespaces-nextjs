export const STORE_STATUSES = Object.freeze([
  "draft",
  "pending_verification",
  "active",
  "rejected",
  "suspended",
  "closed",
]);

export const MAX_DELIVERY_CITIES = 20;
export const MAX_PICKUP_LOCATIONS = 5;
export const MAX_VERIFICATION_DOCUMENTS = 4;
export const MAX_VERIFICATION_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const VERIFICATION_RETENTION_DAYS = 90;
export const MIN_COMMISSION_BPS = 0;
export const MAX_COMMISSION_BPS = 5000;
export const STORE_RESUBMISSION_LIMIT = 3;

export const storeFunctionOptions = Object.freeze({
  region: "us-central1",
  cors: true,
  maxInstances: 3,
  timeoutSeconds: 60,
  memory: "256MiB",
  serviceAccount: `store-stores@${process.env.GCLOUD_PROJECT ?? "your-firebase-project-id"}.iam.gserviceaccount.com`,
});

export const storeAdminFunctionOptions = Object.freeze({
  ...storeFunctionOptions,
  maxInstances: 1,
  serviceAccount: `store-admin-stores@${process.env.GCLOUD_PROJECT ?? "your-firebase-project-id"}.iam.gserviceaccount.com`,
});

export const storeScheduledOptions = Object.freeze({
  region: "us-central1",
  schedule: "every 60 minutes",
  timeZone: "UTC",
  maxInstances: 1,
  timeoutSeconds: 540,
  memory: "512MiB",
  serviceAccount: `store-store-scheduler@${process.env.GCLOUD_PROJECT ?? "your-firebase-project-id"}.iam.gserviceaccount.com`,
});
