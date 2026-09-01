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
    console.info("aadhaar-digilocker-initiate: dormant — no Decentro call");
    return jsonResponse({ dormant: true, decentro_called: false });
  }

  try {
    const payload = (await req.json()) as { p_vendor_phone?: string };
    const vendorPhone = String(payload.p_vendor_phone ?? "").replace(/\D/g, "");
    if (vendorPhone.length !== 10) {
      return jsonResponse({ error: "identity_required" }, 400);
    }

    const secrets = readDecentroSecrets();
    if (!secrets) {
      console.error("aadhaar-digilocker-initiate: missing Decentro secrets");
      return jsonResponse({ error: "misconfigured" }, 500);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: vendor, error: vendorErr } = await supabase
      .from("vendors")
      .select("id, phone")
      .eq("phone", vendorPhone)
      .maybeSingle();
    if (vendorErr || !vendor) {
      return jsonResponse({ error: "not_found_or_unauthorized" }, 404);
    }

    const { data: cfg } = await supabase
      .from("app_config")
      .select("key, value")
      .in("key", ["app_base_url"]);
    const appBase =
      (cfg ?? []).find((r: { key: string }) => r.key === "app_base_url")?.value?.trim() ||
      "https://aaspaaspro.com";
    const redirectUrl = `${appBase.replace(/\/$/, "")}/vendor?aadhaar_callback=1`;

    const referenceId = crypto.randomUUID().replace(/-/g, "");
    const baseUrl = decentroBaseUrl();
    const jwt = await fetchDecentroJwt(secrets, baseUrl);
    const { json } = await decentroPost(
      "/v2/kyc/digilocker/initiate_session",
      {
        reference_id: referenceId,
        consent: true,
        consent_purpose: DECENTRO_CONSENT_PURPOSE,
        redirect_url: redirectUrl,
        redirect_to_signup: true,
        abstract_access_token: true,
      },
      jwt,
      secrets.moduleSecret,
      baseUrl,
    );

    const authorizationUrl = json.data?.authorizationUrl?.trim();
    const decentroTxnId = json.decentroTxnId?.trim() ?? null;
    if (json.status !== "SUCCESS" || !authorizationUrl) {
      return jsonResponse(
        { error: "initiate_failed", message: json.message ?? json.responseKey },
        502,
      );
    }

    const { error: insertErr } = await supabase.from("vendor_aadhaar_digilocker_txns").insert({
      vendor_id: vendor.id,
      reference_id: referenceId,
      decentro_txn_id: decentroTxnId,
      status: "initiated",
    });
    if (insertErr) {
      console.error("aadhaar-digilocker-initiate: insert failed", insertErr);
      return jsonResponse({ error: "persist_failed" }, 500);
    }

    return jsonResponse({
      authorizationUrl,
      reference_id: referenceId,
    });
  } catch (err) {
    console.error("aadhaar-digilocker-initiate failed", err);
    return jsonResponse({ error: "internal" }, 500);
  }
});
