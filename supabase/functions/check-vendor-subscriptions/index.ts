import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const PAYMENTS_ENABLED = false; // dormant — flip to true when Razorpay KYC complete

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!PAYMENTS_ENABLED) {
    console.info("check-vendor-subscriptions: dormant mode — skipping");
    return new Response(JSON.stringify({ processed: 0 }), { status: 200, headers: CORS_HEADERS });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Read config
    const { data: configRows } = await supabase
      .from("app_config")
      .select("key, value")
      .in("key", ["vendor_grace_period_days", "global_billing_start_date", "vendor_trial_days"]);

    const config = Object.fromEntries(
      (configRows ?? []).map((r: { key: string; value: string }) => [r.key, r.value])
    );
    const graceDays = parseInt(config["vendor_grace_period_days"] ?? "3");
    const trialDays = parseInt(config["vendor_trial_days"] ?? "30");
    const globalBillingStart = config["global_billing_start_date"]?.trim()
      ? new Date(config["global_billing_start_date"])
      : null;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const now = new Date();
    let processed = 0;

    // --- 1. Trial → Grace ---
    // Vendors in trial whose trial_ends_at has passed
    const { data: trialExpired } = await supabase
      .from("vendors")
      .select("id, phone, created_at, trial_ends_at")
      .eq("subscription_status", "trial")
      .lt("trial_ends_at", now.toISOString());

    for (const vendor of trialExpired ?? []) {
      // Respect global_billing_start_date
      if (globalBillingStart && now < globalBillingStart) continue;

      const graceEndsAt = new Date(now);
      graceEndsAt.setDate(graceEndsAt.getDate() + graceDays);

      await supabase
        .from("vendors")
        .update({
          subscription_status: "grace",
          grace_ends_at: graceEndsAt.toISOString(),
        })
        .eq("id", vendor.id);

      // Inbox + push notification
      await supabase.from("user_notifications").insert({
        user_phone: vendor.phone,
        type: "subscription_update",
        title: "Free trial ended",
        body: `Your free trial has ended. Please subscribe for ₹99/month within ${graceDays} days to keep your shop live.`,
        route: "settings",
        is_informational: false,
      });

      await fetch(`${supabaseUrl}/functions/v1/notify-vendor`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vendor_id: vendor.id,
          notification_title: "Free trial ended",
          message: `Your free trial has ended. Subscribe for ₹99/month within ${graceDays} days to keep your shop live.`,
          type: "subscription_update",
          route: "settings",
          skip_inbox: true,
        }),
      });

      processed += 1;
    }

    // --- 2. Grace → Expired ---
    // Vendors in grace whose grace_ends_at has passed
    const { data: graceExpired } = await supabase
      .from("vendors")
      .select("id, phone, grace_ends_at")
      .eq("subscription_status", "grace")
      .lt("grace_ends_at", now.toISOString());

    for (const vendor of graceExpired ?? []) {
      await supabase
        .from("vendors")
        .update({
          subscription_status: "expired",
          is_active: false,
        })
        .eq("id", vendor.id);

      await supabase.from("user_notifications").insert({
        user_phone: vendor.phone,
        type: "subscription_update",
        title: "Shop is now offline",
        body: "Your grace period has ended. Your shop is now offline. Renew your subscription to go live again.",
        route: "settings",
        is_informational: false,
      });

      await fetch(`${supabaseUrl}/functions/v1/notify-vendor`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vendor_id: vendor.id,
          notification_title: "Shop is now offline",
          message: "Your grace period has ended. Your shop is now offline. Renew to go live again.",
          type: "subscription_update",
          route: "settings",
          skip_inbox: true,
        }),
      });

      processed += 1;
    }

    // --- 3. Recalculate trial_ends_at if global_billing_start_date set ---
    // For vendors whose trial_ends_at should be MAX(global_billing_start, created_at + trial_days)
    if (globalBillingStart) {
      const { data: trialVendors } = await supabase
        .from("vendors")
        .select("id, created_at, trial_ends_at")
        .eq("subscription_status", "trial");

      for (const vendor of trialVendors ?? []) {
        const perVendorTrialEnd = new Date(vendor.created_at);
        perVendorTrialEnd.setDate(perVendorTrialEnd.getDate() + trialDays);
        const correctTrialEnd = perVendorTrialEnd > globalBillingStart
          ? perVendorTrialEnd
          : globalBillingStart;

        const currentTrialEnd = new Date(vendor.trial_ends_at);
        // Only update if different by more than 1 hour (avoid noise)
        if (Math.abs(correctTrialEnd.getTime() - currentTrialEnd.getTime()) > 3600000) {
          await supabase
            .from("vendors")
            .update({ trial_ends_at: correctTrialEnd.toISOString() })
            .eq("id", vendor.id);
        }
      }
    }

    return new Response(JSON.stringify({ processed }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    console.error("check-vendor-subscriptions failed", err);
    return new Response(JSON.stringify({ processed: 0 }), { status: 200, headers: CORS_HEADERS });
  }
});
