import { supabase, type Vendor } from "@/lib/supabase";
import {
  applyAbortSignal,
  throwOnSupabaseNetworkError,
  withTimedRetry,
} from "@/lib/withNetworkRetry";

/** Vendor self-read (Settings / VendorMode) — bypasses discoverable RLS. */
export async function fetchVendorOwn(
  vendorId: string,
  vendorPhone: string,
): Promise<{ data: Vendor | null; error: Error | null }> {
  const { data, error } = await supabase.rpc("get_vendor_own", {
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone.trim(),
  });
  if (error) return { data: null, error: new Error(error.message) };
  return { data: (data as Vendor | null) ?? null, error: null };
}

/** Vendor login by phone — includes non-discoverable rows. */
export async function fetchVendorByPhoneLogin(
  phone: string,
): Promise<{ data: Vendor | null; error: Error | null }> {
  try {
    const { data, error } = await withTimedRetry(async (signal) =>
      throwOnSupabaseNetworkError(
        await applyAbortSignal(
          supabase.rpc("get_vendor_by_phone_login", {
            p_phone: phone.trim(),
          }),
          signal,
        ),
      ),
    );
    if (error) return { data: null, error: new Error(error.message) };
    // PostgREST returns a null-filled composite object when SQL RETURNS NULL for a row type.
    const row = data as Vendor | null;
    if (!row?.id) return { data: null, error: null };
    return { data: row, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/** Customer reads vendor(s) for tracking/orders or public discovery. */
export async function fetchVendorsVisibleToCustomer(
  vendorIds: string[],
  opts: { userPhone?: string | null; deviceId?: string | null } = {},
): Promise<{ data: Vendor[]; error: Error | null }> {
  if (vendorIds.length === 0) return { data: [], error: null };
  const { data, error } = await supabase.rpc("get_vendors_visible_to_customer", {
    p_vendor_ids: vendorIds,
    p_user_phone: opts.userPhone?.trim() || null,
    p_device_id: opts.deviceId?.trim() || null,
  });
  if (error) return { data: [], error: new Error(error.message) };
  return { data: (data as Vendor[] | null) ?? [], error: null };
}
