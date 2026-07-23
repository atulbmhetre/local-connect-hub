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
    console.error("notify-admin fcm_delivery_log insert failed", err);
  }
}

function adminNotificationType(payload: Record<string, unknown>): string {
  const raw = String(payload?.type ?? "notification").trim() || "notification";
  return raw.startsWith("admin-") ? raw : `admin-${raw}`;
}

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

    const { data: allowed, error: rlError } = await supabase.rpc("check_and_log_rate_limit", {
      p_function_name: "notify-admin",
      p_identifier_type: "phone",
      p_identifier: adminPhone.trim(),
      p_max_requests: 40,
      p_window_seconds: 300,
    });
    if (rlError) {
      console.error("notify-admin rate limit check failed", rlError);
    } else if (allowed === false) {
      return new Response(JSON.stringify({ error: "rate_limited", ok: false }), {
        status: 429,
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

    const rawResponse = await fcmRes.text();
    const notificationType = adminNotificationType(payload);

    if (!fcmRes.ok) {
      let fcmErrorData: Record<string, unknown> | null = null;
      try {
        fcmErrorData = JSON.parse(rawResponse) as Record<string, unknown>;
      } catch {
        fcmErrorData = null;
      }
      console.error("notify-admin fcm_response:", rawResponse);
      await logFcmDelivery(supabase, {
        notification_type: notificationType,
        target_phone: adminPhone.trim(),
        success: false,
        raw_response: rawResponse,
      });
      if (
        fcmErrorData &&
        typeof fcmErrorData === "object" &&
        fcmErrorData.error &&
        typeof fcmErrorData.error === "object"
      ) {
        const errObj = fcmErrorData.error as { status?: string; code?: number };
        if (errObj.status === "UNREGISTERED" || errObj.code === 404) {
          await deleteStaleToken(
            adminFcmToken,
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
          );
        }
      }
      return new Response(JSON.stringify({ success: false, reason: "fcm_send_failed" }), {
        status: 200,
        headers: CORS_HEADERS,
      });
    }

    await logFcmDelivery(supabase, {
      notification_type: notificationType,
      target_phone: adminPhone.trim(),
      success: true,
      raw_response: rawResponse,
    });

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    console.error("notify-admin failed", err);
    return new Response(JSON.stringify({ success: false, reason: "unexpected_error" }), {
      status: 200,
      headers: CORS_HEADERS,
    });
  }
});
