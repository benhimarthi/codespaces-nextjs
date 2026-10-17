import { createModuleService } from "../utils/moduleService.js";
import { ordersServiceOptions } from "./shared/options.js";
import { cancelMyOrder } from "./cancelMyOrder.js";
import { createOrder } from "./createOrder.js";
import { getMyOrders } from "./getMyOrders.js";
import { getOrderById } from "./getOrderById.js";
import { cancelSellerOrder } from "./seller/cancelOrder.js";
import { confirmOrder } from "./seller/confirmOrder.js";
import { getSellerOrders } from "./seller/getSellerOrders.js";
import { markDelivered } from "./seller/markDelivered.js";
import { markFailedDelivery } from "./seller/markFailedDelivery.js";
import { markOutForDelivery } from "./seller/markOutForDelivery.js";
import { markProcessing } from "./seller/markProcessing.js";
import { markReadyForPickup } from "./seller/markReadyForPickup.js";
import { rejectOrder } from "./seller/rejectOrder.js";
import { forceCancelOrder } from "./admin/forceCancelOrder.js";
import { listOrders } from "./admin/listOrders.js";
import { resolveDispute } from "./admin/resolveDispute.js";

export const ordersService = createModuleService("orders", ordersServiceOptions, [
  ["POST /orders/create", createOrder],
  ["POST /orders/cancel", cancelMyOrder],
  ["POST /orders/mine", getMyOrders],
  ["POST /orders/get", getOrderById],
  ["POST /seller/orders/list", getSellerOrders],
  ["POST /seller/orders/confirm", confirmOrder],
  ["POST /seller/orders/processing", markProcessing],
  ["POST /seller/orders/reject", rejectOrder],
  ["POST /seller/orders/out-for-delivery", markOutForDelivery],
  ["POST /seller/orders/ready-for-pickup", markReadyForPickup],
  ["POST /seller/orders/delivered", markDelivered],
  ["POST /seller/orders/failed-delivery", markFailedDelivery],
  ["POST /seller/orders/cancel", cancelSellerOrder],
  ["POST /admin/orders/list", listOrders],
  ["POST /admin/orders/force-cancel", forceCancelOrder],
  ["POST /admin/orders/resolve-dispute", resolveDispute],
]);
