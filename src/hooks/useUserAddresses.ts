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
    const deviceId = getDeviceId();
    const userPhone = getUserPhone();
    let query = supabase
      .from("user_addresses")
      .select("id, label, address_text, is_default");
    if (userPhone != null) {
      query = query.or(`device_id.eq.${deviceId},user_phone.eq.${userPhone}`);
    } else {
      query = query.eq("device_id", deviceId);
    }
    const { data, error } = await query;
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
