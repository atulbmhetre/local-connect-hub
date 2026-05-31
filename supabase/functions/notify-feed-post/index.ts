import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleAuth } from "npm:google-auth-library@9";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type NotifyFeedPostBody = {
  post_id?: string;
  post_type?: string;
  title?: string;
  body?: string;
  lat?: number;
  lng?: number;
  author_phone?: string;
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

function notificationType(postType: string): string {
  return postType === "announcement" ? "feed_announcement" : "feed_recommendation";
}

async function getFcmAccessToken(): Promise<string | null> {
  const clientEmail = Deno.env.get("FCM_CLIENT_EMAIL");
  const privateKey = Deno.env.get("FCM_PRIVATE_KEY")?.replace(/\\n/g, "\n");
  const projectId = Deno.env.get("FCM_PROJECT_ID");
  if (!clientEmail || !privateKey || !projectId) {
    console.error("notify-feed-post missing FCM credentials");
    return null;
  }

  const auth = new GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });

  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse.token ?? null;
}

async function sendFcmPush(
  accessToken: string,
  projectId: string,
  fcmToken: string,
  title: string,
  body: string,
): Promise<boolean> {
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
            notification: { title, body },
            data: { title, body },
            android: {
              notification: {
                channel_id: "default",
              },
            },
          },
        }),
      },
    );

    if (fcmRes.ok) return true;
    const fcmData = await fcmRes.json();
    console.error("notify-feed-post fcm_response:", JSON.stringify(fcmData));
    return false;
  } catch (err) {
    console.error("notify-feed-post token send failed", err);
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  let parsed: NotifyFeedPostBody = {};
  try {
    const text = await req.text();
    if (text && text.trim()) {
      parsed = JSON.parse(text) as NotifyFeedPostBody;
    }
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const lat = Number(parsed.lat);
  const lng = Number(parsed.lng);
  const authorPhone = String(parsed.author_phone ?? "").trim();
  const postType = String(parsed.post_type ?? "").trim();
  const title = String(parsed.title ?? "").substring(0, 100);
  const body = String(parsed.body ?? "").substring(0, 100);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !authorPhone ||
    !postType ||
    !title
  ) {
    return jsonResponse({ error: "missing_required_fields" }, 400);
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: devices, error: devicesError } = await supabase
      .from("user_devices")
      .select("user_phone, fcm_token")
      .eq("feed_notifications_enabled", true)
      .gte("last_lat", lat - 0.45)
      .lte("last_lat", lat + 0.45)
      .gte("last_lng", lng - 0.45)
      .lte("last_lng", lng + 0.45)
      .gt("last_location_at", thirtyDaysAgo)
      .neq("user_phone", authorPhone)
      .not("fcm_token", "is", null);

    if (devicesError) {
      console.error("notify-feed-post user_devices query failed", devicesError);
      return jsonResponse({ notified: 0 });
    }

    const rows = (devices ?? []).filter(
      (row): row is { user_phone: string; fcm_token: string } =>
        typeof row.user_phone === "string" &&
        row.user_phone.length > 0 &&
        typeof row.fcm_token === "string" &&
        row.fcm_token.trim().length > 0,
    );

    if (rows.length === 0) {
      return jsonResponse({ notified: 0 });
    }

    const notifType = notificationType(postType);
    const uniquePhones = [...new Set(rows.map((r) => r.user_phone))];

    const inboxRows = uniquePhones.map((user_phone) => ({
      user_phone,
      type: notifType,
      title,
      body,
      route: "feed",
      route_params: null,
      is_informational: false,
      is_read: false,
    }));

    const { error: insertError } = await supabase
      .from("user_notifications")
      .insert(inboxRows);

    if (insertError) {
      console.error("notify-feed-post user_notifications insert failed", insertError);
    }

    const projectId = Deno.env.get("FCM_PROJECT_ID");
    const accessToken = projectId ? await getFcmAccessToken() : null;

    if (accessToken && projectId) {
      for (const row of rows) {
        await sendFcmPush(
          accessToken,
          projectId,
          row.fcm_token.trim(),
          title,
          body,
        );
      }
    }

    return jsonResponse({ notified: uniquePhones.length });
  } catch (err) {
    console.error("notify-feed-post failed", err);
    return jsonResponse({ notified: 0 });
  }
});
