import { createHash } from "node:crypto";

export function productVariantId(variant) {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(variant.attributes ?? {})
      .sort(([left], [right]) => left.localeCompare(right))))
    .digest("hex");
}
