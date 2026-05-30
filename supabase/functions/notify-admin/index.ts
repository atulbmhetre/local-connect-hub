import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleAuth } from "npm:google-auth-library@9";

serve(async (req) => {
  let parsed: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text && text.trim()) {
      parsed = JSON.parse(text) as Record<string, unknown>;
    }
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const payload = parsed;
    const title = String(payload?.title ?? "").substring(0, 100);
    const body = String(payload?.body ?? "").substring(0, 100);
    const data =
      payload?.data != null && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? (payload.data as Record<string, unknown>)
        : {};

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: configRow, error: configError } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "admin_fcm_token")
      .maybeSingle();

    if (configError) {
      console.error("notify-admin app_config query failed", configError);
      return new Response(JSON.stringify({ success: false, reason: "no_admin_token" }), {
        status: 200,
      });
    }

    const adminToken = configRow?.value?.trim() ?? "";
    if (!adminToken) {
      return new Response(JSON.stringify({ success: false, reason: "no_admin_token" }), {
        status: 200,
      });
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

    if (!accessToken) {
      console.error("notify-admin failed to obtain FCM access token");
      return new Response(JSON.stringify({ success: false, reason: "fcm_auth_failed" }), {
        status: 200,
      });
    }

    const stringData: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      stringData[key] = typeof value === "string" ? value : JSON.stringify(value);
    }

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
            token: adminToken,
            notification: {
              title,
              body,
            },
            data: {
              ...stringData,
              title,
              body,
            },
            android: {
              priority: "high",
              notification: {
                channel_id: "order_alert",
                sound: "default",
                notification_priority: "PRIORITY_MAX",
                visibility: "PUBLIC",
              },
            },
            apns: {
              payload: {
                aps: {
                  sound: "default",
                  badge: 1,
                },
              },
            },
          },
        }),
      },
    );

    if (!fcmRes.ok) {
      const fcmData = await fcmRes.json();
      console.error("notify-admin fcm_response:", JSON.stringify(fcmData));
      return new Response(JSON.stringify({ success: false, reason: "fcm_send_failed" }), {
        status: 200,
      });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err) {
    console.error("notify-admin failed", err);
    return new Response(JSON.stringify({ success: false, reason: "unexpected_error" }), {
      status: 200,
    });
  }
});
