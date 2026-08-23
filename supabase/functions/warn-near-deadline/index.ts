import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type PendingPushRow = {
  id: string;
  user_phone: string | null;
  vendor_id: string;
  delivery_slot: string | null;
};

type InboxRow = {
  title: string;
  body: string;
  type: string;
};

type ServiceClient = ReturnType<typeof createClient>;

async function raiseNearDeadlineAlert(
  supabase: ServiceClient,
  rawError: string,
): Promise<void> {
  const truncated = rawError.slice(0, 1000);
  const { data: existing, error: lookupError } = await supabase
    .from("admin_alerts")
    .select("id")
    .eq("function_name", "warn-near-deadline")
    .is("resolved_at", null)
    .maybeSingle();
  if (lookupError) {
    console.error("warn-near-deadline admin_alerts lookup failed", lookupError);
    return;
  }
  if (existing?.id) {
    const { error: updateError } = await supabase
      .from("admin_alerts")
      .update({ last_checked_at: new Date().toISOString(), raw_error: truncated })
      .eq("id", existing.id);
    if (updateError) {
      console.error("warn-near-deadline admin_alerts update failed", updateError);
    }
    return;
  }
  const { error: insertError } = await supabase.from("admin_alerts").insert({
    function_name: "warn-near-deadline",
    error_type: "unknown",
    raw_error: truncated,
  });
  if (insertError) {
    console.error("warn-near-deadline admin_alerts insert failed", insertError);
  }
}

async function resolveNearDeadlineAlert(supabase: ServiceClient): Promise<void> {
  const { error } = await supabase
    .from("admin_alerts")
    .update({ resolved_at: new Date().toISOString(), last_checked_at: new Date().toISOString() })
    .eq("function_name", "warn-near-deadline")
    .is("resolved_at", null);
  if (error) {
    console.error("warn-near-deadline admin_alerts resolve failed", error);
  }
}

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

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: pending, error: pendingError } = await supabase
      .from("requests")
      .select("id, user_phone, vendor_id, delivery_slot")
      .eq("near_deadline_push_sent", false)
      .not("near_deadline_warned_at", "is", null);

    if (pendingError) {
      console.error("warn-near-deadline pending query failed", pendingError);
      await raiseNearDeadlineAlert(
        supabase,
        `pending query failed: ${pendingError.message}`,
      );
      return new Response(JSON.stringify({ pushed: 0 }), {
        status: 200,
        headers: CORS_HEADERS,
      });
    }

    const rows = (pending ?? []) as PendingPushRow[];
    if (rows.length === 0) {
      return new Response(JSON.stringify({ pushed: 0 }), {
        status: 200,
        headers: CORS_HEADERS,
      });
    }

    const notifyByCustomerVendor = new Map<
      string,
      { userPhone: string; orderIds: string[]; title: string; body: string; type: string }
    >();

    for (const row of rows) {
      const phone = row.user_phone?.trim();
      if (!phone || !row.vendor_id) continue;

      const dedupeKey = `${phone}:${row.vendor_id}`;
      const existing = notifyByCustomerVendor.get(dedupeKey);
      if (existing) {
        existing.orderIds.push(row.id);
        continue;
      }

      const { data: inboxRows, error: inboxError } = await supabase
        .from("user_notifications")
        .select("title, body, type")
        .eq("related_id", row.id)
        .in("type", [
          "order_near_deadline_unseen",
          "order_near_deadline_unconfirmed",
        ])
        .order("created_at", { ascending: false })
        .limit(1);

      if (inboxError || !inboxRows?.length) {
        console.error("warn-near-deadline inbox lookup failed", row.id, inboxError);
        await raiseNearDeadlineAlert(
          supabase,
          `inbox lookup miss request=${row.id} err=${inboxError?.message ?? "no matching order_near_deadline_* row"}`,
        );
        continue;
      }

      const inbox = inboxRows[0] as InboxRow;
      notifyByCustomerVendor.set(dedupeKey, {
        userPhone: phone,
        orderIds: [row.id],
        title: inbox.title,
        body: inbox.body,
        type: inbox.type,
      });
    }

    let pushed = 0;

    for (const [, payload] of notifyByCustomerVendor) {
      const userPhone = payload.userPhone;
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/notify-user`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            user_phone: userPhone,
            title: payload.title,
            body: payload.body,
            type: payload.type,
            order_id: payload.orderIds[0],
            skip_inbox: true,
          }),
        });
        if (!res.ok) {
          const errText = await res.text();
          console.error("warn-near-deadline notify-user failed", res.status, errText);
          await raiseNearDeadlineAlert(
            supabase,
            `notify-user HTTP ${res.status} phone=${userPhone} ${errText}`,
          );
          continue;
        }

        const resJson = await res.json().catch(() => ({}) as { sent?: number });
        const sent = Number((resJson as { sent?: number }).sent ?? 0);
        if (!(sent > 0)) {
          // sent:0 means no FCM tokens / send failed — leave push_sent false so it retries later.
          console.warn("warn-near-deadline notify-user sent 0, not marking pushed", userPhone);
          await raiseNearDeadlineAlert(
            supabase,
            `notify-user sent:0 phone=${userPhone} type=${payload.type} (retrying; push_sent left false)`,
          );
          continue;
        }

        pushed += 1;

        const { error: markError } = await supabase
          .from("requests")
          .update({ near_deadline_push_sent: true })
          .in("id", payload.orderIds);
        if (markError) {
          console.error("warn-near-deadline mark push_sent failed", markError);
        }
      } catch (pushErr) {
        console.error("warn-near-deadline push failed", userPhone, pushErr);
        await raiseNearDeadlineAlert(
          supabase,
          `notify-user throw phone=${userPhone} ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`,
        );
      }
    }

    if (pushed > 0) {
      await resolveNearDeadlineAlert(supabase);
    }

    return new Response(JSON.stringify({ pushed }), {
      status: 200,
      headers: CORS_HEADERS,
    });
  } catch (err) {
    console.error("warn-near-deadline failed", err);
    return new Response(JSON.stringify({ pushed: 0 }), {
      status: 200,
      headers: CORS_HEADERS,
    });
  }
});
