import { authServiceOptions } from "../../utils/authServiceOptions.js";

const projectId = process.env.GCLOUD_PROJECT ?? "your-firebase-project-id";
const cors = authServiceOptions().cors;

function groupOptions(group, maxInstances, timeoutSeconds, memory) {
  return {
    region: "us-central1",
    invoker: "public",
    cors,
    maxInstances,
    timeoutSeconds,
    memory,
    serviceAccount: `store-${group}@${projectId}.iam.gserviceaccount.com`,
  };
}

export const cartServiceOptions = groupOptions("cart", 5, 30, "256MiB");
export const ordersServiceOptions = groupOptions("orders", 1, 60, "512MiB");
export const scheduledOrderOptions = Object.freeze({
  region: "us-central1",
  schedule: "every 15 minutes",
  timeZone: "UTC",
  maxInstances: 1,
  timeoutSeconds: 120,
  memory: "256MiB",
  serviceAccount: `store-order-scheduler@${projectId}.iam.gserviceaccount.com`,
});
