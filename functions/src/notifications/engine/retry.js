import { notificationLimits } from "../shared/config.js";

export function nextRetryAt(attempt) {
  const delay = Math.min(
    notificationLimits.retryBaseMs * (2 ** Math.max(0, attempt - 1)),
    notificationLimits.retryMaxMs,
  );
  return new Date(Date.now() + delay);
}
