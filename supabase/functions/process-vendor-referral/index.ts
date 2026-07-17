import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { clientIp } from "../_shared/rateLimitUtils.ts";
import {
  REFERRAL_CREDIT_BODY,
  REFERRAL_CREDIT_TITLE,
  REFERRAL_VETERAN_BODY,
  REFERRAL_VETERAN_TITLE,
} from "./constants.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type RequestBody = {
  new_vendor_id?: string;
  referral_code?: string;
};

type ReferralConfig = {
  m1: number;
  m2: number;
  m3: number;
  veteranMonths: number;
};

const DEFAULT_CONFIG: ReferralConfig = {
  m1: 8.34,
  m2: 8.34,
  m3: 8.32,
  veteranMonths: 12,
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : fallback;
}

/** Normalize Indian mobile numbers for comparison (+91 / 91 prefix). */
function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone?.trim()) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  return digits.length > 0 ? digits : null;
}

function formatCreditAmount(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

async function isReferralEnabled(
  supabase: ReturnType<typeof createClient>,
): Promise<boolean> {
  const { data } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "referral_enabled")
    .maybeSingle();
  return String(data?.value ?? "").trim().toLowerCase() === "true";
}

async function notifyReferrer(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  serviceRoleKey: string,
  vendorId: string,
  title: string,
  body: string,
  informational = false,
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/functions/v1/notify-vendor`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        record: {
          vendor_id: vendorId,
          notification_title: title,
          message: body,
          type: "referral_credit",
          skip_inbox: true,
        },
      }),
    });
  } catch (err) {
    console.error("process-vendor-referral notify-vendor failed", err);
  }

  try {
    const { data: vendorRow } = await supabase
      .from("vendors")
      .select("phone")
      .eq("id", vendorId)
      .maybeSingle();

    const vendorPhone = vendorRow?.phone?.trim();
    if (!vendorPhone) return;

    const { error: inboxError } = await supabase.from("user_notifications").insert({
      user_phone: vendorPhone,
      type: "referral_credit",
      title,
      body,
      route: "vendor",
      route_params: { vendor_id: vendorId },
      is_informational: informational,
      is_read: false,
    });
    if (inboxError) {
      console.error("process-vendor-referral inbox insert failed", inboxError);
    }
  } catch (err) {
    console.error("process-vendor-referral inbox insert failed", err);
  }
}

async function loadReferralConfig(
  supabase: ReturnType<typeof createClient>,
): Promise<ReferralConfig> {
  const config = { ...DEFAULT_CONFIG };
  try {
    const { data, error } = await supabase
      .from("app_config")
      .select("key, value")
      .in("key", [
        "referral_vendor_credit_m1",
        "referral_vendor_credit_m2",
        "referral_vendor_credit_m3",
        "referral_veteran_threshold_months",
      ]);

    if (error || !data) return config;

    const byKey = Object.fromEntries(data.map((row) => [row.key, row.value]));
    config.m1 = parseNumber(byKey.referral_vendor_credit_m1, config.m1);
    config.m2 = parseNumber(byKey.referral_vendor_credit_m2, config.m2);
    config.m3 = parseNumber(byKey.referral_vendor_credit_m3, config.m3);
    config.veteranMonths = parseNumber(
      byKey.referral_veteran_threshold_months,
      config.veteranMonths,
    );
  } catch (err) {
    console.error("process-vendor-referral config load failed", err);
  }
  return config;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonResponse({
        success: false,
        error: "Invalid JSON body",
      });
    }

    const new_vendor_id = body.new_vendor_id?.trim();
    const referral_code = body.referral_code?.trim();

    if (!new_vendor_id || !referral_code) {
      return jsonResponse({
        success: false,
        error: "Missing new_vendor_id or referral_code",
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("process-vendor-referral missing Supabase env");
      return jsonResponse({ success: false, error: "Server misconfigured" });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const ip = clientIp(req);
    const { data: allowed, error: rlError } = await supabase.rpc("check_and_log_rate_limit", {
      p_function_name: "process-vendor-referral",
      p_identifier_type: "ip",
      p_identifier: ip,
      p_max_requests: 10,
      p_window_seconds: 60,
    });
    if (rlError) {
      console.error("process-vendor-referral rate limit RPC failed", rlError);
      // fail open — never block a real referral due to a rate-limit infra error
    } else if (allowed === false) {
      return jsonResponse({ success: false, error: "Too many requests, please wait a moment and try again." });
    }

    // Second layer: per new_vendor_id (stops hammering a known id + code combo).
    const { data: allowedVendor, error: rlVendorError } = await supabase.rpc(
      "check_and_log_rate_limit",
      {
        p_function_name: "process-vendor-referral",
        p_identifier_type: "vendor_id",
        p_identifier: new_vendor_id,
        p_max_requests: 5,
        p_window_seconds: 600,
      },
    );
    if (rlVendorError) {
      console.error("process-vendor-referral vendor_id rate limit RPC failed", rlVendorError);
    } else if (allowedVendor === false) {
      return jsonResponse({
        success: false,
        error: "Too many requests, please wait a moment and try again.",
      });
    }

    if (!(await isReferralEnabled(supabase))) {
      return jsonResponse({ skipped: true });
    }

    const { data: referrer, error: referrerError } = await supabase
      .from("vendors")
      .select("id, last_updated, phone")
      .eq("referral_code", referral_code)
      .maybeSingle();

    if (referrerError) {
      console.error("process-vendor-referral referrer lookup failed", referrerError);
      return jsonResponse({ success: false, error: "Database error" });
    }

    if (!referrer) {
      return jsonResponse({ success: false, error: "Invalid referral code" });
    }

    const { data: newVendor, error: newVendorError } = await supabase
      .from("vendors")
      .select("phone")
      .eq("id", new_vendor_id)
      .maybeSingle();

    if (newVendorError) {
      console.error("process-vendor-referral new vendor lookup failed", newVendorError);
      return jsonResponse({ success: false, error: "Database error" });
    }

    const { data: referrerPhoneRow, error: referrerPhoneError } = await supabase
      .from("vendors")
      .select("phone")
      .eq("id", referrer.id)
      .maybeSingle();

    if (referrerPhoneError) {
      console.error("process-vendor-referral referrer phone lookup failed", referrerPhoneError);
      return jsonResponse({ success: false, error: "Database error" });
    }

    const newPhoneNorm = normalizePhone(newVendor?.phone);
    const referrerPhoneNorm = normalizePhone(referrerPhoneRow?.phone ?? referrer.phone);
    if (newPhoneNorm && referrerPhoneNorm && newPhoneNorm === referrerPhoneNorm) {
      return jsonResponse({ success: false, error: "Self-referral not allowed" });
    }

    // Third layer: per new-vendor phone when known (same window as vendor_id).
    if (newPhoneNorm) {
      const { data: allowedPhone, error: rlPhoneError } = await supabase.rpc(
        "check_and_log_rate_limit",
        {
          p_function_name: "process-vendor-referral",
          p_identifier_type: "phone",
          p_identifier: newPhoneNorm,
          p_max_requests: 5,
          p_window_seconds: 600,
        },
      );
      if (rlPhoneError) {
        console.error("process-vendor-referral phone rate limit RPC failed", rlPhoneError);
      } else if (allowedPhone === false) {
        return jsonResponse({
          success: false,
          error: "Too many requests, please wait a moment and try again.",
        });
      }
    }

    const referralConfig = await loadReferralConfig(supabase);

    const referrerCreated = new Date(referrer.last_updated);
    const veteranCutoff = new Date();
    veteranCutoff.setMonth(
      veteranCutoff.getMonth() - referralConfig.veteranMonths,
    );
    const isVeteranReferrer = referrerCreated < veteranCutoff;
    const trigger_rule = isVeteranReferrer ? "first_payment" : "active_once";

    const { data: referral, error: referralError } = await supabase
      .from("referrals")
      .insert({
        referrer_vendor_id: referrer.id,
        referee_type: "vendor",
        referee_id: new_vendor_id,
        status: "pending",
        trigger_rule,
        credits_created: false,
      })
      .select("id")
      .single();

    if (referralError) {
      if (referralError.code === "23505") {
        return jsonResponse({ ok: false, reason: "already_referred" });
      }
      console.error("process-vendor-referral referral insert failed", referralError);
      return jsonResponse({ success: false, error: "Failed to create referral" });
    }

    if (!referral) {
      return jsonResponse({ success: false, error: "Failed to create referral" });
    }

    if (trigger_rule === "active_once") {
      const triggeredAt = new Date().toISOString();

      const { error: creditsError } = await supabase.from("vendor_credits").insert([
        {
          vendor_id: referrer.id,
          referral_id: referral.id,
          amount: referralConfig.m1,
          disbursement_month: 1,
          disbursed: false,
        },
        {
          vendor_id: referrer.id,
          referral_id: referral.id,
          amount: referralConfig.m2,
          disbursement_month: 2,
          disbursed: false,
        },
        {
          vendor_id: referrer.id,
          referral_id: referral.id,
          amount: referralConfig.m3,
          disbursement_month: 3,
          disbursed: false,
        },
      ]);

      if (creditsError) {
        console.error("process-vendor-referral credits insert failed", creditsError);
        return jsonResponse({ success: false, error: "Failed to create credits" });
      }

      const { error: updateError } = await supabase
        .from("referrals")
        .update({
          credits_created: true,
          triggered_at: triggeredAt,
          status: "active",
        })
        .eq("id", referral.id);

      if (updateError) {
        console.error("process-vendor-referral referral update failed", updateError);
        return jsonResponse({ success: false, error: "Failed to update referral" });
      }

      const totalCredit =
        referralConfig.m1 + referralConfig.m2 + referralConfig.m3;
      await notifyReferrer(
        supabase,
        supabaseUrl,
        serviceRoleKey,
        referrer.id,
        REFERRAL_CREDIT_TITLE,
        REFERRAL_CREDIT_BODY(formatCreditAmount(totalCredit)),
      );
    } else {
      await notifyReferrer(
        supabase,
        supabaseUrl,
        serviceRoleKey,
        referrer.id,
        REFERRAL_VETERAN_TITLE,
        REFERRAL_VETERAN_BODY,
        true,
      );
    }

    return jsonResponse({
      success: true,
      trigger_rule,
      referral_id: referral.id,
    });
  } catch (err) {
    console.error("process-vendor-referral failed", err);
    return jsonResponse({ success: false, error: "Internal error" });
  }
});
