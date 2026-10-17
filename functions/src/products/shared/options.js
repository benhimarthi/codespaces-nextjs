import { authServiceOptions } from "../../utils/authServiceOptions.js";

const projectId = process.env.GCLOUD_PROJECT ?? "your-firebase-project-id";
const origins = authServiceOptions().cors;

export function productServiceOptions() {
  return {
    region: "us-central1",
    invoker: "public",
    cors: origins,
    maxInstances: 3,
    timeoutSeconds: 120,
    memory: "512MiB",
    serviceAccount: `product-service@${projectId}.iam.gserviceaccount.com`,
  };
}
