import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  DECENTRO_CONSENT_PURPOSE,
  decentroBaseUrl,
  decentroPost,
  fetchDecentroJwt,
  readDecentroSecrets,
} from "../_shared/decentroDigilocker.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const AADHAAR_VERIFICATION_ENABLED = false; // dormant — flip to true + redeploy when Atul goes live

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!AADHAAR_VERIFICATION_ENABLED) {
    console.info("aadhaar-digilocker-complete: dormant — no Decentro call");
    return jsonResponse({ dormant: true, decentro_called: false });
  }

  try {
    const payload = (await req.json()) as {
      p_vendor_phone?: string;
      p_reference_id?: string;
    };
    const vendorPhone = String(payload.p_vendor_phone ?? "").replace(/\D/g, "");
    const referenceId = String(payload.p_reference_id ?? "").trim();
    if (vendorPhone.length !== 10 || !referenceId) {
      return jsonResponse({ error: "identity_required" }, 400);
    }

    const secrets = readDecentroSecrets();
    if (!secrets) {
      console.error("aadhaar-digilocker-complete: missing Decentro secrets");
      return jsonResponse({ error: "misconfigured" }, 500);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: vendor } = await supabase
      .from("vendors")
      .select("id")
      .eq("phone", vendorPhone)
      .maybeSingle();
    if (!vendor) {
      return jsonResponse({ error: "not_found_or_unauthorized" }, 404);
    }

    const { data: txn } = await supabase
      .from("vendor_aadhaar_digilocker_txns")
      .select("id, vendor_id, decentro_txn_id, status")
      .eq("reference_id", referenceId)
      .eq("vendor_id", vendor.id)
      .maybeSingle();
    if (!txn?.decentro_txn_id) {
      return jsonResponse({ error: "session_not_found" }, 404);
    }

    const baseUrl = decentroBaseUrl();
    const jwt = await fetchDecentroJwt(secrets, baseUrl);
    const { json } = await decentroPost(
      "/v2/kyc/digilocker/eaadhaar",
      {
        initial_decentro_transaction_id: txn.decentro_txn_id,
        consent: true,
        consent_purpose: DECENTRO_CONSENT_PURPOSE,
        reference_id: referenceId,
      },
      jwt,
      secrets.moduleSecret,
      baseUrl,
    );

    const passed = json.status === "SUCCESS";
    const checkStatus = passed ? "passed" : "failed";

    await supabase
      .from("vendor_aadhaar_digilocker_txns")
      .update({
        status: checkStatus,
        eaadhaar_decentro_txn_id: json.decentroTxnId?.trim() ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", txn.id);

    const { error: upsertErr } = await supabase.rpc("_upsert_vendor_verification_status", {
      p_vendor_id: vendor.id,
      p_check_type: "aadhaar_digilocker",
      p_status: checkStatus,
      p_checked_by: "system",
    });
    if (upsertErr) {
      console.error("aadhaar-digilocker-complete: upsert failed", upsertErr);
      return jsonResponse({ error: "upsert_failed" }, 500);
    }

    return jsonResponse({ status: checkStatus });
  } catch (err) {
    console.error("aadhaar-digilocker-complete failed", err);
    return jsonResponse({ error: "internal" }, 500);
  }
});
