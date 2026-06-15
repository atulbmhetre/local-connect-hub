import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleAuth } from "npm:google-auth-library@9";
import { deleteStaleToken } from "../_shared/fcm-cleanup.ts";
import { buildFcmData } from "../_shared/notification-routes.ts";
import { FEED_PUSH_TITLES } from "./constants.ts";

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
  vendor_id?: string;
};

type SupabaseClient = ReturnType<typeof createClient>;

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function resolveNotifyBody(
  supabase: SupabaseClient,
  postId: string | undefined,
  postType: string,
  parsedBody: string,
  vendorId: string | undefined,
): Promise<string> {
  const trimmed = parsedBody.trim();
  if (trimmed) return trimmed.substring(0, 100);

  if (postId) {
    const { data: post } = await supabase
      .from("feed_posts")
      .select("content")
      .eq("id", postId)
      .maybeSingle();
    if (post?.content) return String(post.content).substring(0, 100);
  }

  if (postType === "offer" && vendorId) {
    const { data: vendor } = await supabase
      .from("vendors")
      .select("shop_name")
      .eq("id", vendorId)
      .maybeSingle();
    if (vendor?.shop_name) {
      return `${vendor.shop_name} has a new offer for you`.substring(0, 100);
    }
  }

  return "";
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

function notificationType(postType: string): string {
  if (postType === "announcement") return "feed_announcement";
  if (postType === "offer") return "feed_offer";
  return "feed_recommendation";
}

function defaultPushTitle(postType: string): string {
  if (postType === "announcement") return FEED_PUSH_TITLES.announcement;
  if (postType === "offer") return FEED_PUSH_TITLES.offer;
  return FEED_PUSH_TITLES.recommendation;
}

async function maybeNotifyAdminVendorLead(
  supabase: SupabaseClient,
  postId: string | undefined,
  postType: string,
): Promise<void> {
  if (postType !== "recommendation" || !postId) return;

  const { data: enabledRow } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "vendor_lead_notify_enabled")
    .maybeSingle();
  if (enabledRow?.value === "false") return;

  const { data: post } = await supabase
    .from("feed_posts")
    .select("recommended_vendor_id, recommended_vendor_name, recommended_vendor_phone")
    .eq("id", postId)
    .maybeSingle();

  if (post?.recommended_vendor_id) return;

  const name = String(post?.recommended_vendor_name ?? "").trim();
  const phone = String(post?.recommended_vendor_phone ?? "").trim();
  if (!name || !phone) return;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return;

  try {
    await fetch(`${supabaseUrl}/functions/v1/notify-admin`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "New vendor lead",
        body: `${name} (${phone}) recommended by community in your area. Consider inviting them to AasPaas.`,
        data: {
          post_id: postId,
          vendor_name: name,
          vendor_phone: phone,
        },
      }),
    });
  } catch (err) {
    console.error("notify-feed-post vendor lead notify failed", err);
  }
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
  postId: string | undefined,
  notifType: string,
): Promise<boolean> {
  const routeParams = postId ? { post_id: postId } : undefined;
  const fcmData = buildFcmData(
    {
      route: "feed",
      route_params: routeParams,
      type: notifType,
      post_id: postId,
    },
    title,
    body,
  );
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
            data: fcmData,
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
    if (fcmData?.error?.status === "UNREGISTERED" || fcmData?.error?.code === 404) {
      await deleteStaleToken(
        fcmToken,
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
    }
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
  const title = (
    String(parsed.title ?? "").trim() || defaultPushTitle(postType)
  ).substring(0, 100);

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

    const body = await resolveNotifyBody(
      supabase,
      String(parsed.post_id ?? "").trim() || undefined,
      postType,
      String(parsed.body ?? ""),
      String(parsed.vendor_id ?? "").trim() || undefined,
    );

    const { data: radiusRow } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "feed_notification_radius_km")
      .maybeSingle();
    const radiusKm = Number(radiusRow?.value) || 5;

    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: devices, error: devicesError } = await supabase
      .from("user_devices")
      .select("user_phone, fcm_token, last_lat, last_lng")
      .eq("feed_notifications_enabled", true)
      .gt("last_location_at", thirtyDaysAgo)
      .neq("user_phone", authorPhone)
      .not("fcm_token", "is", null)
      .not("last_lat", "is", null)
      .not("last_lng", "is", null);

    if (devicesError) {
      console.error("notify-feed-post user_devices query failed", devicesError);
      await maybeNotifyAdminVendorLead(
        supabase,
        String(parsed.post_id ?? "").trim() || undefined,
        postType,
      );
      return jsonResponse({ notified: 0 });
    }

    const rows = (devices ?? []).filter(
      (row): row is {
        user_phone: string;
        fcm_token: string;
        last_lat: number;
        last_lng: number;
      } => {
        if (
          typeof row.user_phone !== "string" ||
          row.user_phone.length === 0 ||
          typeof row.fcm_token !== "string" ||
          row.fcm_token.trim().length === 0
        ) {
          return false;
        }
        const deviceLat = Number(row.last_lat);
        const deviceLng = Number(row.last_lng);
        if (!Number.isFinite(deviceLat) || !Number.isFinite(deviceLng)) {
          return false;
        }
        return haversineKm(lat, lng, deviceLat, deviceLng) <= radiusKm;
      },
    );

    if (rows.length === 0) {
      await maybeNotifyAdminVendorLead(
        supabase,
        String(parsed.post_id ?? "").trim() || undefined,
        postType,
      );
      return jsonResponse({ notified: 0 });
    }

    const notifType = notificationType(postType);
    const postId = String(parsed.post_id ?? "").trim() || undefined;
    const uniquePhones = [...new Set(rows.map((r) => r.user_phone))];

    const inboxRows = uniquePhones.map((user_phone) => ({
      user_phone,
      type: notifType,
      title,
      body,
      route: "feed",
      route_params: postId ? { post_id: postId } : null,
      related_id: postId ?? null,
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
          postId,
          notifType,
        );
      }
    }

    await maybeNotifyAdminVendorLead(
      supabase,
      String(parsed.post_id ?? "").trim() || undefined,
      postType,
    );

    return jsonResponse({ notified: uniquePhones.length });
  } catch (err) {
    console.error("notify-feed-post failed", err);
    return jsonResponse({ notified: 0 });
  }
});
