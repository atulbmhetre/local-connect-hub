import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json();
    const userPhone = (body?.user_phone as string | undefined)?.trim();

    if (!userPhone) {
      return jsonResponse({ success: false, error: "user_phone required" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("calculate-trust-score missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return jsonResponse({ success: false, error: "Server misconfigured" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: flags, error: flagsError } = await supabase
      .from("user_flags")
      .select("flag_type")
      .eq("user_phone", userPhone);

    if (flagsError) {
      console.error("calculate-trust-score user_flags query failed", flagsError);
      return jsonResponse({ success: false, error: flagsError.message }, 500);
    }

    let noshowCount = 0;
    let fakeCount = 0;
    let abusiveCount = 0;

    for (const row of flags ?? []) {
      const flagType = row.flag_type as string | null;
      if (flagType === "noshow") noshowCount += 1;
      else if (flagType === "fake") fakeCount += 1;
      else if (flagType === "abusive") abusiveCount += 1;
    }

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("total_orders, completed_orders")
      .eq("phone", userPhone)
      .maybeSingle();

    if (userError) {
      console.error("calculate-trust-score users query failed", userError);
      return jsonResponse({ success: false, error: userError.message }, 500);
    }

    const completedOrders = user?.completed_orders ?? 0;

    let trustScore = 100;
    trustScore -= noshowCount * 15;
    trustScore -= fakeCount * 25;
    trustScore -= abusiveCount * 20;
    trustScore += completedOrders * 2;
    trustScore = Math.max(0, Math.min(100, trustScore));

    const { error: updateError } = await supabase
      .from("users")
      .update({
        trust_score: trustScore,
        noshow_count: noshowCount,
        fake_count: fakeCount,
      })
      .eq("phone", userPhone);

    if (updateError) {
      console.error("calculate-trust-score users update failed", updateError);
      return jsonResponse({ success: false, error: updateError.message }, 500);
    }

    return jsonResponse({ success: true, trust_score: trustScore });
  } catch (err) {
    console.error("calculate-trust-score", err);
    return jsonResponse(
      {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      500,
    );
  }
});
