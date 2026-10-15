import { z } from "zod";

export const emptyInputSchema = z.object({}).strict();

export const registerUserSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
}).strict();

export const setUserRoleSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  role: z.enum(["admin", "user"]),
}).strict();
