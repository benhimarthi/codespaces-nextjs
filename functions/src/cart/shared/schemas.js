import { z } from "zod";
import { orderConfig } from "../../orders/shared/config.js";

const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const variantId = id.nullable().optional();
const quantity = z.number().int().min(1).max(orderConfig.maxQuantity);

export const addToCartSchema = z.object({
  productId: id,
  variantId,
  quantity,
}).strict();

export const updateCartItemSchema = z.object({
  productId: id,
  variantId,
  quantity,
}).strict();

export const removeFromCartSchema = z.object({
  productId: id,
  variantId,
}).strict();

export const emptyCartSchema = z.object({}).strict();

export const getMyCartSchema = z.object({
  knownPrices: z.array(z.object({
    productId: id,
    variantId,
    price: z.number().int().nonnegative(),
    currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  }).strict()).max(orderConfig.maxCartItems).optional(),
}).strict();
