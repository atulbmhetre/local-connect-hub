import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as crypto from "https://deno.land/std@0.168.0/crypto/mod.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-razorpay-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const PAYMENTS_ENABLED = false; // dormant — flip to true when Razorpay KYC complete

async function verifyWebhookSignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(body);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
  const computedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  return computedSignature === signature;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!PAYMENTS_ENABLED) {
    console.info("razorpay-webhook: dormant mode — ignoring event");
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: CORS_HEADERS });
  }

  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-razorpay-signature") ?? "";
    const webhookSecret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET") ?? "";

    if (!webhookSecret) {
      console.error("razorpay-webhook: RAZORPAY_WEBHOOK_SECRET not set");
      return new Response(JSON.stringify({ error: "misconfigured" }), { status: 500, headers: CORS_HEADERS });
    }

    const valid = await verifyWebhookSignature(rawBody, signature, webhookSecret);
    if (!valid) {
      console.error("razorpay-webhook: invalid signature");
      return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 400, headers: CORS_HEADERS });
    }

    const event = JSON.parse(rawBody) as Record<string, unknown>;
    const eventType = event.event as string;
    const payload = (event.payload as Record<string, unknown>)?.subscription as Record<string, unknown>;
    const entity = payload?.entity as Record<string, unknown>;
    const subscriptionId = entity?.id as string;

    if (!subscriptionId) {
      console.error("razorpay-webhook: no subscription id in payload");
      return new Response(JSON.stringify({ received: true }), { status: 200, headers: CORS_HEADERS });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: vendor, error: vendorError } = await supabase
      .from("vendors")
      .select("id, phone, waiveoff_percent, waiveoff_months_remaining")
      .eq("subscription_id", subscriptionId)
      .single();

    if (vendorError || !vendor) {
      console.error("razorpay-webhook: vendor not found for subscription", subscriptionId);
      return new Response(JSON.stringify({ received: true }), { status: 200, headers: CORS_HEADERS });
    }

    const currentPeriodEnd = entity?.current_end
      ? new Date((entity.current_end as number) * 1000).toISOString()
      : null;

    const gracePeriodDaysRow = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "vendor_grace_period_days")
      .single();
    const graceDays = parseInt(gracePeriodDaysRow.data?.value ?? "3");

    let updatePayload: Record<string, unknown> = {};
    let notificationTitle = "";
    let notificationBody = "";

    switch (eventType) {
      case "subscription.activated":
        updatePayload = {
          subscription_status: "active",
          subscription_current_period_end: currentPeriodEnd,
          grace_ends_at: null,
        };
        notificationTitle = "Subscription active";
        notificationBody = "Your Aaspaas Pro subscription is now active. Your shop is live!";
        break;

      case "subscription.charged": {
        // Apply waive-off if set
        let waiveoffUpdate: Record<string, unknown> = {};
        if (vendor.waiveoff_months_remaining && vendor.waiveoff_months_remaining > 0) {
          const newRemaining = vendor.waiveoff_months_remaining - 1;
          waiveoffUpdate = {
            waiveoff_months_remaining: newRemaining,
            waiveoff_percent: newRemaining === 0 ? null : vendor.waiveoff_percent,
          };
        }
        updatePayload = {
          subscription_status: "active",
          subscription_current_period_end: currentPeriodEnd,
          grace_ends_at: null,
          ...waiveoffUpdate,
        };
        notificationTitle = "Payment successful";
        notificationBody = "₹99 received. Your shop stays live for another month. Thank you!";
        break;
      }

      case "subscription.payment_failed": {
        const graceEndsAt = new Date();
        graceEndsAt.setDate(graceEndsAt.getDate() + graceDays);
        updatePayload = {
          subscription_status: "grace",
          grace_ends_at: graceEndsAt.toISOString(),
        };
        notificationTitle = "Payment failed";
        notificationBody = `Your payment failed. Please update your payment method within ${graceDays} days to keep your shop live.`;
        break;
      }

      case "subscription.cancelled":
        updatePayload = {
          subscription_status: "cancelled",
        };
        notificationTitle = "Subscription cancelled";
        notificationBody = "Your subscription has been cancelled. Your shop will go offline at the end of the current period.";
        break;

      case "subscription.completed":
        updatePayload = {
          subscription_status: "expired",
          is_active: false,
        };
        notificationTitle = "Subscription expired";
        notificationBody = "Your subscription has ended. Renew to bring your shop back online.";
        break;

      default:
        console.info("razorpay-webhook: unhandled event type", eventType);
        return new Response(JSON.stringify({ received: true }), { status: 200, headers: CORS_HEADERS });
    }

    const { error: updateError } = await supabase
      .from("vendors")
      .update(updatePayload)
      .eq("id", vendor.id);

    if (updateError) {
      console.error("razorpay-webhook: vendor update failed", updateError);
    }

    // Notify vendor
    if (notificationTitle && vendor.phone) {
      await supabase.from("user_notifications").insert({
        user_phone: vendor.phone,
        type: "subscription_update",
        title: notificationTitle,
        body: notificationBody,
        route: "settings",
        is_informational: false,
      });

      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      await fetch(`${supabaseUrl}/functions/v1/notify-vendor`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vendor_phone: vendor.phone,
          title: notificationTitle,
          body: notificationBody,
          type: "subscription_update",
        }),
      });
    }

    return new Response(JSON.stringify({ received: true }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    console.error("razorpay-webhook failed", err);
    return new Response(JSON.stringify({ error: "internal" }), { status: 500, headers: CORS_HEADERS });
  }
});
