import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleAuth } from "npm:google-auth-library@9";
import { deleteStaleToken } from "../_shared/fcm-cleanup.ts";

const TITLE = "You have orders for today";
const BODY = "Go online and contact your customers.";

function isTodayIST(iso: string): boolean {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return false;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d) === fmt.format(new Date());
}

function orderMatchesTomorrowReminder(row: {
  delivery_slot: string | null;
  appointment_time: string | null;
  vendors: { service_mode: string | null } | null;
}): boolean {
  const mode = row.vendors?.service_mode ?? "help";
  if (mode === "delivery") {
    return (row.delivery_slot ?? "").trim().toLowerCase() === "tomorrow";
  }
  if (mode === "appointment") {
    return row.appointment_time != null && isTodayIST(row.appointment_time);
  }
  return false;
}

serve(async (req) => {
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
      .select("vendor_id, delivery_slot, appointment_time, vendors(service_mode)")
      .in("status", ["sent", "seen"]);

    if (ordersError) {
      console.error("notify-vendor-tomorrow orders query failed", ordersError);
      return new Response(JSON.stringify({ notified: 0 }), { status: 200 });
    }

    const vendorIds = [
      ...new Set(
        (orders ?? [])
          .filter((row) => orderMatchesTomorrowReminder(row))
          .map((row) => row.vendor_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];

    if (vendorIds.length === 0) {
      return new Response(JSON.stringify({ notified: 0 }), { status: 200 });
    }

    const { data: vendors, error: vendorsError } = await supabase
      .from("vendors")
      .select("id, fcm_token, name")
      .in("id", vendorIds);

    if (vendorsError) {
      console.error("notify-vendor-tomorrow vendors query failed", vendorsError);
      return new Response(JSON.stringify({ notified: 0 }), { status: 200 });
    }

    const tokens = (vendors ?? [])
      .map((v) => v.fcm_token)
      .filter((token): token is string => typeof token === "string" && token.length > 0);

    if (tokens.length === 0) {
      return new Response(JSON.stringify({ notified: 0 }), { status: 200 });
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
      console.error("notify-vendor-tomorrow failed to obtain FCM access token");
      return new Response(JSON.stringify({ notified: 0 }), { status: 200 });
    }

    let notified = 0;

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
                  title: TITLE,
                  body: BODY,
                },
                data: {
                  title: TITLE,
                  body: BODY,
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

        if (fcmRes.ok) {
          notified += 1;
        } else {
          const fcmData = await fcmRes.json();
          console.error("notify-vendor-tomorrow fcm_response:", JSON.stringify(fcmData));
          if (fcmData?.error?.status === "UNREGISTERED" || fcmData?.error?.code === 404) {
            await deleteStaleToken(
              fcmToken,
              Deno.env.get("SUPABASE_URL")!,
              Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
            );
          }
        }
      } catch (tokenErr) {
        console.error("notify-vendor-tomorrow token send failed", tokenErr);
      }
    }

    return new Response(JSON.stringify({ notified }), { status: 200 });
  } catch (err) {
    console.error("notify-vendor-tomorrow failed", err);
    return new Response(JSON.stringify({ notified: 0 }), { status: 200 });
  }
});
