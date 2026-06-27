import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleAuth } from "npm:google-auth-library@9";
import { deleteStaleToken } from "../_shared/fcm-cleanup.ts";
import { buildFcmData } from "../_shared/notification-routes.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

async function getAdminPhoneFromConfig(
  supabaseClient: ReturnType<typeof createClient>,
): Promise<string | null> {
  const { data, error } = await supabaseClient
    .from("app_config")
    .select("value")
    .eq("key", "admin_phone")
    .maybeSingle();

  if (error) {
    console.error("notify-admin admin_phone config query failed", error);
    return null;
  }

  const phone = data?.value?.trim() ?? "";
  return phone.length > 0 ? phone : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let parsed: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text && text.trim()) {
      parsed = JSON.parse(text) as Record<string, unknown>;
    }
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  try {
    const payload = parsed;
    const title = String(payload?.title ?? "").substring(0, 100);
    const body = String(payload?.body ?? "").substring(0, 100);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Look up current admin FCM token dynamically by admin phone
    const adminPhone =
      Deno.env.get("ADMIN_PHONE") ?? (await getAdminPhoneFromConfig(supabase));

    if (!adminPhone) {
      console.warn("notify-admin: no admin phone configured");
      return new Response(JSON.stringify({ ok: false, reason: "no_token" }), {
        status: 200,
        headers: CORS_HEADERS,
      });
    }

    const { data: deviceRow } = await supabase
      .from("user_devices")
      .select("fcm_token")
      .eq("user_phone", adminPhone)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const adminFcmToken = deviceRow?.fcm_token?.trim() ?? "";

    if (adminPhone.trim() && (title.trim() || body.trim())) {
      try {
        const { error: inboxError } = await supabase.from("user_notifications").insert({
          user_phone: adminPhone.trim(),
          title,
          body,
          type: (payload?.type as string | undefined) ?? "notification",
          route: (payload?.route as string | undefined) ?? null,
          route_params: (payload?.route_params as Record<string, string> | undefined) ?? null,
          is_informational: false,
          read_at: null,
        });
        if (inboxError) {
          console.error("notify-admin inbox insert failed", inboxError);
        }
      } catch (inboxErr) {
        console.error("notify-admin inbox insert failed", inboxErr);
      }
    }

    if (!adminFcmToken) {
      console.warn("notify-admin: no FCM token found for admin phone", adminPhone);
      return new Response(JSON.stringify({ ok: false, reason: "no_token" }), {
        status: 200,
        headers: CORS_HEADERS,
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
        headers: CORS_HEADERS,
      });
    }

    const fcmData = buildFcmData(payload, title, body);

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
            token: adminFcmToken,
            notification: {
              title,
              body,
            },
            data: fcmData,
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
      if (fcmData?.error?.status === "UNREGISTERED" || fcmData?.error?.code === 404) {
        await deleteStaleToken(
          adminFcmToken,
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
      }
      return new Response(JSON.stringify({ success: false, reason: "fcm_send_failed" }), {
        status: 200,
        headers: CORS_HEADERS,
      });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    console.error("notify-admin failed", err);
    return new Response(JSON.stringify({ success: false, reason: "unexpected_error" }), {
      status: 200,
      headers: CORS_HEADERS,
    });
  }
});
