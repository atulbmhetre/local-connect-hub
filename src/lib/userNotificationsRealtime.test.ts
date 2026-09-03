import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockChannel, mockOn, mockSubscribe, mockRemove, channelState } = vi.hoisted(() => {
  const state = { subscribed: false };
  const mockOn = vi.fn();
  const mockSubscribe = vi.fn();
  const mockRemove = vi.fn();
  const mockChannel = {
    on: mockOn,
    subscribe: mockSubscribe,
  };
  mockOn.mockImplementation(() => {
    if (state.subscribed) {
      throw new Error("cannot add `postgres_changes` callbacks after `subscribe()`.");
    }
    return mockChannel;
  });
  mockSubscribe.mockImplementation(() => {
    state.subscribed = true;
    return mockChannel;
  });
  mockRemove.mockImplementation(() => {
    state.subscribed = false;
  });
  return { mockChannel, mockOn, mockSubscribe, mockRemove, channelState: state };
});

vi.mock("@/lib/supabase", () => ({
  supabase: {
    channel: vi.fn(() => mockChannel),
    removeChannel: mockRemove,
  },
}));

import { supabase } from "@/lib/supabase";
import {
  resetUserNotificationsRealtimeForTests,
  subscribeUserNotificationsRealtime,
} from "@/lib/userNotificationsRealtime";

describe("subscribeUserNotificationsRealtime", () => {
  beforeEach(() => {
    resetUserNotificationsRealtimeForTests();
    channelState.subscribed = false;
    vi.clearAllMocks();
    mockOn.mockImplementation(() => {
      if (channelState.subscribed) {
        throw new Error("cannot add `postgres_changes` callbacks after `subscribe()`.");
      }
      return mockChannel;
    });
    mockSubscribe.mockImplementation(() => {
      channelState.subscribed = true;
      return mockChannel;
    });
  });

  afterEach(() => {
    resetUserNotificationsRealtimeForTests();
  });

  it("subscribes once when two listeners share a phone", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeUserNotificationsRealtime("9876543210", a);
    const unsubB = subscribeUserNotificationsRealtime("9876543210", b);

    expect(supabase.channel).toHaveBeenCalledTimes(1);
    expect(supabase.channel).toHaveBeenCalledWith("user-notifications-9876543210");
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockOn).toHaveBeenCalledTimes(3);

    unsubA();
    expect(mockRemove).not.toHaveBeenCalled();
    unsubB();
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it("fans a postgres_changes callback out to every listener", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeUserNotificationsRealtime("9876543210", a);
    subscribeUserNotificationsRealtime("9876543210", b);

    const insertHandler = mockOn.mock.calls[0][2] as () => void;
    insertHandler();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
