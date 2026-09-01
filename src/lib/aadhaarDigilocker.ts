import { supabase } from "@/lib/supabase";

export type AadhaarConsentResult =
  | { ok: false; reason: "dormant" }
  | { ok: false; reason: "invoke_failed"; message?: string }
  | { ok: true; authorizationUrl: string; referenceId: string };

/**
 * Client layer of the Razorpay-style gate: never request a DigiLocker consent
 * URL unless app_config.aadhaar_verification_enabled is true. The edge
 * function has a second compile-time gate and will not call Decentro until
 * AADHAAR_VERIFICATION_ENABLED is flipped and the function is redeployed.
 */
export async function requestAadhaarDigilockerConsent(opts: {
  enabled: boolean;
  vendorPhone: string;
}): Promise<AadhaarConsentResult> {
  if (!opts.enabled) {
    return { ok: false, reason: "dormant" };
  }

  const { data, error } = await supabase.functions.invoke("aadhaar-digilocker-initiate", {
    body: { p_vendor_phone: opts.vendorPhone },
  });
  if (error) {
    return { ok: false, reason: "invoke_failed", message: error.message };
  }
  const payload = (data ?? {}) as {
    dormant?: boolean;
    authorizationUrl?: string;
    reference_id?: string;
  };
  if (payload.dormant || !payload.authorizationUrl) {
    return { ok: false, reason: "dormant" };
  }
  return {
    ok: true,
    authorizationUrl: payload.authorizationUrl,
    referenceId: payload.reference_id ?? "",
  };
}
