import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Internal UPI-change SMS alert. Invoked by pg_net from
 * _finish_vendor_upi_mutation after a real payee change.
 *
 * Auth: anon JWT (verify_jwt) + x-upi-alert-secret matching app_config.
 * SMS failure is logged and stored; this function still returns 200 so
 * pg_net does not retry-storm, and the vendor UPDATE already committed.
 *
 * DLT: set EXOTEL_UPI_ALERT_DLT_TEMPLATE_ID + EXOTEL_UPI_ALERT_BODY_TEMPLATE
 * (`{upi}` slot, exact approved wording). If unset, the English alert body
 * is sent with the existing DLT entity + OTP template ID and will be
 * rejected until a matching VilPower template is registered. A failed
 * SMS is logged; the vendor UPDATE is never rolled back.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-upi-alert-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const UPI_PLACEHOLDER = "{upi}";
const DEFAULT_EXOTEL_API_HOST = "api.exotel.com";
const DEFAULT_SMS_TYPE = "transactional";
const DEFAULT_ALERT_BODY =
  "Your AasPaas Pro UPI payment ID was just changed to {upi}. If this wasn't you, contact support immediately.";

type ExotelSmsConfig = {
  sid: string;
  apiKey: string;
  apiToken: string;
  from: string;
  dltEntityId: string;
  dltTemplateId: string;
  bodyTemplate: string;
  apiHost: string;
  smsType: string;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function envTrim(name: string): string {
  return Deno.env.get(name)?.trim() ?? "";
}

function normalizeE164Phone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return trimmed.startsWith("+") ? trimmed : `+${digits}`;
}

function readExotelSmsConfig(): ExotelSmsConfig | null {
  const sid = envTrim("EXOTEL_SID");
  const apiKey = envTrim("EXOTEL_API_KEY");
  const apiToken = envTrim("EXOTEL_API_TOKEN");
  const from = envTrim("EXOTEL_SMS_FROM");
  const dltEntityId = envTrim("EXOTEL_DLT_ENTITY_ID");
  const upiTemplateId = envTrim("EXOTEL_UPI_ALERT_DLT_TEMPLATE_ID");
  const otpTemplateId = envTrim("EXOTEL_DLT_TEMPLATE_ID");
  const dltTemplateId = upiTemplateId || otpTemplateId;
  const upiBody = envTrim("EXOTEL_UPI_ALERT_BODY_TEMPLATE");
  const bodyTemplate = upiBody.includes(UPI_PLACEHOLDER)
    ? upiBody
    : DEFAULT_ALERT_BODY;

  if (!sid || !apiKey || !apiToken || !from || !dltEntityId || !dltTemplateId) {
    return null;
  }

  return {
    sid,
    apiKey,
    apiToken,
    from,
    dltEntityId,
    dltTemplateId,
    bodyTemplate,
    apiHost: envTrim("EXOTEL_API_HOST") || DEFAULT_EXOTEL_API_HOST,
    smsType: envTrim("EXOTEL_SMS_TYPE") || DEFAULT_SMS_TYPE,
  };
}

function extractExotelSmsStatus(payload: unknown): {
  sid: string | null;
  status: string | null;
} {
  if (!payload || typeof payload !== "object") {
    return { sid: null, status: null };
  }
  const root = payload as Record<string, unknown>;
  const message = (root.SMSMessage ?? root.SmsMessage ?? root) as Record<
    string,
    unknown
  >;
  const sid =
    typeof message.Sid === "string"
      ? message.Sid
      : typeof message.sid === "string"
        ? message.sid
        : null;
  const status =
    typeof message.Status === "string"
      ? message.Status
      : typeof message.status === "string"
        ? message.status
        : null;
  return { sid, status };
}

async function delay(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchExotelSmsDetail(
  smsSid: string,
  config: ExotelSmsConfig,
): Promise<{ status: string | null; detail: string }> {
  const auth = btoa(`${config.apiKey}:${config.apiToken}`);
  const res = await fetch(
    `https://${config.apiHost}/v1/Accounts/${config.sid}/Sms/Messages/${smsSid}.json`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const { status } = extractExotelSmsStatus(parsed);
  const message = (parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>).SMSMessage ?? parsed
    : null) as Record<string, unknown> | null;
  const detailed =
    (typeof message?.DetailedStatus === "string" && message.DetailedStatus) ||
    (typeof message?.Detail === "string" && message.Detail) ||
    text.slice(0, 400);
  return {
    status,
    detail: String(detailed),
    to: typeof message?.To === "string" ? message.To : null,
    from: typeof message?.From === "string" ? message.From : null,
    body: typeof message?.Body === "string" ? message.Body : null,
    dateSent: typeof message?.DateSent === "string" ? message.DateSent : null,
  };
}

async function sendExotelBody(
  phone: string,
  body: string,
  config: ExotelSmsConfig,
  templateId: string,
  customField: string,
): Promise<{ sid: string | null; status: string | null; raw: string }> {
  const to = normalizeE164Phone(phone);
  const auth = btoa(`${config.apiKey}:${config.apiToken}`);
  const form = new URLSearchParams({
    From: config.from,
    To: to,
    Body: body,
    DltEntityId: config.dltEntityId,
    DltTemplateId: templateId,
    SmsType: config.smsType,
    Priority: "high",
    CustomField: customField,
  });

  const res = await fetch(
    `https://${config.apiHost}/v1/Accounts/${config.sid}/Sms/send.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
  );
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    throw new Error(`Exotel SMS send failed (${res.status}): ${text}`);
  }
  const { sid, status } = extractExotelSmsStatus(parsed);
  return { sid, status, raw: text.slice(0, 400) };
}

async function pollUntilTerminal(
  smsSid: string,
  config: ExotelSmsConfig,
): Promise<{ status: string | null; detail: string }> {
  let last: { status: string | null; detail: string } = { status: null, detail: "" };
  for (let i = 0; i < 12; i++) {
    last = await fetchExotelSmsDetail(smsSid, config);
    if (/delivered|failed|undelivered/i.test(last.status ?? "")) break;
    await delay(3000);
  }
  return last;
}

async function deliverUpiAlertSms(
  phone: string,
  upiValue: string,
  config: ExotelSmsConfig,
): Promise<{ sid: string | null; status: string | null; error: string | null }> {
  const safeUpi = upiValue.slice(0, 64);
  const customBody = config.bodyTemplate.split(UPI_PLACEHOLDER).join(safeUpi);
  const custom = await sendExotelBody(
    phone,
    customBody,
    config,
    config.dltTemplateId,
    "upi-change-alert",
  );
  if (custom.sid) {
    const polled = await pollUntilTerminal(custom.sid, config);
    const status = polled.status ?? custom.status;
    if (!/fail/i.test(status ?? "")) {
      return { sid: custom.sid, status, error: null };
    }
    return {
      sid: custom.sid,
      status,
      error: `dlt_failed: ${polled.detail}`,
    };
  }

  return {
    sid: custom.sid,
    status: custom.status,
    error: `send_failed: ${custom.raw}`,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    console.error("notify-upi-change missing service role");
    return jsonResponse({ ok: false, error: "misconfigured" });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const { data: secretRow, error: secretErr } = await admin
    .from("app_config")
    .select("value")
    .eq("key", "upi_alert_hook_secret")
    .maybeSingle();
  if (secretErr) {
    console.error("notify-upi-change secret lookup failed", secretErr.message);
    return jsonResponse({ ok: false, error: "secret_lookup_failed" });
  }
  const expected = (secretRow?.value ?? "").trim();
  const provided = (req.headers.get("x-upi-alert-secret") ?? "").trim();
  if (!expected || provided !== expected) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" });
  }

  const lookupSid =
    typeof body.lookup_sms_sid === "string" ? body.lookup_sms_sid.trim() : "";
  if (lookupSid) {
    const smsConfig = readExotelSmsConfig();
    if (!smsConfig) {
      return jsonResponse({ ok: false, error: "exotel_sms_secrets_missing" });
    }
    const detail = await fetchExotelSmsDetail(lookupSid, smsConfig);
    const messageRoot = detail.detail;
    return jsonResponse({
      ok: true,
      sid: lookupSid,
      status: detail.status,
      detailed_status: detail.detail,
      to_last4: (detail.to ?? "").replace(/\D/g, "").slice(-4),
      from: detail.from,
      body_preview: (detail.body ?? "").slice(0, 200),
      date_sent: detail.dateSent,
    });
  }

  const vendorId = typeof body.vendor_id === "string" ? body.vendor_id.trim() : "";
  const oldUpi = typeof body.old_upi === "string" ? body.old_upi : null;
  if (!vendorId) {
    return jsonResponse({ ok: false, error: "vendor_id_required" });
  }

  const { data: vendor, error: vendorErr } = await admin
    .from("vendors")
    .select("id, phone, upi_id, upi_qr_payee_id")
    .eq("id", vendorId)
    .maybeSingle();
  if (vendorErr || !vendor) {
    console.error("notify-upi-change vendor lookup failed", vendorErr?.message);
    return jsonResponse({ ok: false, error: "vendor_not_found" });
  }

  const phone = typeof vendor.phone === "string" ? vendor.phone.trim() : "";
  if (!phone) {
    return jsonResponse({ ok: false, error: "vendor_phone_missing" });
  }

  const newUpi =
    (typeof vendor.upi_id === "string" && vendor.upi_id.trim()) ||
    (typeof vendor.upi_qr_payee_id === "string" && vendor.upi_qr_payee_id.trim()) ||
    (typeof body.new_upi === "string" && body.new_upi.trim()) ||
    "(cleared)";

  const smsConfig = readExotelSmsConfig();
  let exotelSid: string | null = null;
  let exotelStatus: string | null = null;
  let errorText: string | null = null;

  try {
    if (!smsConfig) {
      throw new Error("exotel_sms_secrets_missing");
    }
    const sent = await deliverUpiAlertSms(phone, newUpi, smsConfig);
    exotelSid = sent.sid;
    exotelStatus = sent.status;
    errorText = sent.error;
  } catch (err) {
    errorText = err instanceof Error ? err.message : String(err);
    console.error("notify-upi-change SMS failed", errorText);
  }

  const { error: insertErr } = await admin.from("upi_change_alerts").insert({
    vendor_id: vendorId,
    to_phone: normalizeE164Phone(phone),
    old_upi: oldUpi,
    new_upi: newUpi,
    exotel_sid: exotelSid,
    exotel_status: exotelStatus,
    error: errorText,
  });
  if (insertErr) {
    console.error("notify-upi-change alert insert failed", insertErr.message);
  }

  return jsonResponse({
    ok: !errorText,
    sms_sid: exotelSid,
    status: exotelStatus,
    error: errorText,
  });
});
