const rawThresholds = process.env.NOTIFICATION_HIGH_VALUE_THRESHOLDS ??
  '{"MAD":1000000}';
let thresholds;
try {
  thresholds = JSON.parse(rawThresholds);
} catch {
  throw new Error("NOTIFICATION_HIGH_VALUE_THRESHOLDS must be a JSON object.");
}
if (
  thresholds === null ||
  Array.isArray(thresholds) ||
  typeof thresholds !== "object" ||
  Object.values(thresholds).some((amount) => !Number.isSafeInteger(amount) || amount < 1)
) {
  throw new Error("NOTIFICATION_HIGH_VALUE_THRESHOLDS must map currencies to positive integer minor units.");
}

export const highValueThresholds = Object.freeze(thresholds);
