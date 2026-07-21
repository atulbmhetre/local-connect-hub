import { describe, expect, it, vi } from "vitest";
import {
  handlePushNotificationData,
  resolveRoutePath,
} from "@/lib/notificationNavigation";

const { captureError } = vi.hoisted(() => ({
  captureError: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError }));

describe("notificationNavigation", () => {
  it("maps orders route alias to my-orders", () => {
    expect(resolveRoutePath("orders")).toBe("/my-orders");
  });

  it("navigates to feed with post highlight from FCM data", () => {
    const navigate = vi.fn();
    handlePushNotificationData(navigate, {
      route: "feed",
      route_params: JSON.stringify({ post_id: "abc-123" }),
      type: "feed_reply",
    });
    expect(navigate).toHaveBeenCalledWith("/feed", {
      state: { highlightPostId: "abc-123" },
    });
  });

  it("navigates vendor payment notifications to vendor orders", () => {
    const navigate = vi.fn();
    handlePushNotificationData(navigate, {
      route: "vendor",
      route_params: JSON.stringify({ order_id: "req-1" }),
      type: "payment_claimed",
    });
    expect(navigate).toHaveBeenCalledWith("/vendor", {
      state: { highlightOrderId: "req-1" },
    });
  });

  it("navigates review_received to settings preferences with reviews open", () => {
    const navigate = vi.fn();
    handlePushNotificationData(navigate, {
      route: "settings",
      route_params: JSON.stringify({ vendor_id: "v-1", open_reviews: "1" }),
      type: "review_received",
    });
    expect(navigate).toHaveBeenCalledWith("/settings", {
      state: {
        highlightVendorId: "v-1",
        vendorSettingsTab: "preferences",
        openVendorReviews: true,
      },
    });
  });

  it("maps settings route to /settings (not Home)", () => {
    expect(resolveRoutePath("settings")).toBe("/settings");
    expect(resolveRoutePath(null)).toBe("/");
  });

  it("navigates customer payment_confirmed to my-orders with highlight", () => {
    const navigate = vi.fn();
    handlePushNotificationData(navigate, {
      route: "my-orders",
      route_params: JSON.stringify({ order_id: "ord-9" }),
      type: "payment_confirmed",
    });
    expect(navigate).toHaveBeenCalledWith("/my-orders", {
      state: { highlightOrderId: "ord-9" },
    });
  });

  it("captures and no-ops when route is missing", () => {
    captureError.mockClear();
    const navigate = vi.fn();
    handlePushNotificationData(navigate, { type: "order_update" });
    expect(navigate).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalled();
    expect(captureError.mock.calls[0][1]?.reason).toBe("missing_route");
  });

  it("captures and no-ops when route key is unresolvable", () => {
    captureError.mockClear();
    const navigate = vi.fn();
    handlePushNotificationData(navigate, { route: "totally-unknown" });
    expect(navigate).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalled();
    expect(captureError.mock.calls[0][1]?.reason).toBe("unresolvable_route");
  });
});
