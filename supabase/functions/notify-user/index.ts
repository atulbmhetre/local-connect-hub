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
    const userPhone = payload?.user_phone as string | undefined;
    const directToken = (payload?.fcm_token as string | undefined)?.trim();
    const title = String(payload?.title ?? "").substring(0, 100);
    const body = String(payload?.body ?? "").substring(0, 100);

    if (!userPhone?.trim() && !directToken) {
      return new Response(JSON.stringify({ sent: 0 }), { status: 200, headers: CORS_HEADERS });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const fcmData = buildFcmData(payload, title, body);
    let route =
      typeof payload.route === "string" && payload.route.trim()
        ? payload.route.trim()
        : fcmData.route ?? null;
    let routeParams =
      payload.route_params && typeof payload.route_params === "object"
        ? (payload.route_params as Record<string, string>)
        : undefined;
    if (!routeParams && fcmData.route_params) {
      try {
        routeParams = JSON.parse(fcmData.route_params) as Record<string, string>;
      } catch {
        routeParams = undefined;
      }
    }

    if (userPhone?.trim() && (title.trim() || body.trim())) {
      try {
        const { error: inboxError } = await supabase.from("user_notifications").insert({
          user_phone: userPhone.trim(),
          title,
          body,
          type: (payload?.type as string | undefined) ?? "notification",
          route,
          route_params: routeParams ?? null,
          is_informational: (payload?.is_informational as boolean | undefined) ?? false,
          read_at: null,
        });
        if (inboxError) {
          console.error("notify-user inbox insert failed", inboxError);
        }
      } catch (inboxErr) {
        console.error("notify-user inbox insert failed", inboxErr);
      }
    }

    let tokens: string[] = [];

    if (directToken) {
      tokens = [directToken];
    } else if (userPhone) {
      const { data: devices, error } = await supabase
        .from("user_devices")
        .select("fcm_token")
        .eq("user_phone", userPhone);

      if (error) {
        console.error("notify-user user_devices query failed", error);
      } else {
        tokens = (devices ?? [])
          .map((row) => row.fcm_token)
          .filter((token): token is string => typeof token === "string" && token.length > 0);
      }
    }

    if (tokens.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), { status: 200, headers: CORS_HEADERS });
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
      console.error("notify-user failed to obtain FCM access token");
      return new Response(JSON.stringify({ sent: 0 }), { status: 200, headers: CORS_HEADERS });
    }

    let sent = 0;

    for (const fcmToken of tokens) {
      try {
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
                token: fcmToken,
                notification: {
                  title,
                  body,
                },
                data: fcmData,
                android: {
                  priority: "high",
                  notification: {
                    channel_id: "order_alert",
                  },
                },
              },
            }),
          },
        );

        if (fcmRes.ok) {
          sent += 1;
        } else {
          const fcmData = await fcmRes.json();
          console.error("notify-user fcm_response:", JSON.stringify(fcmData));
          if (fcmData?.error?.status === "UNREGISTERED" || fcmData?.error?.code === 404) {
            await deleteStaleToken(
              fcmToken,
              Deno.env.get("SUPABASE_URL")!,
              Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
            );
          }
        }
      } catch (tokenErr) {
        console.error("notify-user token send failed", tokenErr);
      }
    }

    return new Response(JSON.stringify({ sent }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    console.error("notify-user failed", err);
    return new Response(JSON.stringify({ sent: 0 }), { status: 200, headers: CORS_HEADERS });
  }
});
