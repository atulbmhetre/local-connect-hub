/**
 * Shared gate for notify-user / notify-vendor (initiate-call pattern).
 * Anon/authenticated must prove a real relationship to the target:
 *   - live/recent request (order_id / request_id), or
 *   - referrals row (referral_id → referrer vendor), or
 *   - khata_ledger row (vendor_id + customer phone).
 * Service-role and admin-session callers are allowed without those proofs.
 *
 * Call sites WITH order_id/request_id (client): IncomingOrdersSection, MyOrders,
 * RatingSheet, UpiPaymentPanel, iveStartedNotify; LedgerView when a khata-linked
 * request exists. Server/pg_net triggers that include order_id also pass.
 *
 * Call sites WITH non-order proofs:
 * - referral.ts → referral_id (referrals.referrer_vendor_id)
 * - LedgerView khata paid (no linked order) → vendor_id + khata_ledger
 *
 * Admin/service-role only (no end-user relationship to invent here):
 * - Settings: category approve/reject, ban/unban/restore, vendor verification
 * - applyVendorWaiveoff, warnFlaggedUser
 * - process-new-category / check-vendor-subscriptions / process-vendor-referral
 *   / razorpay-webhook / delete-account
 */

const IN_PROGRESS = ["sent", "seen", "accepted"] as const;
const ACTIVE_ORDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SCHEDULED_GRACE_MS = 24 * 60 * 60 * 1000;
/** Referral notify is sent immediately after apply; allow a short replay window. */
const REFERRAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

export function extractReferralId(payload: Record<string, unknown>): string | null {
  const record =
    payload.record && typeof payload.record === "object"
      ? (payload.record as Record<string, unknown>)
      : payload;
  const value = record.referral_id ?? payload.referral_id;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

export function extractVendorId(payload: Record<string, unknown>): string | null {
  const record =
    payload.record && typeof payload.record === "object"
      ? (payload.record as Record<string, unknown>)
      : payload;
  const value = record.vendor_id ?? payload.vendor_id;
  if (typeof value === "string" && value.trim()) return value.trim();
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

type SupabaseLike = { from: (table: string) => any };

async function assertOrderRelationship(
  supabase: SupabaseLike,
  opts: {
    requestId: string;
    targetUserPhone?: string | null;
    targetVendorId?: string | null;
  },
): Promise<NotifyGateResult> {
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

async function assertReferralRelationship(
  supabase: SupabaseLike,
  opts: { referralId: string; targetVendorId: string },
): Promise<NotifyGateResult> {
  const { data, error } = await supabase
    .from("referrals")
    .select("id, referrer_vendor_id, triggered_at")
    .eq("id", opts.referralId)
    .maybeSingle();

  if (error) {
    console.error("notify referral relationship lookup failed", error);
    return { ok: false, status: 500, error: "relationship_check_failed" };
  }
  if (!data) {
    return { ok: false, status: 403, error: "relationship_required" };
  }

  const row = data as {
    referrer_vendor_id: string;
    triggered_at: string | null;
  };

  if (row.referrer_vendor_id !== opts.targetVendorId.trim()) {
    return { ok: false, status: 403, error: "relationship_required" };
  }

  const triggered = row.triggered_at ? new Date(row.triggered_at).getTime() : NaN;
  if (!Number.isFinite(triggered) || Date.now() - triggered > REFERRAL_MAX_AGE_MS) {
    return { ok: false, status: 403, error: "relationship_required" };
  }

  return { ok: true };
}

async function assertKhataRelationship(
  supabase: SupabaseLike,
  opts: { vendorId: string; targetUserPhone: string },
): Promise<NotifyGateResult> {
  const phone = opts.targetUserPhone.trim();
  if (!phone || !opts.vendorId.trim()) {
    return { ok: false, status: 403, error: "relationship_required" };
  }

  // LedgerView always notifies with the phone key stored on khata_ledger.
  const { data, error } = await supabase
    .from("khata_ledger")
    .select("id, user_phone")
    .eq("vendor_id", opts.vendorId.trim())
    .eq("user_phone", phone)
    .maybeSingle();

  if (error) {
    console.error("notify khata relationship lookup failed", error);
    return { ok: false, status: 500, error: "relationship_check_failed" };
  }

  if (data) return { ok: true };

  // Fallback: match last-10 when client/DB formatting differs slightly.
  const target10 = last10(phone);
  if (target10.length !== 10) {
    return { ok: false, status: 403, error: "relationship_required" };
  }
  const { data: rows, error: listError } = await supabase
    .from("khata_ledger")
    .select("id, user_phone")
    .eq("vendor_id", opts.vendorId.trim())
    .like("user_phone", `%${target10}`)
    .limit(5);

  if (listError) {
    console.error("notify khata relationship fallback failed", listError);
    return { ok: false, status: 500, error: "relationship_check_failed" };
  }

  const hit = ((rows as { user_phone: string }[] | null) ?? []).some(
    (row) => last10(row.user_phone) === target10,
  );
  if (!hit) {
    return { ok: false, status: 403, error: "relationship_required" };
  }

  return { ok: true };
}

export async function assertNotifyRelationship(
  req: Request,
  // Service-role client; used to read requests / referrals / khata_ledger.
  supabase: SupabaseLike,
  opts: {
    requestId: string | null;
    referralId?: string | null;
    khataVendorId?: string | null;
    targetUserPhone?: string | null;
    targetVendorId?: string | null;
  },
): Promise<NotifyGateResult> {
  if (isServiceRoleRequest(req)) return { ok: true };
  if (await callerIsAdminSession(req)) return { ok: true };

  if (opts.requestId) {
    return assertOrderRelationship(supabase, {
      requestId: opts.requestId,
      targetUserPhone: opts.targetUserPhone,
      targetVendorId: opts.targetVendorId,
    });
  }

  if (opts.referralId?.trim() && opts.targetVendorId?.trim()) {
    return assertReferralRelationship(supabase, {
      referralId: opts.referralId.trim(),
      targetVendorId: opts.targetVendorId.trim(),
    });
  }

  if (opts.khataVendorId?.trim() && opts.targetUserPhone?.trim()) {
    return assertKhataRelationship(supabase, {
      vendorId: opts.khataVendorId.trim(),
      targetUserPhone: opts.targetUserPhone.trim(),
    });
  }

  return { ok: false, status: 403, error: "relationship_required" };
}
