import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    const { data: referrer, error: referrerError } = await supabase
      .from("vendors")
      .select("id, created_at")
      .eq("referral_code", referral_code)
      .maybeSingle();

    if (referrerError) {
      console.error("process-vendor-referral referrer lookup failed", referrerError);
      return jsonResponse({ success: false, error: "Database error" });
    }

    if (!referrer) {
      return jsonResponse({ success: false, error: "Invalid referral code" });
    }

    const referralConfig = await loadReferralConfig(supabase);

    const referrerCreated = new Date(referrer.created_at);
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

    if (referralError || !referral) {
      console.error("process-vendor-referral referral insert failed", referralError);
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
