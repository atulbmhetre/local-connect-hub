import type { NavigateFunction } from "react-router-dom";

const ROUTE_PATHS: Record<string, string> = {
  vendor: "/vendor",
  "my-orders": "/my-orders",
  orders: "/my-orders",
  settings: "/settings",
  feed: "/feed",
  radar: "/radar",
};

export function resolveRoutePath(route: string | null | undefined): string {
  if (!route?.trim()) return "/";
  const key = route.trim().replace(/^\//, "");
  return ROUTE_PATHS[key] ?? `/${key}`;
}

export type NotificationRouteParams = Record<string, string> | null | undefined;

export function navigateFromNotification(
  navigate: NavigateFunction,
  route: string | null | undefined,
  routeParams?: NotificationRouteParams,
): void {
  const path = resolveRoutePath(route);
  const key = route?.trim().replace(/^\//, "") ?? "";
  const params = routeParams ?? {};

  if (key === "my-orders" && params.order_id) {
    navigate(path, { state: { highlightOrderId: params.order_id } });
    return;
  }
  if ((key === "my-orders" || key === "orders") && params.request_id) {
    navigate(path, { state: { highlightOrderId: params.request_id } });
    return;
  }
  if (key === "vendor" && params.order_id) {
    navigate(path, { state: { highlightOrderId: params.order_id } });
    return;
  }
  if (key === "vendor" && params.vendor_id) {
    navigate(path, { state: { highlightVendorId: params.vendor_id } });
    return;
  }
  if (key === "settings" && params.vendor_id) {
    navigate(path, { state: { highlightVendorId: params.vendor_id } });
    return;
  }
  if (key === "feed") {
    navigate(path, {
      state: params.post_id ? { highlightPostId: params.post_id } : undefined,
    });
    return;
  }
  if (key === "radar" && params.vendor_id) {
    navigate(path, { state: { highlightVendorId: params.vendor_id } });
    return;
  }
  if (key === "vendor") {
    navigate(path);
    return;
  }
  navigate(path);
}

export function parsePushRouteParams(
  raw: string | Record<string, string> | undefined | null,
): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
  } catch {
    /* ignore malformed payload */
  }
  return {};
}

export function handlePushNotificationData(
  navigate: NavigateFunction,
  data: Record<string, unknown> | undefined,
): void {
  if (!data || data.type === "location_ping") return;
  const route = typeof data.route === "string" ? data.route : undefined;
  if (!route) return;
  const params = parsePushRouteParams(
    typeof data.route_params === "string"
      ? data.route_params
      : (data.route_params as Record<string, string> | undefined),
  );
  navigateFromNotification(navigate, route, params);
}
