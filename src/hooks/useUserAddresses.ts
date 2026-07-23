import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import { captureError } from "@/lib/sentry";

export type SavedAddress = {
  id: string;
  label: string;
  address_text: string;
  is_default: boolean;
};

export function useUserAddresses() {
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [loading, setLoading] = useState(true);
  // True when the last fetch failed — callers should show "unavailable",
  // not a false "no saved addresses".
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    // Direct user_addresses reads are RLS-blocked for OTP-off callers; the RPC
    // mirrors the old scoping (device OR phone when phone present, else device).
    const { data, error } = await supabase.rpc("get_my_addresses", {
      p_user_phone: getUserPhone(),
      p_device_id: getDeviceId(),
    });
    if (error) {
      captureError(error, { scope: "useUserAddresses.refresh" });
      console.error("useUserAddresses", error);
      setAddresses([]);
      setFailed(true);
    } else {
      setAddresses((data ?? []) as SavedAddress[]);
      setFailed(false);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { addresses, loading, failed, refresh };
}
