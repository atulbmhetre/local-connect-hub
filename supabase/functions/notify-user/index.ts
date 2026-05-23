import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleAuth } from "npm:google-auth-library@9";

serve(async (req) => {
  try {
    const payload = await req.json();
    const userPhone = payload?.user_phone as string | undefined;
    const title = (payload?.title ?? "").substring(0, 100);
    const body = (payload?.body ?? "").substring(0, 100);

    if (!userPhone) {
      return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: devices, error } = await supabase
      .from("user_devices")
      .select("fcm_token")
      .eq("user_phone", userPhone);

    if (error) {
      console.error("notify-user user_devices query failed", error);
      return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
    }

    const tokens = (devices ?? [])
      .map((row) => row.fcm_token)
      .filter((token): token is string => typeof token === "string" && token.length > 0);

    if (tokens.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
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
      return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
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
                data: {
                  title,
                  body,
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
          sent += 1;
        } else {
          const fcmData = await fcmRes.json();
          console.error("notify-user fcm_response:", JSON.stringify(fcmData));
        }
      } catch (tokenErr) {
        console.error("notify-user token send failed", tokenErr);
      }
    }

    return new Response(JSON.stringify({ sent }), { status: 200 });
  } catch (err) {
    console.error("notify-user failed", err);
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }
});
