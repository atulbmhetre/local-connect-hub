import { captureError } from "@/lib/sentry";
import { supabase } from "@/lib/supabase";
import { isValidIndianMobile, normalizePhoneDigits } from "@/lib/indianPhone";

export type AdminSupportMessage = {
  id: string;
  kind: string;
  category: string | null;
  rating: number | null;
  message: string;
  user_phone: string | null;
  vendor_id: string | null;
  vendor_shop_name: string | null;
  device_id: string | null;
  email_sent: boolean;
  created_at: string;
  resolved_at: string | null;
};

export type AdminCustomerLookupUser = {
  phone: string;
  trust_score: number | null;
  is_banned: boolean;
  ban_reason: string | null;
  deletion_requested_at: string | null;
  warn_count: number;
  noshow_count: number;
  fake_count: number;
};

export type AdminCustomerLookupVendor = {
  id: string;
  shop_name: string | null;
  is_banned: boolean;
  deletion_requested_at: string | null;
};

export type AdminCustomerLookupOrder = {
  id: string;
  status: string | null;
  payment_status: string | null;
  service_mode: string | null;
  created_at: string;
  vendor_id: string | null;
  vendor_shop_name: string | null;
};

export type AdminCustomerLookupDispute = {
  id: string;
  request_id: string;
  vendor_id: string;
  vendor_shop_name: string | null;
  disputed_at: string;
};

export type AdminCustomerLookupKhata = {
  vendor_id: string;
  vendor_shop_name: string | null;
  total_outstanding: number;
  last_updated: string;
};

export type AdminCustomerLookup = {
  found: boolean;
  phone: string;
  user: AdminCustomerLookupUser | null;
  vendor: AdminCustomerLookupVendor | null;
  orders: AdminCustomerLookupOrder[];
  disputes: AdminCustomerLookupDispute[];
  khata: AdminCustomerLookupKhata[];
};

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(value: unknown): boolean {
  return value === true;
}

export async function loadAdminSupportMessages(
  includeResolved: boolean,
): Promise<{ ok: true; rows: AdminSupportMessage[] } | { ok: false; rows: AdminSupportMessage[] }> {
  const { data, error } = await supabase.rpc("admin_list_support_messages", {
    p_include_resolved: includeResolved,
  });
  if (error) {
    captureError(error, { scope: "adminSupport.list", includeResolved });
    return { ok: false, rows: [] };
  }
  const rows = (Array.isArray(data) ? data : []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      kind: String(r.kind ?? ""),
      category: asString(r.category),
      rating: r.rating == null ? null : asNumber(r.rating, 0),
      message: String(r.message ?? ""),
      user_phone: asString(r.user_phone),
      vendor_id: asString(r.vendor_id),
      vendor_shop_name: asString(r.vendor_shop_name),
      device_id: asString(r.device_id),
      email_sent: asBool(r.email_sent),
      created_at: String(r.created_at ?? ""),
      resolved_at: asString(r.resolved_at),
    };
  }).filter((row) => row.id.length > 0);
  return { ok: true, rows };
}

export async function resolveAdminSupportMessage(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc("admin_resolve_support_message", {
    p_id: id,
  });
  if (error) {
    captureError(error, { scope: "adminSupport.resolve", messageId: id });
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

function parseLookupPayload(raw: unknown, phone: string): AdminCustomerLookup {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const userRaw =
    body.user && typeof body.user === "object"
      ? (body.user as Record<string, unknown>)
      : null;
  const vendorRaw =
    body.vendor && typeof body.vendor === "object"
      ? (body.vendor as Record<string, unknown>)
      : null;

  const orders = Array.isArray(body.orders)
    ? body.orders.map((item) => {
        const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return {
          id: String(o.id ?? ""),
          status: asString(o.status),
          payment_status: asString(o.payment_status),
          service_mode: asString(o.service_mode),
          created_at: String(o.created_at ?? ""),
          vendor_id: asString(o.vendor_id),
          vendor_shop_name: asString(o.vendor_shop_name),
        };
      }).filter((o) => o.id.length > 0)
    : [];

  const disputes = Array.isArray(body.disputes)
    ? body.disputes.map((item) => {
        const d = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return {
          id: String(d.id ?? ""),
          request_id: String(d.request_id ?? ""),
          vendor_id: String(d.vendor_id ?? ""),
          vendor_shop_name: asString(d.vendor_shop_name),
          disputed_at: String(d.disputed_at ?? ""),
        };
      }).filter((d) => d.id.length > 0)
    : [];

  const khata = Array.isArray(body.khata)
    ? body.khata.map((item) => {
        const k = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return {
          vendor_id: String(k.vendor_id ?? ""),
          vendor_shop_name: asString(k.vendor_shop_name),
          total_outstanding: asNumber(k.total_outstanding, 0),
          last_updated: String(k.last_updated ?? ""),
        };
      }).filter((k) => k.vendor_id.length > 0)
    : [];

  return {
    found: body.found === true,
    phone: asString(body.phone) ?? phone,
    user: userRaw
      ? {
          phone: asString(userRaw.phone) ?? phone,
          trust_score:
            userRaw.trust_score == null ? null : asNumber(userRaw.trust_score, 0),
          is_banned: asBool(userRaw.is_banned),
          ban_reason: asString(userRaw.ban_reason),
          deletion_requested_at: asString(userRaw.deletion_requested_at),
          warn_count: asNumber(userRaw.warn_count, 0),
          noshow_count: asNumber(userRaw.noshow_count, 0),
          fake_count: asNumber(userRaw.fake_count, 0),
        }
      : null,
    vendor: vendorRaw
      ? {
          id: String(vendorRaw.id ?? ""),
          shop_name: asString(vendorRaw.shop_name),
          is_banned: asBool(vendorRaw.is_banned),
          deletion_requested_at: asString(vendorRaw.deletion_requested_at),
        }
      : null,
    orders,
    disputes,
    khata,
  };
}

export async function lookupAdminCustomer(
  rawPhone: string,
): Promise<
  | { ok: true; data: AdminCustomerLookup }
  | { ok: false; error: "invalid_phone_format" | string }
> {
  const phone = normalizePhoneDigits(rawPhone);
  if (!phone || !isValidIndianMobile(phone)) {
    return { ok: false, error: "invalid_phone_format" };
  }

  const { data, error } = await supabase.rpc("admin_lookup_customer", {
    p_phone: phone,
  });
  if (error) {
    captureError(error, {
      scope: "adminSupport.lookupCustomer",
      phoneSuffix: phone.slice(-4),
    });
    return { ok: false, error: error.message };
  }
  return { ok: true, data: parseLookupPayload(data, phone) };
}
