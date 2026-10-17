import { createModuleService } from "../utils/moduleService.js";
import { addToCart } from "./addToCart.js";
import { clearCart } from "./clearCart.js";
import { getMyCart } from "./getMyCart.js";
import { removeFromCart } from "./removeFromCart.js";
import { updateCartItem } from "./updateCartItem.js";
import { cartServiceOptions } from "../orders/shared/options.js";

export const cartService = createModuleService("cart", cartServiceOptions, [
  ["POST /cart/add", addToCart],
  ["POST /cart/update", updateCartItem],
  ["POST /cart/remove", removeFromCart],
  ["POST /cart/get", getMyCart],
  ["POST /cart/clear", clearCart],
]);
