import { showsBuyerContact } from "./stateMachine.js";

function iso(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : null;
}

const productFields = [
  "productId",
  "name",
  "variantId",
  "variant",
  "quantity",
  "unitPrice",
  "currency",
  "imagePath",
  "sellerId",
];

function mapItem(item) {
  return Object.fromEntries(productFields
    .filter((key) => item[key] !== undefined)
    .map((key) => [key, item[key]]));
}

export function toOrderDto(
  snapshotOrData,
  { buyerView = false, sellerView = false, privateData = null } = {},
) {
  const source = typeof snapshotOrData.data === "function"
    ? { id: snapshotOrData.id, ...snapshotOrData.data() }
    : snapshotOrData;
  const result = {
    id: source.id,
    orderGroupId: source.orderGroupId,
    orderNumber: source.orderNumber,
    status: source.status,
    paymentStatus: source.paymentStatus,
    payment: source.payment
      ? {
          method: source.payment.method,
          status: source.payment.status,
          provider: source.payment.provider ?? null,
          providerReference: source.payment.providerReference ?? null,
          collectedAt: iso(source.payment.collectedAt),
        }
      : undefined,
    items: Array.isArray(source.items) ? source.items.map(mapItem) : [],
    subtotal: source.subtotal,
    shippingFee: source.shippingFee,
    total: source.total,
    currency: source.currency,
    createdAt: iso(source.createdAt),
    updatedAt: iso(source.updatedAt),
    confirmedAt: iso(source.confirmedAt),
    deliveredAt: iso(source.deliveredAt),
    note: source.note ?? null,
    ...((buyerView || (sellerView && showsBuyerContact(source.status))) && privateData?.deliveryAddress
      ? { deliveryAddress: privateData.deliveryAddress }
      : {}),
    ...(source.pickupLocation ? { pickupLocation: source.pickupLocation } : {}),
    ...((buyerView || (sellerView && showsBuyerContact(source.status))) && privateData?.buyer
      ? { buyer: privateData.buyer }
      : {}),
    ...(source.statusReason ? { statusReason: source.statusReason } : {}),
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

export function toOrderGroupDto(group, subOrders) {
  return {
    id: group.id,
    createdAt: iso(group.createdAt),
    totalsByCurrency: group.totalsByCurrency,
    orders: subOrders.map((order) => toOrderDto(order)),
  };
}
