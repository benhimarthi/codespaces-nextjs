import { z } from "zod";
import {
  MAX_DELIVERY_CITIES,
  MAX_PICKUP_LOCATIONS,
  MAX_VERIFICATION_DOCUMENTS,
} from "./constants.js";

const plainText = (max, min = 0) => z.string()
  .trim()
  .min(min)
  .max(max)
  .refine((value) => !/<\/?[a-z][\s\S]*?>/i.test(value), "HTML is not allowed.");
const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const path = z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9/_ .-]+$/);
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);

const pickupLocation = z.object({
  name: plainText(100, 2),
  address: plainText(300, 5),
  city: plainText(80, 2),
}).strict();

const openingHours = z.record(
  z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
  z.array(z.object({
    open: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    close: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  }).strict()).max(2),
).optional();

export const storeFieldsSchema = z.object({
  name: plainText(80, 3),
  description: plainText(1000),
  logoPath: path.nullable().optional(),
  bannerPath: path.nullable().optional(),
  contactPhone: phone,
  city: plainText(80, 2),
  address: plainText(300, 5),
  pickupLocations: z.array(pickupLocation).max(MAX_PICKUP_LOCATIONS),
  deliveryCities: z.array(plainText(80, 2)).max(MAX_DELIVERY_CITIES),
  openingHours,
  categories: z.array(id).min(1).max(10),
}).strict();

export const createStoreApplicationSchema = storeFieldsSchema.partial().strict()
  .extend({ name: plainText(80, 3) }).strict();

export const updateMyStoreSchema = storeFieldsSchema.partial().strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");

export const emptyInputSchema = z.object({}).strict();
export const reasonSchema = z.object({
  storeId: id,
  reason: plainText(500, 10),
}).strict();
export const storeIdSchema = z.object({ storeId: id }).strict();
export const pagedStoreSchema = z.object({
  pageToken: id.optional(),
  pageSize: z.number().int().min(1).max(50).default(25),
  status: z.enum(["draft", "pending_verification", "active", "rejected", "suspended", "closed"]).optional(),
  sortBy: z.enum(["createdAt", "updatedAt", "name", "status"]).default("createdAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
}).strict();
export const commissionSchema = z.object({
  storeId: id,
  commissionRateBps: z.number().int().min(0).max(5000),
  reason: plainText(500, 10),
}).strict();
export const uploadUrlSchema = z.object({
  documentType: z.enum(["id_card", "proof_of_address", "business_registration", "optional"]),
  contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
  sizeBytes: z.number().int().min(1).max(10 * 1024 * 1024),
}).strict();
export const verificationDocumentSchema = z.object({
  storeId: id,
  documentId: id,
}).strict();
export const storeSlugSchema = z.object({ slug: id }).strict();

export function validateStoreFields(value) {
  return storeFieldsSchema.parse(value);
}

export function isStoreFieldsComplete(value) {
  const result = storeFieldsSchema.safeParse(value);
  return result.success;
}

export { MAX_VERIFICATION_DOCUMENTS };
