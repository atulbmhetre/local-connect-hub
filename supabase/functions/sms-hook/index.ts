import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

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

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function hookError(message: string, httpCode = 500) {
  return jsonResponse({ error: { http_code: httpCode, message } }, httpCode);
}

function isExoVerifyConfigured(): boolean {
  return Boolean(
    Deno.env.get("EXOVERIFY_APP_ID")?.trim() &&
      Deno.env.get("EXOVERIFY_APP_SECRET")?.trim(),
  );
}

/** ExoVerify Start Verification API shape (live mode when KYC credentials exist). */
async function deliverViaExoVerify(phone: string, supabaseOtp: string): Promise<void> {
  const appId = Deno.env.get("EXOVERIFY_APP_ID")!.trim();
  const appSecret = Deno.env.get("EXOVERIFY_APP_SECRET")!.trim();
  const accountSid = Deno.env.get("EXOTEL_SID")?.trim() ?? "default";

  const auth = btoa(`${appId}:${appSecret}`);
  const res = await fetch(
    `https://exoverify.exotel.com/v2/accounts/${accountSid}/verifications/sms`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        application_id: appId,
        phone_number: phone,
        // Template vars for DLT-approved templates; Supabase OTP logged for Phase B wiring.
        replace_vars: [supabaseOtp],
      }),
    },
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ExoVerify Start Verification failed (${res.status}): ${text}`);
  }
  console.log("ExoVerify Start Verification response", text);
}

function normalizeE164Phone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return trimmed.startsWith("+") ? trimmed : `+${digits}`;
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
    if (!isExoVerifyConfigured()) {
      console.log("DORMANT SMS HOOK — would send OTP", { phone, otp });
      await captureOtpForTests(phone, otp);
      return jsonResponse({});
    }

    await deliverViaExoVerify(phone, otp);
    return jsonResponse({});
  } catch (err) {
    const message = err instanceof Error ? err.message : "SMS delivery failed";
    console.error("sms-hook delivery error", message);
    return hookError(message, 502);
  }
});
