import { routeFor } from "../shared/config.js";

export function channelChain(eventType) {
  const route = routeFor(eventType);
  return [route.primary, ...route.fallback];
}

export function isCritical(eventType) {
  return routeFor(eventType).critical;
}
