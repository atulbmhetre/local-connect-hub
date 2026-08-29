import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

/**
 * Supabase Auth Send SMS hook.
 *
 * Supabase Auth is the sole OTP authority. This function only delivers the
 * code Auth already generated (`sms.otp` on the hook payload) as plain SMS
 * via Exotel's standard SMS-send API — not ExoVerify (which would mint a
 * second, conflicting OTP).
 *
 * Live send requires ALL of the SMS-specific secrets below. Calling-only
 * secrets (EXOTEL_SID / API_KEY / API_TOKEN) are not enough, so existing
 * voice credentials cannot accidentally flip this hook live.
 *
 * Dormant (any SMS secret missing): log + write `_test_otp_capture`.
 * Playwright phone-auth tests depend on that path.
 *
 * --- Secrets (Dashboard → Project → Edge Functions → Secrets, per project) ---
 *
 * Reused from voice, if already present:
 *   EXOTEL_SID
 *   EXOTEL_API_KEY
 *   EXOTEL_API_TOKEN
 *
 * SMS-specific (must be added before live send):
 *   EXOTEL_SMS_FROM          DLT-registered 6-char sender header (From)
 *   EXOTEL_DLT_ENTITY_ID     VilPower / DLT Principal Entity ID
 *   EXOTEL_DLT_TEMPLATE_ID   VilPower-approved content template ID
 *   EXOTEL_SMS_BODY_TEMPLATE Exact approved wording with `{otp}` as the only
 *                            variable slot (replace VilPower `{#var#}` with `{otp}`)
 *
 * Optional:
 *   EXOTEL_API_HOST          default api.exotel.com (Mumbai: api.in.exotel.com)
 *   EXOTEL_SMS_TYPE          default transactional (covers OTP + service-implicit)
 *
 * Also required for the hook itself (already used):
 *   SEND_SMS_HOOK_SECRET     Auth hook signing secret
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  dormant OTP capture only
 *
 * Do not set EXOVERIFY_APP_ID / EXOVERIFY_APP_SECRET — unused.
 */

type SendSmsHookUser = {
  phone?: string;
};

type SendSmsHookPayload = {
  otp?: string;
};

type VerifiedHook = {
  user: SendSmsHookUser;
  sms: SendSmsHookPayload;
};

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

const OTP_PLACEHOLDER = "{otp}";
const DEFAULT_EXOTEL_API_HOST = "api.exotel.com";
const DEFAULT_SMS_TYPE = "transactional";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function hookError(message: string, httpCode = 500) {
  return jsonResponse({ error: { http_code: httpCode, message } }, httpCode);
}

function envTrim(name: string): string {
  return Deno.env.get(name)?.trim() ?? "";
}

function readExotelSmsConfig(): ExotelSmsConfig | null {
  const sid = envTrim("EXOTEL_SID");
  const apiKey = envTrim("EXOTEL_API_KEY");
  const apiToken = envTrim("EXOTEL_API_TOKEN");
  const from = envTrim("EXOTEL_SMS_FROM");
  const dltEntityId = envTrim("EXOTEL_DLT_ENTITY_ID");
  const dltTemplateId = envTrim("EXOTEL_DLT_TEMPLATE_ID");
  const bodyTemplate = envTrim("EXOTEL_SMS_BODY_TEMPLATE");

  if (
    !sid ||
    !apiKey ||
    !apiToken ||
    !from ||
    !dltEntityId ||
    !dltTemplateId ||
    !bodyTemplate.includes(OTP_PLACEHOLDER)
  ) {
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

/** Replace the single `{otp}` slot. Body must otherwise match the DLT template character-for-character. */
function buildSmsBody(template: string, otp: string): string {
  return template.split(OTP_PLACEHOLDER).join(otp);
}

function normalizeE164Phone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return trimmed.startsWith("+") ? trimmed : `+${digits}`;
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

async function deliverViaExotelSms(
  phone: string,
  supabaseOtp: string,
  config: ExotelSmsConfig,
): Promise<void> {
  const to = normalizeE164Phone(phone);
  const body = buildSmsBody(config.bodyTemplate, supabaseOtp);
  const auth = btoa(`${config.apiKey}:${config.apiToken}`);

  const form = new URLSearchParams({
    From: config.from,
    To: to,
    Body: body,
    DltEntityId: config.dltEntityId,
    DltTemplateId: config.dltTemplateId,
    SmsType: config.smsType,
    Priority: "high",
    CustomField: "supabase-phone-otp",
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
  const normalizedStatus = (status ?? "").toLowerCase();
  if (normalizedStatus.startsWith("failed")) {
    throw new Error(
      `Exotel SMS send rejected (status=${status}${sid ? `, sid=${sid}` : ""}): ${text}`,
    );
  }

  console.log("Exotel SMS send accepted", {
    sms_sid: sid,
    status: status ?? "unknown",
  });
}

async function captureOtpForTests(phone: string, otp: string): Promise<void> {
  const normalizedPhone = normalizeE164Phone(phone);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    console.warn("sms-hook: missing service role — skipping _test_otp_capture");
    return;
  }

  const admin = createClient(url, key, { auth: { persistSession: false } });
  const { error } = await admin.from("_test_otp_capture").insert({
    phone: normalizedPhone,
    otp,
  });
  if (error) {
    console.error("sms-hook: _test_otp_capture insert failed", error.message);
  }
}

serve(async (req) => {
  if (req.method !== "POST") {
    return hookError("Method not allowed", 405);
  }

  const hookSecret = Deno.env.get("SEND_SMS_HOOK_SECRET");
  if (!hookSecret?.trim()) {
    return hookError("SEND_SMS_HOOK_SECRET is not configured", 500);
  }

  const payloadText = await req.text();
  const headers = Object.fromEntries(req.headers.entries());
  const secret = hookSecret.replace(/^v1,whsec_/, "");

  let verified: VerifiedHook;
  try {
    const wh = new Webhook(secret);
    verified = wh.verify(payloadText, headers) as VerifiedHook;
  } catch (err) {
    console.error("sms-hook: webhook signature verification failed", err);
    return hookError("Invalid webhook signature", 401);
  }

  const phone = verified.user?.phone?.trim() ?? "";
  const otp = verified.sms?.otp?.trim() ?? "";

  if (!phone || !otp) {
    return hookError("Missing phone or OTP in hook payload", 400);
  }

  try {
    const smsConfig = readExotelSmsConfig();
    // Always capture for Playwright, including live send (TEST reads `_test_otp_capture`).
    await captureOtpForTests(phone, otp);
    if (!smsConfig) {
      console.log("DORMANT SMS HOOK — would send OTP", { phone, otp });
      return jsonResponse({});
    }

    await deliverViaExotelSms(phone, otp, smsConfig);
    return jsonResponse({});
  } catch (err) {
    const message = err instanceof Error ? err.message : "SMS delivery failed";
    console.error("sms-hook delivery error", message);
    return hookError(message, 502);
  }
});
