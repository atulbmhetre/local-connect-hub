import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type DeleteAccountBody = {
  phone?: string;
  type?: string;
  action?: string;
  device_id?: string;
};

type SupabaseClient = ReturnType<typeof createClient>;

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

/**
 * Require prior association: this device_id must already be tied to this phone
 * via user_devices, app_users, requests, or user_addresses (not a bare phone guess).
 */
async function deviceOwnsPhone(
  supabase: SupabaseClient,
  phone: string,
  deviceId: string,
): Promise<boolean> {
  const { data: deviceRow, error: deviceError } = await supabase
    .from("user_devices")
    .select("id")
    .eq("device_id", deviceId)
    .eq("user_phone", phone)
    .limit(1)
    .maybeSingle();

  if (deviceError) {
    console.error("delete-account user_devices lookup failed", deviceError);
    throw deviceError;
  }
  if (deviceRow) return true;

  const { data: appUser, error: appError } = await supabase
    .from("app_users")
    .select("phone")
    .eq("device_id", deviceId)
    .eq("phone", phone)
    .limit(1)
    .maybeSingle();

  if (appError) {
    console.error("delete-account app_users lookup failed", appError);
    throw appError;
  }
  if (appUser) return true;

  const { data: requestRow, error: requestError } = await supabase
    .from("requests")
    .select("id")
    .eq("device_id", deviceId)
    .eq("user_phone", phone)
    .limit(1)
    .maybeSingle();

  if (requestError) {
    console.error("delete-account requests lookup failed", requestError);
    throw requestError;
  }
  if (requestRow) return true;

  const { data: addressRow, error: addressError } = await supabase
    .from("user_addresses")
    .select("id")
    .eq("device_id", deviceId)
    .eq("user_phone", phone)
    .limit(1)
    .maybeSingle();

  if (addressError) {
    console.error("delete-account user_addresses lookup failed", addressError);
    throw addressError;
  }
  return Boolean(addressRow);
}

async function enforceRateLimit(
  supabase: SupabaseClient,
  phone: string,
): Promise<Response | null> {
  const { data: allowed, error: rlError } = await supabase.rpc(
    "check_and_log_rate_limit",
    {
      p_function_name: "delete-account",
      p_identifier_type: "phone",
      p_identifier: phone,
      p_max_requests: 5,
      p_window_seconds: 600,
    },
  );
  if (rlError) {
    console.error("delete-account rate limit RPC failed", rlError);
    // fail open on infra error — still require device association
    return null;
  }
  if (allowed === false) {
    return jsonResponse({ error: "rate_limited" }, 429);
  }
  return null;
}

async function notifyAllLinkedDevices(
  supabaseUrl: string,
  serviceRoleKey: string,
  phone: string,
): Promise<void> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/notify-user`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_phone: phone,
        title: "Account deletion scheduled",
        body: "Your Aaspaas account is scheduled for deletion in 30 days. Open Settings and tap Cancel Deletion if this was not you.",
        type: "account_deletion_scheduled",
        route: "settings",
        all_linked_devices: true,
      }),
    });
    if (!res.ok) {
      console.error("delete-account notify-user HTTP", res.status, await res.text());
    }
  } catch (err) {
    console.error("delete-account notify-user failed", err);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 400);
  }

  let body: DeleteAccountBody = {};
  try {
    const text = await req.text();
    if (text?.trim()) {
      body = JSON.parse(text) as DeleteAccountBody;
    }
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  try {
    const phone = body.phone?.trim() ?? "";
    const action = body.action?.trim() ?? "";
    const type = body.type?.trim() ?? "";
    const deviceId = body.device_id?.trim() ?? "";

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("delete-account missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return jsonResponse({ error: "server_misconfigured" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    if (!phone) {
      return jsonResponse({ error: "phone_required" }, 400);
    }
    if (!deviceId) {
      return jsonResponse({ error: "device_id_required" }, 400);
    }

    const rateLimited = await enforceRateLimit(supabase, phone);
    if (rateLimited) return rateLimited;

    let ownsPhone = false;
    try {
      ownsPhone = await deviceOwnsPhone(supabase, phone, deviceId);
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : "identity_check_failed" },
        500,
      );
    }
    if (!ownsPhone) {
      return jsonResponse({ error: "device_not_associated" }, 403);
    }

    if (action === "cancel") {
      const { error: vendorError } = await supabase
        .from("vendors")
        .update({ deletion_requested_at: null })
        .eq("phone", phone);

      if (vendorError) {
        console.error("delete-account cancel vendors update failed", vendorError);
        return jsonResponse({ error: vendorError.message }, 500);
      }

      const { error: userError } = await supabase
        .from("users")
        .update({ deletion_requested_at: null })
        .eq("phone", phone);

      if (userError) {
        console.error("delete-account cancel users update failed", userError);
        return jsonResponse({ error: userError.message }, 500);
      }

      return jsonResponse({ ok: true, message: "Deletion cancelled" });
    }

    if (type !== "customer" && type !== "vendor") {
      return jsonResponse({ error: "invalid_type" }, 400);
    }

    if (type === "customer") {
      const now = new Date().toISOString();
      let dualRole = false;

      const { data: vendorRow, error: vendorLookupError } = await supabase
        .from("vendors")
        .select("phone, deletion_requested_at")
        .eq("phone", phone)
        .maybeSingle();

      if (vendorLookupError) {
        console.error("delete-account customer vendor lookup failed", vendorLookupError);
        return jsonResponse({ error: vendorLookupError.message }, 500);
      }

      if (vendorRow && vendorRow.deletion_requested_at == null) {
        const { error: vendorGraceError } = await supabase
          .from("vendors")
          .update({ deletion_requested_at: now })
          .eq("phone", phone);

        if (vendorGraceError) {
          console.error("delete-account dual-role vendor grace failed", vendorGraceError);
          return jsonResponse({ error: vendorGraceError.message }, 500);
        }
        dualRole = true;
      }

      const { data: updatedUsers, error: updateError } = await supabase
        .from("users")
        .update({ deletion_requested_at: now })
        .eq("phone", phone)
        .select("phone");

      if (updateError) {
        console.error("delete-account customer users update failed", updateError);
        return jsonResponse({ error: updateError.message }, 500);
      }

      if (!updatedUsers?.length) {
        return jsonResponse({ error: "account_not_found" }, 404);
      }

      const { error: finalizeError } = await supabase.rpc(
        "finalize_customer_deletion_request",
        { p_phone: phone },
      );
      if (finalizeError) {
        console.error("delete-account finalize customer deletion failed", finalizeError);
        return jsonResponse({ error: finalizeError.message }, 500);
      }

      const { error: rpcError } = await supabase.rpc("anonymise_deleted_accounts");

      if (rpcError) {
        console.error("delete-account anonymise_deleted_accounts failed", rpcError);
        return jsonResponse({ error: rpcError.message }, 500);
      }

      await notifyAllLinkedDevices(supabaseUrl, serviceRoleKey, phone);

      return jsonResponse({
        ok: true,
        type: "customer",
        dual_role: dualRole,
        message: "Deletion scheduled",
      });
    }

    const { data: updatedVendors, error: vendorUpdateError } = await supabase
      .from("vendors")
      .update({ deletion_requested_at: new Date().toISOString() })
      .eq("phone", phone)
      .select("phone");

    if (vendorUpdateError) {
      console.error("delete-account vendor update failed", vendorUpdateError);
      return jsonResponse({ error: vendorUpdateError.message }, 500);
    }

    if (!updatedVendors?.length) {
      return jsonResponse({ error: "vendor_not_found" }, 404);
    }

    const { data: updatedUsers, error: userUpdateError } = await supabase
      .from("users")
      .update({ deletion_requested_at: new Date().toISOString() })
      .eq("phone", phone)
      .select("phone");

    if (userUpdateError) {
      console.error("delete-account vendor users update failed", userUpdateError);
      return jsonResponse({ error: userUpdateError.message }, 500);
    }

    if ((updatedUsers?.length ?? 0) > 0) {
      const { error: finalizeError } = await supabase.rpc(
        "finalize_customer_deletion_request",
        { p_phone: phone },
      );
      if (finalizeError) {
        console.error("delete-account finalize customer deletion failed", finalizeError);
        return jsonResponse({ error: finalizeError.message }, 500);
      }

      const { error: rpcError } = await supabase.rpc("anonymise_deleted_accounts");
      if (rpcError) {
        console.error("delete-account vendor dual-role anonymise failed", rpcError);
        return jsonResponse({ error: rpcError.message }, 500);
      }
    }

    return jsonResponse({
      ok: true,
      type: "vendor",
      dual_role: (updatedUsers?.length ?? 0) > 0,
      message: "Deletion scheduled",
    });
  } catch (err) {
    console.error("delete-account failed", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "unexpected_error" },
      500,
    );
  }
});
