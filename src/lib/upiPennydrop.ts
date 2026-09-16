import { supabase } from "@/lib/supabase";

export type UpiPennydropResult =
  | { ok: false; reason: "dormant" }
  | { ok: false; reason: "invoke_failed"; message?: string }
  | { ok: true; status: string };

/**
 * Client layer of the Razorpay-style gate: never invoke VerifyPay unless
 * app_config.upi_verification_enabled is true. The edge function has a
 * second compile-time gate and will not call Decentro until
 * UPI_VERIFICATION_ENABLED is flipped and the function is redeployed.
 */
export async function requestUpiPennydrop(opts: {
  enabled: boolean;
  vendorPhone: string;
}): Promise<UpiPennydropResult> {
  if (!opts.enabled) {
    return { ok: false, reason: "dormant" };
  }

  const { data, error } = await supabase.functions.invoke("upi-vpa-verify", {
    body: { p_vendor_phone: opts.vendorPhone },
  });
  if (error) {
    return { ok: false, reason: "invoke_failed", message: error.message };
  }
  const payload = (data ?? {}) as { dormant?: boolean; status?: string };
  if (payload.dormant || !payload.status) {
    return { ok: false, reason: "dormant" };
  }
  return { ok: true, status: payload.status };
}
