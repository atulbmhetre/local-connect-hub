/**
 * Shared gate for notify-user / notify-vendor (initiate-call pattern).
 * Anon/authenticated must reference a live/recent request linking the target.
 * Service-role and admin-session callers are allowed without an order id.
 *
 * Call sites WITH order_id/request_id (client): IncomingOrdersSection, MyOrders,
 * RatingSheet, UpiPaymentPanel, iveStartedNotify; LedgerView when a khata-linked
 * request exists. Server/pg_net triggers that include order_id also pass.
 *
 * FLAG — legitimate call sites WITHOUT an order relationship today (bypass only
 * via service-role or admin-session; do not invent OTP/identity redesign here):
 * - Settings: category approve/reject, ban/unban/restore, vendor verification
 * - applyVendorWaiveoff, warnFlaggedUser (admin)
 * - referral.ts recordUserReferral (end-user client, no order)
 * - LedgerView khata paid when get_vendor_khata_linked_request returns null
 * - process-new-category / check-vendor-subscriptions / process-vendor-referral
 *   / razorpay-webhook / delete-account (service-role)
 */

const IN_PROGRESS = ["sent", "seen", "accepted"] as const;
const ACTIVE_ORDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SCHEDULED_GRACE_MS = 24 * 60 * 60 * 1000;

export type NotifyGateResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

function last10(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Extract candidate tokens from Authorization Bearer and/or apikey (supabase-js sb_secret_ sends apikey only). */
function requestKeyCandidates(req: Request): string[] {
  const out: string[] = [];
  const auth = (req.headers.get("Authorization") ?? "").trim();
  if (auth) {
    const token = auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : auth;
    if (token) out.push(token);
  }
  const apikey = (req.headers.get("apikey") ?? "").trim();
  if (apikey) out.push(apikey);
  return out;
}

export function isServiceRoleRequest(req: Request): boolean {
  const key = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  if (!key) return false;
  return requestKeyCandidates(req).some((token) => token === key);
}

export function extractRequestId(payload: Record<string, unknown>): string | null {
  const record =
    payload.record && typeof payload.record === "object"
      ? (payload.record as Record<string, unknown>)
      : payload;
  for (const key of ["request_id", "order_id"]) {
    const value = record[key] ?? payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isRecentOrLiveRequest(row: {
  status: string;
  created_at: string;
  appointment_time: string | null;
  delivery_slot_deadline: string | null;
}): boolean {
  const created = new Date(row.created_at).getTime();
  if (Number.isFinite(created) && Date.now() - created < ACTIVE_ORDER_MAX_AGE_MS) {
    return true;
  }
  if (!IN_PROGRESS.includes(row.status as (typeof IN_PROGRESS)[number])) return false;
  for (const iso of [row.appointment_time, row.delivery_slot_deadline]) {
    if (!iso) continue;
    const t = new Date(iso).getTime();
    if (Number.isFinite(t) && t >= Date.now() - SCHEDULED_GRACE_MS) return true;
  }
  return false;
}

async function callerIsAdminSession(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization");
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!auth || !url || !anon) return false;
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const userClient = createClient(url, anon, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await userClient.rpc("is_admin_session");
    return error == null && data === true;
  } catch {
    return false;
  }
}

export async function assertNotifyRelationship(
  req: Request,
  // Service-role client; only used to read public.requests.
  supabase: { from: (table: string) => any },
  opts: {
    requestId: string | null;
    targetUserPhone?: string | null;
    targetVendorId?: string | null;
  },
): Promise<NotifyGateResult> {
  if (isServiceRoleRequest(req)) return { ok: true };
  if (await callerIsAdminSession(req)) return { ok: true };

  if (!opts.requestId) {
    return { ok: false, status: 403, error: "relationship_required" };
  }

  const { data, error } = await supabase
    .from("requests")
    .select("id, status, created_at, user_phone, vendor_id, appointment_time, delivery_slot_deadline")
    .eq("id", opts.requestId)
    .maybeSingle();

  if (error) {
    console.error("notify relationship lookup failed", error);
    return { ok: false, status: 500, error: "relationship_check_failed" };
  }
  if (!data) {
    return { ok: false, status: 403, error: "relationship_required" };
  }

  const row = data as {
    status: string;
    created_at: string;
    user_phone: string | null;
    vendor_id: string;
    appointment_time: string | null;
    delivery_slot_deadline: string | null;
  };

  if (!isRecentOrLiveRequest(row)) {
    return { ok: false, status: 403, error: "relationship_required" };
  }

  if (opts.targetUserPhone?.trim()) {
    if (last10(row.user_phone) !== last10(opts.targetUserPhone)) {
      return { ok: false, status: 403, error: "relationship_required" };
    }
  }

  if (opts.targetVendorId?.trim()) {
    if (row.vendor_id !== opts.targetVendorId.trim()) {
      return { ok: false, status: 403, error: "relationship_required" };
    }
  }

  return { ok: true };
}
