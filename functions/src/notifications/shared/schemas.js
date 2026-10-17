import { z } from "zod";

const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const phone = z.string().trim().regex(/^\+[1-9]\d{7,14}$/);

export const emptySchema = z.object({}).strict();
export const deviceTokenSchema = z.object({
  token: z.string().trim().min(16).max(4096),
  platform: z.enum(["ios", "android", "web"]),
}).strict();
export const notificationPageSchema = z.object({
  pageSize: z.number().int().min(1).max(50).optional(),
  pageToken: id.optional(),
  unreadOnly: z.boolean().optional(),
}).strict();
export const notificationIdSchema = z.object({ notificationId: id }).strict();
export const preferencesSchema = z.object({
  language: z.enum(["fr", "ar", "en"]).optional(),
  categories: z.object({
    orderUpdates: z.object({
      whatsapp: z.boolean().optional(),
      fcm: z.boolean().optional(),
      email: z.boolean().optional(),
    }).strict().optional(),
    promotions: z.object({
      whatsapp: z.boolean().optional(),
      fcm: z.boolean().optional(),
      email: z.boolean().optional(),
    }).strict().optional(),
  }).strict().optional(),
  marketingOptIn: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
export const linkPhoneSchema = z.object({
  phoneNumber: phone,
  consent: z.literal(true),
}).strict();
export const confirmLinkSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
}).strict();
export const inboundMessageSchema = z.object({
  fromPhone: phone,
  messageId: z.string().trim().min(1).max(256),
  text: z.string().trim().min(1).max(500),
  timestamp: z.number().int().positive(),
}).strict();

