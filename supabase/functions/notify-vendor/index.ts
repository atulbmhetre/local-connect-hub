import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleAuth } from "npm:google-auth-library@9";

serve(async (req) => {
  try {
    const payload = await req.json();
    const record = payload.record ?? payload;
    const vendorId = record?.vendor_id;
    const message = (record?.message ?? "").substring(0, 100);

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
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
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
            data: {
              title: notificationTitle,
              body: message,
            },
            android: {
              notification: {
                channel_id: "default",
              },
            },
          },
        }),
      },
    );

    if (!fcmRes.ok) {
      const fcmData = await fcmRes.json();
      console.error("notify-vendor fcm_response:", JSON.stringify(fcmData));
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("notify-vendor failed", err);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
});
