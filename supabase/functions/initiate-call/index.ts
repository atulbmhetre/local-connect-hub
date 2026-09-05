import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ACTIVE_ORDER_MAX_AGE_MS,
  SCHEDULED_ORDER_GRACE_MS,
} from "../_shared/activeOrderWindow.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const IN_PROGRESS_STATUSES = ["sent", "seen", "accepted"] as const;

type InitiateCallBody = {
  caller_phone?: string;
  vendor_phone?: string;
  service_mode?: string;
  device_id?: string;
};

type VendorPhoneRow = { id: string; phone: string | null };

type RequestLinkRow = {
  id: string;
  status: string;
  created_at: string;
  user_phone: string | null;
  vendor_id: string;
  appointment_time: string | null;
  delivery_slot_deadline: string | null;
};

type SupabaseClient = ReturnType<typeof createClient>;

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-+]/g, "").trim();
}

function last10Digits(phone: string): string {
  const digits = normalizePhone(phone).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function phonesMatch(stored: string | null | undefined, last10: string): boolean {
  if (!stored || last10.length < 10) return false;
  return last10Digits(stored) === last10;
}

function last4(last10: string): string {
  return last10.slice(-4);
}

function timeLimitSeconds(serviceMode: string | undefined): number {
  switch ((serviceMode ?? "").toLowerCase()) {
    case "help":
      return 300;
    case "delivery":
      return 120;
    case "appointment":
      return 180;
    default:
      return 180;
  }
}

function extractCallSid(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  if (typeof obj.call_sid === "string" && obj.call_sid) return obj.call_sid;

  const call = obj.Call;
  if (call && typeof call === "object") {
    const callObj = call as Record<string, unknown>;
    if (typeof callObj.Sid === "string" && callObj.Sid) return callObj.Sid;
    if (typeof callObj.sid === "string" && callObj.sid) return callObj.sid;
  }

  return null;
}

function extractCallSidFromXml(xml: string): string | null {
  const match = xml.match(/<Sid>([^<]+)<\/Sid>/i);
  return match?.[1]?.trim() ?? null;
}

function isInProgressRequest(row: RequestLinkRow): boolean {
  if (!IN_PROGRESS_STATUSES.includes(row.status as (typeof IN_PROGRESS_STATUSES)[number])) {
    return false;
  }
  const created = new Date(row.created_at).getTime();
  if (Number.isFinite(created) && Date.now() - created < ACTIVE_ORDER_MAX_AGE_MS) {
    return true;
  }
  if (row.status !== "accepted") return false;
  for (const iso of [row.appointment_time, row.delivery_slot_deadline]) {
    if (!iso) continue;
    const t = new Date(iso).getTime();
    if (Number.isFinite(t) && t >= Date.now() - SCHEDULED_ORDER_GRACE_MS) return true;
  }
  return false;
}

async function enforceRateLimit(
  supabase: SupabaseClient,
  identifierType: "phone" | "device_id",
  identifier: string,
): Promise<Response | null> {
  const { data: allowed, error: rlError } = await supabase.rpc(
    "check_and_log_rate_limit",
    {
      p_function_name: "initiate-call",
      p_identifier_type: identifierType,
      p_identifier: identifier,
      p_max_requests: 8,
      p_window_seconds: 60,
    },
  );
  if (rlError) {
    console.error("initiate-call rate limit RPC failed", identifierType, rlError);
    return null;
  }
  if (allowed === false) {
    return jsonResponse(
      { success: false, error: "rate_limited" },
      429,
    );
  }
  return null;
}

async function findInProgressLink(
  supabase: SupabaseClient,
  vendorIds: string[],
  customerLast10: string,
): Promise<RequestLinkRow | null> {
  if (vendorIds.length === 0) return null;

  const { data, error } = await supabase
    .from("requests")
    .select(
      "id, status, created_at, user_phone, vendor_id, appointment_time, delivery_slot_deadline",
    )
    .in("vendor_id", vendorIds)
    .in("status", [...IN_PROGRESS_STATUSES])
    .like("user_phone", `%${customerLast10}`)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("initiate-call requests lookup failed", error);
    throw error;
  }

  return (
    (data as RequestLinkRow[] | null)?.find(
      (row) => phonesMatch(row.user_phone, customerLast10) && isInProgressRequest(row),
    ) ?? null
  );
}

/**
 * Same relationship LiveTracking / AiBridge / IncomingOrders use:
 * public.requests.user_phone (customer) + requests.vendor_id → vendors.phone.
 * Either orientation of the pair is accepted so vendor-initiated Secure Call
 * (IncomingOrders / LedgerView) still works.
 */
async function findActiveCustomerVendorRequest(
  supabase: SupabaseClient,
  callerPhone: string,
  vendorPhone: string,
): Promise<
  | { ok: true; requestId: string; orientation: "customer_to_vendor" | "vendor_to_customer" }
  | { ok: false }
> {
  const caller10 = last10Digits(callerPhone);
  const vendor10 = last10Digits(vendorPhone);
  if (caller10.length < 10 || vendor10.length < 10) return { ok: false };

  const { data: vendorRows, error: vendorError } = await supabase
    .from("vendors")
    .select("id, phone")
    .or(`phone.like.%${caller10},phone.like.%${vendor10}`);

  if (vendorError) {
    console.error("initiate-call vendors lookup failed", vendorError);
    throw vendorError;
  }

  const rows = (vendorRows as VendorPhoneRow[] | null) ?? [];
  const vendorPartyIds = rows
    .filter((v) => phonesMatch(v.phone, vendor10))
    .map((v) => v.id);
  const callerAsVendorIds = rows
    .filter((v) => phonesMatch(v.phone, caller10))
    .map((v) => v.id);

  const customerToVendor = await findInProgressLink(supabase, vendorPartyIds, caller10);
  if (customerToVendor) {
    return {
      ok: true,
      requestId: customerToVendor.id,
      orientation: "customer_to_vendor",
    };
  }

  const vendorToCustomer = await findInProgressLink(supabase, callerAsVendorIds, vendor10);
  if (vendorToCustomer) {
    return {
      ok: true,
      requestId: vendorToCustomer.id,
      orientation: "vendor_to_customer",
    };
  }

  return { ok: false };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { success: false, error: "Method not allowed" },
      405,
    );
  }

  try {
    let body: InitiateCallBody;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }

    const callerPhone = body.caller_phone
      ? normalizePhone(body.caller_phone)
      : "";
    const vendorPhone = body.vendor_phone
      ? normalizePhone(body.vendor_phone)
      : "";
    const deviceId = body.device_id?.trim() ?? "";

    if (!callerPhone || !vendorPhone) {
      return jsonResponse(
        {
          success: false,
          error: "caller_phone and vendor_phone are required",
        },
        400,
      );
    }

    const caller10 = last10Digits(callerPhone);
    const vendor10 = last10Digits(vendorPhone);
    if (caller10.length < 10 || vendor10.length < 10) {
      return jsonResponse(
        { success: false, error: "caller_phone and vendor_phone are required" },
        400,
      );
    }
    if (caller10 === vendor10) {
      console.error("initiate-call: rejected, same number both ends", {
        last4: last4(caller10),
      });
      return jsonResponse(
        {
          success: false,
          error: "No active order linking caller and vendor",
        },
        403,
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("initiate-call missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return jsonResponse(
        { success: false, error: "server_misconfigured" },
        500,
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const phoneLimited = await enforceRateLimit(supabase, "phone", caller10);
    if (phoneLimited) return phoneLimited;
    if (deviceId) {
      const deviceLimited = await enforceRateLimit(supabase, "device_id", deviceId);
      if (deviceLimited) return deviceLimited;
    }

    const link = await findActiveCustomerVendorRequest(
      supabase,
      callerPhone,
      vendorPhone,
    );
    if (!link.ok) {
      console.error("initiate-call: rejected, no active request", {
        caller_last4: last4(caller10),
        vendor_last4: last4(vendor10),
      });
      return jsonResponse(
        {
          success: false,
          error: "No active order linking caller and vendor",
        },
        403,
      );
    }

    console.log("initiate-call: active request verified", {
      request_id: link.requestId,
      orientation: link.orientation,
      caller_last4: last4(caller10),
      vendor_last4: last4(vendor10),
    });

    const exotelSid = Deno.env.get("EXOTEL_SID");
    const exotelApiKey = Deno.env.get("EXOTEL_API_KEY");
    const exotelApiToken = Deno.env.get("EXOTEL_API_TOKEN");
    const exotelCallerId = Deno.env.get("EXOTEL_CALLER_ID");

    if (!exotelSid || !exotelApiKey || !exotelApiToken || !exotelCallerId) {
      return jsonResponse(
        {
          success: false,
          error:
            "Missing Exotel configuration (EXOTEL_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_CALLER_ID)",
        },
        500,
      );
    }

    const timeLimit = timeLimitSeconds(body.service_mode);
    const auth = btoa(`${exotelApiKey}:${exotelApiToken}`);
    const callbackSecret = Deno.env.get("EXOTEL_STATUS_CALLBACK_SECRET")?.trim() ?? "";
    const vendorLast10 = last10Digits(vendorPhone);

    const form = new URLSearchParams({
      From: callerPhone,
      To: vendorPhone,
      CallerId: exotelCallerId,
      TimeLimit: String(timeLimit),
      Record: "false",
      CustomField: `${link.requestId}|${vendorLast10}`,
    });
    if (callbackSecret && supabaseUrl) {
      // Token-only URL: verify_jwt is off on the receiver. Do not append
      // SUPABASE_ANON_KEY — JWTs blow past typical vendor URL length limits.
      const callback = new URL("/functions/v1/exotel-call-status", supabaseUrl);
      callback.searchParams.set("token", callbackSecret);
      form.set("StatusCallback", callback.toString());
      console.log("initiate-call: StatusCallback attached", {
        host: callback.host,
        path: callback.pathname,
      });
    }

    const connectUrl = `https://api.exotel.com/v1/Accounts/${exotelSid}/Calls/connect`;
    const postConnect = (body: URLSearchParams) =>
      fetch(connectUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });

    // Prefer array-encoded terminal events + JSON payload. Fall back if this
    // account's v1 rejects those params (StatusCallbackEvents=terminal 400s).
    let exotelRes: Response;
    let responseText: string;
    if (form.has("StatusCallback")) {
      const withEvents = new URLSearchParams(form);
      withEvents.set("StatusCallbackEvents[]", "terminal");
      withEvents.set("StatusCallbackContentType", "application/json");
      exotelRes = await postConnect(withEvents);
      responseText = await exotelRes.text();
      if (!exotelRes.ok) {
        console.error("initiate-call: Events[] variant rejected", exotelRes.status, responseText.slice(0, 300));
        const withJson = new URLSearchParams(form);
        withJson.set("StatusCallbackContentType", "application/json");
        exotelRes = await postConnect(withJson);
        responseText = await exotelRes.text();
      }
      if (!exotelRes.ok) {
        console.error("initiate-call: JSON content-type variant rejected", exotelRes.status, responseText.slice(0, 300));
        exotelRes = await postConnect(form);
        responseText = await exotelRes.text();
      }
    } else {
      exotelRes = await postConnect(form);
      responseText = await exotelRes.text();
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      parsed = null;
    }

    if (!exotelRes.ok) {
      const errMsg =
        (parsed &&
          typeof parsed === "object" &&
          "RestException" in parsed &&
          typeof (parsed as { RestException?: { Message?: string } })
            .RestException?.Message === "string" &&
          (parsed as { RestException: { Message: string } }).RestException
            .Message) ||
        responseText ||
        `Exotel API error (${exotelRes.status})`;

      return jsonResponse({ success: false, error: errMsg }, 502);
    }

    const callSid =
      extractCallSid(parsed) ?? extractCallSidFromXml(responseText);

    if (!callSid) {
      return jsonResponse(
        {
          success: false,
          error: "Call initiated but call_sid missing in Exotel response",
        },
        502,
      );
    }

    return jsonResponse({ success: true, call_sid: callSid });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("initiate-call: unexpected error", message);
    return jsonResponse({ success: false, error: message }, 500);
  }
});
