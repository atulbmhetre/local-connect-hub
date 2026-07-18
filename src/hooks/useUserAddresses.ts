import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";

export type SavedAddress = {
  id: string;
  label: string;
  address_text: string;
  is_default: boolean;
};

export function useUserAddresses() {
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    // Direct user_addresses reads are RLS-blocked for OTP-off callers; the RPC
    // mirrors the old scoping (device OR phone when phone present, else device).
    const { data, error } = await supabase.rpc("get_my_addresses", {
      p_user_phone: getUserPhone(),
      p_device_id: getDeviceId(),
    });
    if (error) {
      setAddresses([]);
    } else {
      setAddresses((data ?? []) as SavedAddress[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { addresses, loading, refresh };
}
