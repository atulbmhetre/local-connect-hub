import type { NavigateFunction } from "react-router-dom";
import { captureError } from "@/lib/sentry";

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

export function isKnownNotificationRoute(route: string | null | undefined): boolean {
  if (!route?.trim()) return false;
  const key = route.trim().replace(/^\//, "");
  return Object.prototype.hasOwnProperty.call(ROUTE_PATHS, key);
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
    navigate(path, {
      state: {
        highlightVendorId: params.vendor_id,
        ...(params.open_reviews === "1" || params.open_reviews === "true"
          ? { vendorSettingsTab: "preferences", openVendorReviews: true }
          : {}),
      },
    });
    return;
  }
  if (key === "settings" && (params.open_reviews === "1" || params.open_reviews === "true")) {
    navigate(path, {
      state: { vendorSettingsTab: "preferences", openVendorReviews: true },
    });
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

/** Query used by the Web Push service-worker click handler. */
export function buildPushClickPath(data: Record<string, unknown> | undefined): string {
  if (!data) return "/";
  const route = typeof data.route === "string" ? data.route.trim() : "";
  const params = new URLSearchParams();
  if (route) params.set("push_route", route);
  const routeParams = data.route_params;
  if (typeof routeParams === "string" && routeParams.trim()) {
    params.set("push_route_params", routeParams);
  } else if (routeParams && typeof routeParams === "object" && !Array.isArray(routeParams)) {
    params.set("push_route_params", JSON.stringify(routeParams));
  }
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

export function pushDataFromSearchParams(
  search: string,
): Record<string, unknown> | undefined {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const route = params.get("push_route");
  if (!route?.trim()) return undefined;
  const data: Record<string, unknown> = { route };
  const routeParams = params.get("push_route_params");
  if (routeParams) data.route_params = routeParams;
  return data;
}

export function handlePushNotificationData(
  navigate: NavigateFunction,
  data: Record<string, unknown> | undefined,
): void {
  if (!data) return;
  const route = typeof data.route === "string" ? data.route : undefined;
  if (!route?.trim()) {
    captureError(new Error("push_nav_missing_route"), {
      pushSurface: "navigation",
      operation: "handlePushNotificationData",
      reason: "missing_route",
      dataKeys: Object.keys(data),
    });
    return;
  }
  if (!isKnownNotificationRoute(route)) {
    captureError(new Error("push_nav_unresolvable_route"), {
      pushSurface: "navigation",
      operation: "handlePushNotificationData",
      reason: "unresolvable_route",
      route,
    });
    return;
  }
  const params = parsePushRouteParams(
    typeof data.route_params === "string"
      ? data.route_params
      : (data.route_params as Record<string, string> | undefined),
  );
  navigateFromNotification(navigate, route, params);
}
