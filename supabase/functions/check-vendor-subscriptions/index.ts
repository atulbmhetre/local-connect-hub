import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  addUtcDays,
  shouldSkipGraceToExpired,
  shouldSkipTrialToGrace,
  vendorEffectiveTrialEnd,
} from "../_shared/vendorSubscriptionTransitions.ts";

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

    const { data: openWindows } = await supabase
      .from("vendor_billing_pauses")
      .select("vendor_id")
      .is("ended_at", null);
    const openBillingVendors = new Set(
      (openWindows ?? []).map((w: { vendor_id: string }) => w.vendor_id),
    );

    // --- 1. Trial → Grace ---
    // Source of truth: created_at + vendor_trial_days + pause_credit_days (not trial_ends_at).
    const { data: trialVendors } = await supabase
      .from("vendors")
      .select("id, phone, created_at, pause_credit_days")
      .eq("subscription_status", "trial");

    for (const vendor of trialVendors ?? []) {
      const hasOpenBillingWindow = openBillingVendors.has(vendor.id);
      if (
        shouldSkipTrialToGrace({
          now,
          createdAt: vendor.created_at,
          vendorTrialDays: trialDays,
          pauseCreditDays: Number(vendor.pause_credit_days ?? 0),
          globalBillingStart,
          hasOpenBillingWindow,
        })
      ) {
        continue;
      }

      const graceEndsAt = addUtcDays(now, graceDays);

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
    const { data: graceVendors } = await supabase
      .from("vendors")
      .select("id, phone, grace_ends_at")
      .eq("subscription_status", "grace");

    for (const vendor of graceVendors ?? []) {
      if (
        !vendor.grace_ends_at ||
        shouldSkipGraceToExpired({
          now,
          graceEndsAt: vendor.grace_ends_at,
          hasOpenBillingWindow: openBillingVendors.has(vendor.id),
        })
      ) {
        continue;
      }

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
    // Display column only. Transitions above do not read trial_ends_at.
    // Include pause_credit_days so the stored timestamp matches vendor_effective_trial_end
    // (then MAX with global billing start).
    if (globalBillingStart) {
      const { data: trialForStamp } = await supabase
        .from("vendors")
        .select("id, created_at, trial_ends_at, pause_credit_days")
        .eq("subscription_status", "trial");

      for (const vendor of trialForStamp ?? []) {
        const perVendorTrialEnd = vendorEffectiveTrialEnd({
          createdAt: vendor.created_at,
          vendorTrialDays: trialDays,
          pauseCreditDays: Number(vendor.pause_credit_days ?? 0),
        });
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
