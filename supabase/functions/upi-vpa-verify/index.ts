import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  decentroDecfinBaseUrl,
  decentroVerifyPay,
  namesMatchForUpi,
  readDecfinSecrets,
} from "../_shared/decentroVerifyPay.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const UPI_VERIFICATION_ENABLED = false; // dormant — flip to true + redeploy when Atul goes live

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!UPI_VERIFICATION_ENABLED) {
    console.info("upi-vpa-verify: dormant — no Decentro call");
    return jsonResponse({ dormant: true, decentro_called: false });
  }

  try {
    const payload = (await req.json()) as { p_vendor_phone?: string };
    const vendorPhone = String(payload.p_vendor_phone ?? "").replace(/\D/g, "");
    if (vendorPhone.length !== 10) {
      return jsonResponse({ error: "identity_required" }, 400);
    }

    const secrets = readDecfinSecrets();
    if (!secrets) {
      console.error("upi-vpa-verify: missing Decfin secrets");
      return jsonResponse({ error: "misconfigured" }, 500);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: vendor, error: vendorErr } = await supabase
      .from("vendors")
      .select("id, phone, name, upi_id")
      .eq("phone", vendorPhone)
      .maybeSingle();
    if (vendorErr || !vendor) {
      return jsonResponse({ error: "not_found_or_unauthorized" }, 404);
    }

    const upiVpa = String(vendor.upi_id ?? "").trim();
    if (!upiVpa.includes("@")) {
      return jsonResponse({ error: "upi_id_required" }, 400);
    }

    const referenceId = crypto.randomUUID().replace(/-/g, "");
    const { json } = await decentroVerifyPay(
      {
        consumer_urn: secrets.consumerUrn,
        is_consent_granted: true,
        reference_id: referenceId,
        upi_vpa: upiVpa,
        purpose_message: "Vendor UPI verification",
      },
      secrets,
      decentroDecfinBaseUrl(),
    );

    const decentroTxnId =
      json.decentro_txn_id?.trim() || json.decentroTxnId?.trim() || null;
    const responseKey = json.response_key ?? json.responseKey ?? "";
    const bankName = json.data?.name_as_per_bank?.trim() || null;
    const apiOk = (json.api_status ?? json.status ?? "").toUpperCase() === "SUCCESS";
    const vpaValid = responseKey === "success_account_details_retrieved";
    const nameOk =
      Boolean(bankName) && namesMatchForUpi(String(vendor.name ?? ""), bankName ?? "");
    const passed = apiOk && vpaValid && nameOk;
    const checkStatus = passed ? "passed" : "failed";

    const { error: insertErr } = await supabase.from("vendor_upi_pennydrop_txns").insert({
      vendor_id: vendor.id,
      reference_id: referenceId,
      decentro_txn_id: decentroTxnId,
      matched_account_holder_name: bankName,
      status: checkStatus,
      completed_at: new Date().toISOString(),
    });
    if (insertErr) {
      console.error("upi-vpa-verify: insert failed", insertErr);
      return jsonResponse({ error: "persist_failed" }, 500);
    }

    const { error: upsertErr } = await supabase.rpc("_upsert_vendor_verification_status", {
      p_vendor_id: vendor.id,
      p_check_type: "upi_pennydrop",
      p_status: checkStatus,
      p_checked_by: "system",
    });
    if (upsertErr) {
      console.error("upi-vpa-verify: upsert failed", upsertErr);
      return jsonResponse({ error: "upsert_failed" }, 500);
    }

    return jsonResponse({ status: checkStatus });
  } catch (err) {
    console.error("upi-vpa-verify failed", err);
    return jsonResponse({ error: "internal" }, 500);
  }
});
