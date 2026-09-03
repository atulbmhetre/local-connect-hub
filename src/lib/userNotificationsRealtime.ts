import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export type UserNotificationsRealtimeListener = () => void;

type Slot = {
  phone: string;
  channel: RealtimeChannel;
  listeners: Set<UserNotificationsRealtimeListener>;
};

let slot: Slot | null = null;

function emit(active: Slot) {
  for (const listener of [...active.listeners]) {
    listener();
  }
}

function teardown(active: Slot) {
  active.listeners.clear();
  void supabase.removeChannel(active.channel);
}

/**
 * One Realtime channel per user phone, shared across every NotificationBell.
 * Calling `.on()` on an already-subscribed supabase-js channel throws; desktop
 * mounts two bells, so they must not each subscribe independently.
 */
export function subscribeUserNotificationsRealtime(
  phone: string,
  onChange: UserNotificationsRealtimeListener,
): () => void {
  if (slot && slot.phone !== phone) {
    teardown(slot);
    slot = null;
  }

  if (!slot) {
    const listeners = new Set<UserNotificationsRealtimeListener>();
    const channel = supabase
      .channel(`user-notifications-${phone}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "user_notifications",
          filter: `user_phone=eq.${phone}`,
        },
        () => {
          if (slot) emit(slot);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "user_notifications",
          filter: `user_phone=eq.${phone}`,
        },
        () => {
          if (slot) emit(slot);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "user_notifications",
          filter: `user_phone=eq.${phone}`,
        },
        () => {
          if (slot) emit(slot);
        },
      )
      .subscribe();
    slot = { phone, channel, listeners };
  }

  slot.listeners.add(onChange);
  return () => {
    if (!slot) return;
    slot.listeners.delete(onChange);
    if (slot.listeners.size === 0) {
      teardown(slot);
      slot = null;
    }
  };
}

/** Test-only: drop the shared channel so cases cannot leak across files. */
export function resetUserNotificationsRealtimeForTests(): void {
  if (!slot) return;
  teardown(slot);
  slot = null;
}
