import { z } from "zod";
import { CURRENCIES, MAX_PRICE, MAX_STOCK, PRODUCT_STATUSES } from "./constants.js";

const plainText = (maximum) => z.string()
  .trim()
  .max(maximum)
  .refine((value) => !/<\/?[a-z][\s\S]*?>/i.test(value), "HTML is not allowed.");

const attributeText = plainText(40).pipe(z.string().min(1));
const skuSchema = z.string().trim().min(1).max(64)
  .regex(/^[A-Za-z0-9._-]+$/);
const documentIdSchema = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const dimensionsSchema = z.object({
  lengthMm: z.number().int().min(1).max(10_000),
  widthMm: z.number().int().min(1).max(10_000),
  heightMm: z.number().int().min(1).max(10_000),
}).strict();

const variantSchema = z.object({
  attributes: z.record(attributeText, attributeText)
    .refine((attributes) => Object.keys(attributes).length >= 1 &&
      Object.keys(attributes).length <= 8),
  price: z.number().int().min(1).max(MAX_PRICE),
  stock: z.number().int().min(0).max(MAX_STOCK),
  sku: skuSchema.optional(),
}).strict();

const productFieldsBaseSchema = z.object({
  name: plainText(120).pipe(z.string().min(3)),
  description: plainText(5000),
  price: z.number().int().min(1).max(MAX_PRICE),
  currency: z.enum(CURRENCIES),
  categoryId: documentIdSchema,
  subCategoryId: documentIdSchema,
  images: z.array(z.string().trim().min(1).max(512)).min(1).max(8),
  stock: z.number().int().min(0).max(MAX_STOCK),
  sku: skuSchema.optional(),
  brand: plainText(80).optional(),
  tags: z.array(plainText(30).pipe(z.string().min(1))).max(10).optional(),
  compareAtPrice: z.number().int().min(1).max(MAX_PRICE).optional(),
  weightGrams: z.number().int().min(1).max(100_000).optional(),
  dimensions: dimensionsSchema.optional(),
  condition: z.enum(["new", "used"]).optional(),
  variants: z.array(variantSchema).max(50).optional(),
}).strict();

function validateProductValues(product, context) {
  if (
    product.compareAtPrice !== undefined &&
    product.price !== undefined &&
    product.compareAtPrice <= product.price
  ) {
    context.addIssue({
      code: "custom",
      path: ["compareAtPrice"],
      message: "compareAtPrice must be greater than price.",
    });
  }
  const combinations = new Set();
  const skus = new Set(product.sku ? [product.sku.toLowerCase()] : []);
  for (const [index, variant] of (product.variants ?? []).entries()) {
    const combination = JSON.stringify(
      Object.entries(variant.attributes).sort(([left], [right]) => left.localeCompare(right)),
    );
    if (combinations.has(combination)) {
      context.addIssue({
        code: "custom",
        path: ["variants", index, "attributes"],
        message: "Variant attribute combinations must be unique.",
      });
    }
    combinations.add(combination);
    if (variant.sku) {
      const normalizedSku = variant.sku.toLowerCase();
      if (skus.has(normalizedSku)) {
        context.addIssue({
          code: "custom",
          path: ["variants", index, "sku"],
          message: "Product and variant SKUs must be unique.",
        });
      }
      skus.add(normalizedSku);
    }
  }
}

export const productFieldsSchema = productFieldsBaseSchema.superRefine(validateProductValues);

export const createProductSchema = productFieldsBaseSchema.extend({
  requestId: z.string().uuid(),
  submitForReview: z.boolean().optional(),
}).strict().superRefine(validateProductValues);

export const updateProductSchema = productFieldsBaseSchema.partial().extend({
  productId: z.string().trim().min(1).max(128),
  expectedVersion: z.number().int().min(1),
}).strict().superRefine((input, context) => {
  validateProductValues(input, context);
  const editableFields = Object.keys(input).filter(
    (key) => key !== "productId" && key !== "expectedVersion",
  );
  if (editableFields.length === 0) {
    context.addIssue({ code: "custom", message: "At least one product field is required." });
  }
  if (
    input.price !== undefined &&
    input.compareAtPrice !== undefined &&
    input.compareAtPrice <= input.price
  ) {
    context.addIssue({ code: "custom", path: ["compareAtPrice"], message: "Invalid price." });
  }
});

export const productIdSchema = z.object({
  productId: documentIdSchema,
}).strict();

export const myProductsSchema = z.object({
  pageToken: documentIdSchema.optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
}).strict();

export const createCategorySchema = z.object({
  name: plainText(80).pipe(z.string().min(2)),
  parentId: documentIdSchema.optional(),
  active: z.boolean().optional(),
}).strict();

export const updateCategorySchema = z.object({
  categoryId: documentIdSchema,
  name: plainText(80).pipe(z.string().min(2)).optional(),
  parentId: documentIdSchema.nullable().optional(),
  active: z.boolean().optional(),
}).strict().refine(
  ({ name, parentId, active }) =>
    name !== undefined || parentId !== undefined || active !== undefined,
  { message: "At least one category field is required." },
);

export const setCategoryActiveSchema = z.object({
  categoryId: documentIdSchema,
  active: z.boolean(),
}).strict();

export const moderationSchema = z.object({
  productId: documentIdSchema,
}).strict();

export const rejectProductSchema = moderationSchema.extend({
  reason: plainText(1000).pipe(z.string().min(10)),
}).strict();
