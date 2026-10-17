import { authServiceOptions } from "../utils/authServiceOptions.js";
import { createModuleService } from "../utils/moduleService.js";
import {
  confirmWhatsAppLinkOperation,
} from "./callable/confirmWhatsAppLink.js";
import { getMyNotificationsOperation } from "./callable/getMyNotifications.js";
import { linkWhatsAppNumberOperation } from "./callable/linkWhatsAppNumber.js";
import { markAllAsReadOperation } from "./callable/markAllAsRead.js";
import { markAsReadOperation } from "./callable/markAsRead.js";
import { registerDeviceTokenOperation } from "./callable/registerDeviceToken.js";
import { unlinkWhatsAppNumberOperation } from "./callable/unlinkWhatsAppNumber.js";
import { unregisterDeviceTokenOperation } from "./callable/unregisterDeviceToken.js";
import {
  updateNotificationPreferencesOperation,
} from "./callable/updateNotificationPreferences.js";

const projectId = process.env.GCLOUD_PROJECT ?? "your-firebase-project-id";
const notificationServiceOptions = Object.freeze({
  region: "us-central1",
  invoker: "public",
  cors: authServiceOptions().cors,
  maxInstances: 5,
  timeoutSeconds: 60,
  memory: "256MiB",
  serviceAccount: `store-notifications@${projectId}.iam.gserviceaccount.com`,
});

export const notificationService = createModuleService(
  "notifications",
  notificationServiceOptions,
  [
    ["POST /notifications/device/register", registerDeviceTokenOperation],
    ["POST /notifications/device/unregister", unregisterDeviceTokenOperation],
    ["POST /notifications/list", getMyNotificationsOperation],
    ["POST /notifications/read", markAsReadOperation],
    ["POST /notifications/read-all", markAllAsReadOperation],
    ["POST /notifications/preferences", updateNotificationPreferencesOperation],
    ["POST /notifications/whatsapp/link", linkWhatsAppNumberOperation],
    ["POST /notifications/whatsapp/confirm-link", confirmWhatsAppLinkOperation],
    ["POST /notifications/whatsapp/unlink", unlinkWhatsAppNumberOperation],
  ],
);
