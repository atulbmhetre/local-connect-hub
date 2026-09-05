/**
 * RETIRED (superseded by Capgo @capgo/background-geolocation — Help Go-Live FGS).
 *
 * Cron `ping-active-vendors-location` unscheduled via
 *   20260905083001_retire_location_ping_cron.sql (both TEST + PROD).
 * Function kept deployable so any stale external caller gets a no-op path
 * rather than a hard 404; safe to delete in a later cleanup once confirmed idle.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleAuth } from "npm:google-auth-library@9";
import { deleteStaleToken } from "../_shared/fcm-cleanup.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type VendorJoin = {
  service_mode: string | null;
  fcm_token: string | null;
};

type AcceptedOrderRow = {
  id: string;
  vendor_id: string;
  created_at: string;
  vendors: VendorJoin | null;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    try {
      await req.json();
    } catch {
      /* empty body is fine */
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: orders, error: ordersError } = await supabase
      .from("requests")
      .select("id, vendor_id, created_at, vendors(service_mode, fcm_token)")
      .eq("status", "accepted")
      .order("created_at", { ascending: false });

    if (ordersError) {
      console.error("ping-active-vendors orders query failed", ordersError);
      return new Response(JSON.stringify({ pinged: 0 }), { status: 200, headers: CORS_HEADERS });
    }

    const byVendor = new Map<string, { fcm_token: string; order_id: string }>();

    for (const row of (orders ?? []) as AcceptedOrderRow[]) {
      if (row.vendors?.service_mode !== "help") continue;
      const token = row.vendors?.fcm_token;
      if (!token || byVendor.has(row.vendor_id)) continue;
      byVendor.set(row.vendor_id, { fcm_token: token, order_id: row.id });
    }

    if (byVendor.size === 0) {
      return new Response(JSON.stringify({ pinged: 0 }), { status: 200, headers: CORS_HEADERS });
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
      console.error("ping-active-vendors failed to obtain FCM access token");
      return new Response(JSON.stringify({ pinged: 0 }), { status: 200, headers: CORS_HEADERS });
    }

    let pinged = 0;

    for (const { fcm_token, order_id } of byVendor.values()) {
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
                token: fcm_token,
                data: {
                  type: "location_ping",
                  order_id,
                },
                android: {
                  priority: "HIGH",
                },
              },
            }),
          },
        );

        if (fcmRes.ok) {
          pinged += 1;
        } else {
          const fcmData = await fcmRes.json();
          console.error("ping-active-vendors fcm_response:", JSON.stringify(fcmData));
          if (fcmData?.error?.status === "UNREGISTERED" || fcmData?.error?.code === 404) {
            await deleteStaleToken(
              fcm_token,
              Deno.env.get("SUPABASE_URL")!,
              Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
            );
          }
        }
      } catch (tokenErr) {
        console.error("ping-active-vendors token send failed", tokenErr);
      }
    }

    return new Response(JSON.stringify({ pinged }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    console.error("ping-active-vendors failed", err);
    return new Response(JSON.stringify({ pinged: 0 }), { status: 200, headers: CORS_HEADERS });
  }
});
