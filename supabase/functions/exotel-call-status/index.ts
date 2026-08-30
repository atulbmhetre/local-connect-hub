import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Exotel Calls/connect terminal StatusCallback receiver.
 * verify_jwt=false — Exotel POSTs with no Supabase JWT. Auth is the
 * shared token query param matching EXOTEL_STATUS_CALLBACK_SECRET.
 */

const ALLOWED_STATUS = new Set([
  "completed",
  "failed",
  "busy",
  "no-answer",
  "canceled",
]);

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function last10Digits(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

function normalizeStatus(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (ALLOWED_STATUS.has(s)) return s;
  return "unknown";
}

function parseCustomField(raw: string): { requestId: string | null; vendorPhone: string } {
  const parts = raw.split("|");
  const requestId = parts[0] && /^[0-9a-f-]{36}$/i.test(parts[0]) ? parts[0] : null;
  const vendorPhone = parts[1] ? last10Digits(parts[1]) : "";
  return { requestId, vendorPhone };
}

function formDataToRecord(form: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) {
    obj[k] = typeof v === "string" ? v : v.name;
  }
  return obj;
}

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    try {
      return formDataToRecord(await req.formData());
    } catch {
      return {};
    }
  }
  const text = await req.text();
  if (!text.trim()) return {};
  if (contentType.includes("application/json") || text.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return asRecord(parsed);
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(text);
  const obj: Record<string, unknown> = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

serve(async (req) => {
  try {
    return await handleCallStatus(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("exotel-call-status: uncaught", message);
    return jsonResponse({ error: "uncaught", message }, 500);
  }
});

async function handleCallStatus(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  // Exotel StatusCallback is POST; default (no events) docs also mention GET.
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const expected = Deno.env.get("EXOTEL_STATUS_CALLBACK_SECRET")?.trim() ?? "";
  if (!expected) {
    console.error("exotel-call-status: EXOTEL_STATUS_CALLBACK_SECRET missing");
    return jsonResponse({ error: "misconfigured" }, 500);
  }

  const provided = new URL(req.url).searchParams.get("token") ?? "";
  if (!provided || !timingSafeEqual(provided, expected)) {
    console.error("exotel-call-status: invalid token");
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "misconfigured" }, 500);
  }

  const urlParams: Record<string, unknown> = {};
  for (const [k, v] of new URL(req.url).searchParams.entries()) {
    if (k !== "token") urlParams[k] = v;
  }
  const body = req.method === "GET" ? {} : await parseBody(req);
  const flat = { ...urlParams, ...body, ...asRecord(body.Call) };
  console.log("exotel-call-status: parsed", {
    method: req.method,
    contentType: req.headers.get("content-type") ?? "",
    keys: Object.keys(flat),
  });
  const callSid = pickString(flat, ["CallSid", "call_sid", "Sid"]);
  const status = normalizeStatus(pickString(flat, ["Status", "status"]));
  const customField = pickString(flat, ["CustomField", "custom_field"]);
  const duration = pickNumber(flat, ["Duration", "duration"]);
  const conversation = pickNumber(flat, [
    "ConversationDuration",
    "conversation_duration",
  ]);
  const parsed = parseCustomField(customField);
  const vendorFromTo = last10Digits(pickString(flat, ["To", "to"]));
  const vendorPhone = parsed.vendorPhone || vendorFromTo;

  if (!vendorPhone) {
    console.error("exotel-call-status: missing vendor_phone", { callSid });
    return jsonResponse({ error: "missing vendor_phone" }, 400);
  }

  console.log("exotel-call-status: received", {
    call_sid: callSid || null,
    status,
    vendor_last4: vendorPhone.slice(-4),
  });

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const row = {
    request_id: parsed.requestId,
    vendor_phone: vendorPhone,
    call_sid: callSid || null,
    status,
    duration_seconds: duration,
    conversation_duration_seconds: conversation,
    custom_field: customField || null,
    payload: { ...urlParams, ...body },
  };

  const { error } = callSid
    ? await supabase.from("vendor_call_outcomes").upsert(row, { onConflict: "call_sid" })
    : await supabase.from("vendor_call_outcomes").insert(row);

  if (error) {
    console.error("exotel-call-status: insert failed", error.message);
    return jsonResponse({ error: "persist_failed" }, 500);
  }

  return jsonResponse({ ok: true });
}
