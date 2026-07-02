import { describe, expect, it, vi } from "vitest";
import {
  handlePushNotificationData,
  resolveRoutePath,
} from "@/lib/notificationNavigation";

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

  it("ignores location ping payloads", () => {
    const navigate = vi.fn();
    handlePushNotificationData(navigate, { type: "location_ping", route: "vendor" });
    expect(navigate).not.toHaveBeenCalled();
  });
});
