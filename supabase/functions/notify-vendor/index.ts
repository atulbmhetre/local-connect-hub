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

    const { data: vendor } = await supabase
      .from("vendors")
      .select("fcm_token, category")
      .eq("id", vendorId)
      .single();

    if (!vendor?.fcm_token) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS });
    }

    const categoryKey = record?.category ?? vendor?.category ?? "New";

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

    const fcmData = buildVendorFcmData(
      record,
      String(vendorId ?? ""),
      notificationTitle,
      message,
    );

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

    if (!fcmRes.ok) {
      const fcmData = await fcmRes.json();
      console.error("notify-vendor fcm_response:", JSON.stringify(fcmData));
      if (fcmData?.error?.status === "UNREGISTERED" || fcmData?.error?.code === 404) {
        await deleteStaleToken(
          vendor.fcm_token,
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
      }
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    console.error("notify-vendor failed", err);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS });
  }
});
