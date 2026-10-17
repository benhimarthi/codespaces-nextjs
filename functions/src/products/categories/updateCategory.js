import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../../utils/firebase.js";
import { runAdmin } from "../shared/operations.js";
import { updateCategorySchema } from "../shared/schemas.js";
import { deactivateCategory, updateCategoryTransaction } from "./categoryService.js";
import { toCategoryDto } from "../shared/mappers.js";

export async function updateCategoryOperation(request) {
  return runAdmin(request, "updateCategory", updateCategorySchema, async (input, caller) => {
    if (input.active === false) {
      const current = await db.collection("categories").doc(input.categoryId).get();
      if (!current.exists) throw new HttpsError("not-found", "Category not found.");
      if (input.name !== undefined || input.parentId !== undefined) {
        await updateCategoryTransaction(
          request,
          { ...input, active: undefined },
          caller,
        );
      }
      return deactivateCategory(request, caller, input.categoryId, "category_deactivate");
    }
    await updateCategoryTransaction(request, input, caller);
    const saved = await db.collection("categories").doc(input.categoryId).get();
    if (!saved.exists) throw new HttpsError("internal", "Unable to complete the request.");
    return { category: toCategoryDto(saved) };
  });
}
