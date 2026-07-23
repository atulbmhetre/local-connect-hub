import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleAuth } from "npm:google-auth-library@9";
import { deleteStaleToken } from "../_shared/fcm-cleanup.ts";
import { buildFcmData } from "../_shared/notification-routes.ts";
import { feedPushOfferBody, feedPushTitle } from "./constants.ts";

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

// Either a fixed body shared by every recipient (explicit body, or the
// post's own user-generated content — not translatable), or a template that
// still needs per-recipient language substitution, same as titles.
type BodyResolution =
  | { kind: "fixed"; value: string }
  | { kind: "offer_template"; shopName: string };

async function resolveNotifyBody(
  supabase: SupabaseClient,
  postId: string | undefined,
  postType: string,
  parsedBody: string,
  vendorId: string | undefined,
): Promise<BodyResolution> {
  const trimmed = parsedBody.trim();
  if (trimmed) return { kind: "fixed", value: trimmed.substring(0, 100) };

  if (postId) {
    const { data: post, error } = await supabase
      .from("feed_posts")
      .select("content")
      .eq("id", postId)
      .maybeSingle();
    if (error) {
      console.error("notify-feed-post resolveNotifyBody post lookup failed", error);
    }
    if (post?.content) {
      return { kind: "fixed", value: String(post.content).substring(0, 100) };
    }
  }

  if (postType === "offer" && vendorId) {
    const { data: vendor, error } = await supabase
      .from("vendors")
      .select("shop_name")
      .eq("id", vendorId)
      .maybeSingle();
    if (error) {
      console.error("notify-feed-post resolveNotifyBody vendor lookup failed", error);
    }
    if (vendor?.shop_name) {
      return { kind: "offer_template", shopName: String(vendor.shop_name) };
    }
  }

  return { kind: "fixed", value: "" };
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

async function logFcmDelivery(
  supabase: SupabaseClient,
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
    console.error("notify-feed-post fcm_delivery_log insert failed", err);
  }
}

function defaultPushTitle(postType: string, lang = "en"): string {
  return feedPushTitle(postType, lang);
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
        type: "feed_recommendation",
        route: "feed",
        route_params: { post_id: postId },
        post_id: postId,
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
  supabase: SupabaseClient,
  accessToken: string,
  projectId: string,
  fcmToken: string,
  targetPhone: string,
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
  const logType = `feed-${notifType}`;
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

    const rawResponse = await fcmRes.text();

    if (fcmRes.ok) {
      await logFcmDelivery(supabase, {
        notification_type: logType,
        target_phone: targetPhone,
        success: true,
        raw_response: rawResponse,
      });
      return true;
    }

    let fcmErrorData: Record<string, unknown> | null = null;
    try {
      fcmErrorData = JSON.parse(rawResponse) as Record<string, unknown>;
    } catch {
      fcmErrorData = null;
    }
    console.error("notify-feed-post fcm_response:", rawResponse);
    await logFcmDelivery(supabase, {
      notification_type: logType,
      target_phone: targetPhone,
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
          fcmToken,
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
      }
    }
    return false;
  } catch (err) {
    console.error("notify-feed-post token send failed", err);
    await logFcmDelivery(supabase, {
      notification_type: logType,
      target_phone: targetPhone,
      success: false,
      raw_response: err instanceof Error ? err.message : String(err),
    });
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
  } catch (err) {
    console.error("notify-feed-post invalid_json", err);
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const lat = Number(parsed.lat);
  const lng = Number(parsed.lng);
  const authorPhone = String(parsed.author_phone ?? "").trim();
  const postType = String(parsed.post_type ?? "").trim();
  const explicitTitle = String(parsed.title ?? "").trim();
  const titleFallback = (
    explicitTitle || defaultPushTitle(postType, "en")
  ).substring(0, 100);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !authorPhone ||
    !postType ||
    !titleFallback
  ) {
    console.error("notify-feed-post missing_required_fields", {
      hasLat: Number.isFinite(lat),
      hasLng: Number.isFinite(lng),
      hasAuthorPhone: !!authorPhone,
      hasPostType: !!postType,
    });
    return jsonResponse({ error: "missing_required_fields" }, 400);
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const bodyResolution = await resolveNotifyBody(
      supabase,
      String(parsed.post_id ?? "").trim() || undefined,
      postType,
      String(parsed.body ?? ""),
      String(parsed.vendor_id ?? "").trim() || undefined,
    );

    const postIdForDevices = String(parsed.post_id ?? "").trim();
    if (!postIdForDevices) {
      console.error("notify-feed-post missing post_id for audience filter");
      await maybeNotifyAdminVendorLead(
        supabase,
        undefined,
        postType,
      );
      return jsonResponse({ notified: 0, error: "post_id_required" });
    }

    // Radius + audience rules now come from the post itself (reach_radius_km,
    // recommendation vendor service_radius_km) and each recipient's own
    // feed_discovery_radius_km preference — the same logic get_local_feed_posts
    // uses for display, computed inside get_feed_post_notify_devices. We no
    // longer pass a flat app_config radius; the RPC computes it from the post.
    const { data: devices, error: devicesError } = await supabase.rpc(
      "get_feed_post_notify_devices",
      {
        p_post_id: postIdForDevices,
        p_author_phone: authorPhone,
      },
    );

    if (devicesError) {
      console.error("notify-feed-post get_feed_post_notify_devices failed", devicesError);
      await maybeNotifyAdminVendorLead(
        supabase,
        postIdForDevices,
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
        return Number.isFinite(deviceLat) && Number.isFinite(deviceLng);
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

    const langByPhone = new Map<string, string>();
    if (uniquePhones.length > 0) {
      const { data: langRows } = await supabase
        .from("app_users")
        .select("phone, lang")
        .in("phone", uniquePhones);
      for (const row of langRows ?? []) {
        if (typeof row.phone === "string") {
          langByPhone.set(row.phone, typeof row.lang === "string" ? row.lang : "en");
        }
      }
    }

    const titleForPhone = (phone: string): string => {
      if (explicitTitle) return explicitTitle.substring(0, 100);
      return defaultPushTitle(postType, langByPhone.get(phone) ?? "en").substring(0, 100);
    };

    // Localize the body per recipient the same way titles are localized.
    // User-generated post content (and any explicit body) is shared as-is
    // (it isn't translatable); only the generated offer fallback template
    // varies by recipient language.
    const bodyForPhone = (phone: string): string => {
      if (bodyResolution.kind === "fixed") return bodyResolution.value;
      return feedPushOfferBody(bodyResolution.shopName, langByPhone.get(phone) ?? "en").substring(
        0,
        100,
      );
    };

    const inboxRows = uniquePhones.map((user_phone) => ({
      user_phone,
      type: notifType,
      title: titleForPhone(user_phone),
      body: bodyForPhone(user_phone),
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
          supabase,
          accessToken,
          projectId,
          row.fcm_token.trim(),
          row.user_phone,
          titleForPhone(row.user_phone),
          bodyForPhone(row.user_phone),
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
