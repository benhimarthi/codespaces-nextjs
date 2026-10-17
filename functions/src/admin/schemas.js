import { z } from "zod";

const uid = z.string().trim().min(1).max(128);
const reason = z.string().trim().min(10).max(1000);
const date = z.string().datetime({ offset: true });

export const listUsersSchema = z.object({
  pageToken: z.string().max(2048).optional(),
  maxResults: z.number().int().min(1).max(100).default(100),
  role: z.enum(["user", "admin", "superadmin"]).optional(),
  disabled: z.boolean().optional(),
  createdAtStart: date.optional(),
  createdAtEnd: date.optional(),
}).strict().refine(
  (input) => !input.createdAtStart || !input.createdAtEnd ||
    new Date(input.createdAtStart) <= new Date(input.createdAtEnd),
);

export const getUserByIdSchema = z.object({ uid }).strict();

export const setUserRoleSchema = z.object({
  uid,
  role: z.enum(["user", "admin", "superadmin"]),
  reason,
}).strict();

export const disableUserSchema = z.object({ uid, reason }).strict();
export const enableUserSchema = z.object({ uid }).strict();
export const revokeUserSessionsSchema = z.object({ uid }).strict();

export const deleteUserSchema = z.object({
  uid,
  reason,
  hardDelete: z.boolean().default(false),
}).strict();

export const createUserByAdminSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  displayName: z.string().trim().min(1).max(80),
  role: z.enum(["user", "admin", "superadmin"]),
}).strict();

export const generatePasswordResetLinkSchema = z.object({ uid }).strict();

export const getAuditLogsSchema = z.object({
  pageToken: z.string().max(1500).optional(),
  maxResults: z.number().int().min(1).max(100).default(100),
  actorUid: uid.optional(),
  targetUid: uid.optional(),
  action: z.string().trim().min(1).max(100).optional(),
  startAt: date.optional(),
  endAt: date.optional(),
}).strict().refine(
  (input) => !input.startAt || !input.endAt ||
    new Date(input.startAt) <= new Date(input.endAt),
);

export const bulkDisableUsersSchema = z.object({
  uids: z.array(uid).min(1).max(50).refine((uids) => new Set(uids).size === uids.length),
  reason,
}).strict();

export const legacySetUserRoleSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  role: z.enum(["user", "admin", "superadmin"]),
  reason,
}).strict();
