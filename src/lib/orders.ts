export type RequestStatus = "sent" | "seen" | "accepted" | "fulfilled" | "done" | "cancelled";

export type OrderRequestRow = {
  id: string;
  device_id: string;
  vendor_id: string;
  message: string;
  status: string;
  created_at: string;
  user_phone: string | null;
  cancel_reason?: string | null;
  delivery_address?: string | null;
  customer_latitude?: number | null;
  customer_longitude?: number | null;
  delivery_slot?: string | null;
  delivery_slot_deadline?: string | null;
  appointment_time?: string | null;
  appointment_status?: string | null;
  updated_at?: string | null;
  previous_message?: string | null;
  is_edited?: boolean;
  category_id?: string | null;
  categories?: { label: string; emoji: string | null } | { label: string; emoji: string | null }[] | null;
};

export const ACTIVE_ORDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * PostgREST `.or()` filter for `requests`. Vendor: `sent` (48h) + `seen` (24h).
 * User: also includes `expired` (48h, so the customer sees why the order
 * stalled and can dismiss it) and `fulfilled` (any age). Omits `done`.
 * Timestamps quoted for ISO colons.
 */
export function buildRequestsActiveWindowOrFilter(
  role: "vendor" | "user" = "vendor",
  nowMs: number = Date.now(),
): string {
  const since48h = new Date(nowMs - 48 * 60 * 60 * 1000).toISOString();
  const since24h = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const base = `and(status.eq.sent,created_at.gte."${since48h}"),and(status.eq.seen,created_at.gte."${since24h}"),and(status.eq.accepted,created_at.gte."${since48h}"),and(status.eq.cancelled,created_at.gte."${since48h}")`;
  if (role === "user") {
    return `${base},and(status.eq.expired,created_at.gte."${since48h}"),status.eq.fulfilled`;
  }
  return base;
}

export function isActiveUserOrder(r: Pick<OrderRequestRow, "status" | "created_at">): boolean {
  if (r.status === "done") return false;
  const t = new Date(r.created_at).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < ACTIVE_ORDER_MAX_AGE_MS;
}

/** e.g. "2 mins ago", "1 hour ago" */
export function formatTimeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec} secs ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return min === 1 ? "1 min ago" : `${min} mins ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr === 1 ? "1 hour ago" : `${hr} hours ago`;
  const day = Math.floor(hr / 24);
  return day === 1 ? "1 day ago" : `${day} days ago`;
}
