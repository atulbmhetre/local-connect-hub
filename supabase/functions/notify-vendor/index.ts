import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleAuth } from "npm:google-auth-library@9";
import { deleteStaleToken } from "../_shared/fcm-cleanup.ts";
import { buildVendorFcmData } from "../_shared/notification-routes.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

async function logFcmDelivery(
  supabase: ReturnType<typeof createClient>,
  opts: {
    notification_type: string;
    target_phone: string | null;
    success: boolean;
    raw_response: string;
  },
): Promise<void> {
  try {
    await supabase.from("fcm_delivery_log").insert({
      notification_type: opts.notification_type,
      target_phone: opts.target_phone,
      success_count: opts.success ? 1 : 0,
      failure_count: opts.success ? 0 : 1,
      raw_response: opts.raw_response.slice(0, 500),
    });
  } catch (err) {
    console.error("notify-vendor fcm_delivery_log insert failed", err);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text && text.trim()) {
      body = JSON.parse(text) as Record<string, unknown>;
    }
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  try {
    const payload = body;
    const record = (payload.record ?? payload) as Record<string, unknown>;
    const vendorId = record?.vendor_id as string | undefined;
    const message = String(record?.message ?? "").substring(0, 100);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const requestId =
      typeof record?.request_id === "string" ? record.request_id.trim() : "";
    let categoryFromRequest: string | null = null;
    if (requestId) {
      const { data: reqRow } = await supabase
        .from("requests")
        .select("category_id, categories(label)")
        .eq("id", requestId)
        .maybeSingle();
      const joined = reqRow?.categories;
      const cat = Array.isArray(joined) ? joined[0] : joined;
      if (cat && typeof cat === "object" && "label" in cat && typeof cat.label === "string") {
        categoryFromRequest = cat.label;
      }
    }

    const { data: vendor } = await supabase
      .from("vendors")
      .select("fcm_token, category, phone")
      .eq("id", vendorId)
      .single();

    const categoryKey =
      categoryFromRequest ??
      (typeof record?.category === "string" ? record.category : null) ??
      vendor?.category ??
      "New";

    let notificationTitle = record?.notification_title as string | undefined;
    if (!notificationTitle) {
      let displayLabel = categoryKey;
      let emoji = "";
      const { data: catRow } = await supabase
        .from("categories")
        .select("label, emoji")
        .eq("label", categoryKey)
        .maybeSingle();
      if (catRow?.label) {
        displayLabel = catRow.label;
        emoji = (catRow.emoji ?? "").trim();
      }
      notificationTitle = emoji
        ? `New Order — ${emoji} ${displayLabel}`
        : `New Order — ${displayLabel}`;
    }

    const fcmData = buildVendorFcmData(
      record,
      String(vendorId ?? ""),
      notificationTitle,
      message,
    );

    const vendorPhone =
      typeof vendor?.phone === "string" ? vendor.phone.trim() : "";
    let inboxRoute = fcmData.route ?? null;
    let inboxRouteParams: Record<string, string> | undefined;
    if (fcmData.route_params) {
      try {
        inboxRouteParams = JSON.parse(fcmData.route_params) as Record<string, string>;
      } catch {
        inboxRouteParams = undefined;
      }
    }

    if (vendorPhone && (notificationTitle.trim() || message.trim())) {
      try {
        const { error: inboxError } = await supabase.from("user_notifications").insert({
          user_phone: vendorPhone,
          title: notificationTitle,
          body: message,
          type: (record?.type as string | undefined) ?? "notification",
          route: inboxRoute,
          route_params: inboxRouteParams ?? null,
          is_informational: false,
          read_at: null,
        });
        if (inboxError) {
          console.error("notify-vendor inbox insert failed", inboxError);
        }
      } catch (inboxErr) {
        console.error("notify-vendor inbox insert failed", inboxErr);
      }
    }

    if (!vendor?.fcm_token) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS });
    }

    const clientEmail = Deno.env.get("FCM_CLIENT_EMAIL")!;
    const privateKey = Deno.env.get("FCM_PRIVATE_KEY")!.replace(/\\n/g, "\n");
    const projectId = Deno.env.get("FCM_PROJECT_ID")!;

    const auth = new GoogleAuth({
      credentials: {
        client_email: clientEmail,
        private_key: privateKey,
      },
      scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
    });

    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const accessToken = tokenResponse.token;

    const fcmRes = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: vendor.fcm_token,
            notification: {
              title: notificationTitle,
              body: message,
            },
            data: fcmData,
            android: {
              priority: "high",
              notification: {
                channel_id: "order_alert",
                notification_priority: "PRIORITY_MAX",
                visibility: "PUBLIC",
              },
            },
          },
        }),
      },
    );

    const rawResponse = await fcmRes.text();

    if (fcmRes.ok) {
      await logFcmDelivery(supabase, {
        notification_type: "vendor-new-order",
        target_phone: typeof vendor.phone === "string" ? vendor.phone.trim() : null,
        success: true,
        raw_response: rawResponse,
      });
    } else {
      let fcmError: Record<string, unknown> | null = null;
      try {
        fcmError = JSON.parse(rawResponse) as Record<string, unknown>;
      } catch {
        fcmError = null;
      }
      console.error("notify-vendor fcm_response:", rawResponse);
      await logFcmDelivery(supabase, {
        notification_type: "vendor-new-order",
        target_phone: typeof vendor.phone === "string" ? vendor.phone.trim() : null,
        success: false,
        raw_response: rawResponse,
      });
      if (
        fcmError &&
        typeof fcmError === "object" &&
        fcmError.error &&
        typeof fcmError.error === "object"
      ) {
        const errObj = fcmError.error as { status?: string; code?: number };
        if (errObj.status === "UNREGISTERED" || errObj.code === 404) {
          await deleteStaleToken(
            vendor.fcm_token,
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
          );
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    console.error("notify-vendor failed", err);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS });
  }
});
