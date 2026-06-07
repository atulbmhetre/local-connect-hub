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
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("delete-account missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return jsonResponse({ error: "server_misconfigured" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    if (action === "cancel") {
      if (!phone) {
        return jsonResponse({ error: "phone_required" }, 400);
      }

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

    if (!phone) {
      return jsonResponse({ error: "phone_required" }, 400);
    }

    if (type !== "customer" && type !== "vendor") {
      return jsonResponse({ error: "invalid_type" }, 400);
    }

    if (type === "customer") {
      const { data: updatedUsers, error: updateError } = await supabase
        .from("users")
        .update({ deletion_requested_at: new Date().toISOString() })
        .eq("phone", phone)
        .select("phone");

      if (updateError) {
        console.error("delete-account customer users update failed", updateError);
        return jsonResponse({ error: updateError.message }, 500);
      }

      if (!updatedUsers?.length) {
        return jsonResponse({ error: "account_not_found" }, 404);
      }

      const { error: rpcError } = await supabase.rpc("anonymise_deleted_accounts");

      if (rpcError) {
        console.error("delete-account anonymise_deleted_accounts failed", rpcError);
        return jsonResponse({ error: rpcError.message }, 500);
      }

      return jsonResponse({
        ok: true,
        type: "customer",
        message: "Account deleted",
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

    const { error: userUpdateError } = await supabase
      .from("users")
      .update({ deletion_requested_at: new Date().toISOString() })
      .eq("phone", phone);

    if (userUpdateError) {
      console.error("delete-account vendor users update failed", userUpdateError);
      return jsonResponse({ error: userUpdateError.message }, 500);
    }

    return jsonResponse({
      ok: true,
      type: "vendor",
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
