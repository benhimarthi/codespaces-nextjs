export const MAX_PRICE = 100_000_000;
export const MAX_STOCK = 1_000_000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PENDING_PRODUCTS = 5;
export const MAX_ACTIVE_PRODUCTS = 100;
export const NEW_ACCOUNT_AGE_DAYS = 7;
export const NEW_ACCOUNT_RATE_FACTOR = 0.5;
export const NEW_ACCOUNT_PENDING_LIMIT = 2;
export const NEW_ACCOUNT_ACTIVE_LIMIT = 10;
export const CURRENCIES = ["MAD", "EUR", "XOF", "USD", "GBP"];
export const PRODUCT_STATUSES = [
  "draft",
  "pending_review",
  "active",
  "rejected",
  "archived",
];
export const IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"];

export const ratePolicies = Object.freeze({
  createProduct: { perUid: 10, perIp: 30, windowSeconds: 3600 },
  updateProduct: { perUid: 30, perIp: 90, windowSeconds: 3600 },
  archiveProduct: { perUid: 20, perIp: 60, windowSeconds: 3600 },
  getMyProducts: { perUid: 120, perIp: 240, windowSeconds: 3600 },
  submitForReview: { perUid: 10, perIp: 30, windowSeconds: 3600 },
  createCategory: { perUid: 10, perIp: 30, windowSeconds: 3600 },
  updateCategory: { perUid: 20, perIp: 60, windowSeconds: 3600 },
  setCategoryActive: { perUid: 10, perIp: 30, windowSeconds: 3600 },
  approveProduct: { perUid: 60, perIp: 120, windowSeconds: 3600 },
  rejectProduct: { perUid: 60, perIp: 120, windowSeconds: 3600 },
});
