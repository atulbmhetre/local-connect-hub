import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PushNavigationBridge } from "@/components/PushNavigationBridge";
import {
  storePendingPushNav,
  consumePendingPushNav,
} from "@/lib/pendingPushNav";

const { handlePush, setAppNavigate, clearAppNavigate } = vi.hoisted(() => ({
  handlePush: vi.fn(),
  setAppNavigate: vi.fn(),
  clearAppNavigate: vi.fn(),
}));

vi.mock("@/lib/notificationNavigation", () => ({
  handlePushNotificationData: handlePush,
  pushDataFromSearchParams: () => undefined,
}));

vi.mock("@/lib/appNavigate", () => ({
  setAppNavigate,
  clearAppNavigate,
}));

describe("pendingPushNav", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("stores and drains cold-start push payload once", () => {
    storePendingPushNav({ route: "feed", route_params: { post_id: "p1" } });
    const first = consumePendingPushNav();
    expect(first).toEqual({ route: "feed", route_params: { post_id: "p1" } });
    expect(consumePendingPushNav()).toBeUndefined();
  });
});

describe("PushNavigationBridge", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("drains pending cold-start nav on mount", () => {
    storePendingPushNav({ route: "my-orders", route_params: { order_id: "o1" } });

    render(
      <MemoryRouter>
        <PushNavigationBridge />
      </MemoryRouter>,
    );

    expect(setAppNavigate).toHaveBeenCalled();
    expect(handlePush).toHaveBeenCalledWith(
      expect.any(Function),
      { route: "my-orders", route_params: { order_id: "o1" } },
    );
    expect(consumePendingPushNav()).toBeUndefined();
  });

  it("forwards an unresolvable pending route to handlePushNotificationData", () => {
    storePendingPushNav({ route: "not-a-real-route" });

    render(
      <MemoryRouter>
        <PushNavigationBridge />
      </MemoryRouter>,
    );

    expect(handlePush).toHaveBeenCalledWith(expect.any(Function), {
      route: "not-a-real-route",
    });
  });
});
