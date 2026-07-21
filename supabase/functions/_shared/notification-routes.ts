/** Build FCM data map (string values only) with optional deep-link route. */
export function buildFcmData(
  payload: Record<string, unknown>,
  title: string,
  body: string,
): Record<string, string> {
  const data: Record<string, string> = {
    title: String(title),
    body: String(body),
  };

  let route =
    typeof payload.route === "string" && payload.route.trim()
      ? payload.route.trim()
      : undefined;
  let routeParams =
    payload.route_params && typeof payload.route_params === "object"
      ? (payload.route_params as Record<string, unknown>)
      : undefined;

  const type = String(payload.type ?? "").trim();
  const orderId = String(
    payload.order_id ?? payload.request_id ?? "",
  ).trim();
  const postId = String(payload.post_id ?? "").trim();
  const vendorId = String(payload.vendor_id ?? "").trim();

  if (!route && type) {
    if (type.startsWith("feed_") && postId) {
      route = "feed";
      routeParams = { post_id: postId };
    } else if (
      type === "order_accepted" ||
      type === "order_update" ||
      type === "order_expired" ||
      type.startsWith("order_near_deadline_") ||
      type === "bill"
    ) {
      route = "my-orders";
      if (orderId) routeParams = { order_id: orderId };
    } else if (type === "payment_claimed") {
      route = "vendor";
      if (orderId) routeParams = { order_id: orderId };
    } else if (type === "payment_confirmed" || type === "payment_disputed") {
      route = "my-orders";
      if (orderId) routeParams = { order_id: orderId };
    } else if (
      type === "new_order" ||
      (type === "order_update" && orderId)
    ) {
      route = "vendor";
      if (orderId) routeParams = { order_id: orderId };
    } else if (
      type === "account_verified" ||
      type === "account_unverified" ||
      type === "referral_credit"
    ) {
      route = "vendor";
      if (vendorId) routeParams = { vendor_id: vendorId };
    } else if (
      type === "account_warning" ||
      type === "account_banned" ||
      type === "account_restored"
    ) {
      route = "settings";
    } else if (type === "new_vendor" || type === "vendor_edited") {
      route = "settings";
      if (vendorId) routeParams = { vendor_id: vendorId };
    }
  }

  if (!route && orderId) {
    route = "my-orders";
    routeParams = { order_id: orderId };
  }

  if (route) {
    data.route = route;
    if (routeParams) {
      const normalized: Record<string, string> = {};
      for (const [key, value] of Object.entries(routeParams)) {
        if (value != null && String(value).trim()) {
          normalized[key] = String(value);
        }
      }
      if (Object.keys(normalized).length > 0) {
        data.route_params = JSON.stringify(normalized);
      }
    }
    if (type) data.type = type;
  }

  return data;
}

/** Vendor-side route mapping from notify-vendor record payload. */
export function buildVendorFcmData(
  record: Record<string, unknown>,
  vendorId: string,
  title: string,
  body: string,
): Record<string, string> {
  const orderId = String(record.request_id ?? record.order_id ?? "").trim();
  const type = String(record.type ?? "").trim();

  let route =
    typeof record.route === "string" && record.route.trim()
      ? record.route.trim()
      : undefined;
  let routeParams =
    record.route_params && typeof record.route_params === "object"
      ? (record.route_params as Record<string, unknown>)
      : undefined;

  const categoryId = String(record.category_id ?? "").trim();

  if (!route) {
    if (
      (type === "payment_claimed" || type === "payment_confirmed") &&
      orderId
    ) {
      route = "vendor";
      routeParams = { order_id: orderId };
    } else if (type === "new_order" || (type === "order_update" && orderId) || orderId) {
      route = "vendor";
      if (orderId) routeParams = { order_id: orderId };
    } else if (
      type === "account_verified" ||
      type === "account_unverified" ||
      type === "referral_credit" ||
      type === "account_banned" ||
      type === "account_restored"
    ) {
      route = "vendor";
      routeParams = { vendor_id: vendorId };
    } else if (type === "category_approved" || type === "category_rejected") {
      route = "settings";
      routeParams = {
        vendor_id: vendorId,
        ...(categoryId ? { category_id: categoryId } : {}),
      };
    } else if (type === "review_received") {
      route = "settings";
      routeParams = {
        vendor_id: vendorId,
        open_reviews: "1",
        ...(orderId ? { order_id: orderId } : {}),
      };
    } else if (!type && title.toLowerCase().includes("new order")) {
      route = "vendor";
      if (orderId) routeParams = { order_id: orderId };
    }
  }

  return buildFcmData(
    {
      route,
      route_params: routeParams,
      type: type || (orderId ? "new_order" : undefined),
      order_id: orderId,
      vendor_id: vendorId,
    },
    title,
    body,
  );
}
