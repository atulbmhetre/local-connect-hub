/** Clear stale FCM tokens from user_devices and vendors.fcm_token. */
export async function deleteStaleToken(
  token: string,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };

  try {
    const deviceRes = await fetch(
      `${supabaseUrl}/rest/v1/user_devices?fcm_token=eq.${encodeURIComponent(token)}`,
      {
        method: "DELETE",
        headers,
      },
    );
    if (!deviceRes.ok) {
      const errText = await deviceRes.text();
      console.error("deleteStaleToken user_devices failed", deviceRes.status, errText);
    }
  } catch (err) {
    console.error("deleteStaleToken user_devices error", err);
  }

  try {
    const vendorRes = await fetch(
      `${supabaseUrl}/rest/v1/vendors?fcm_token=eq.${encodeURIComponent(token)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ fcm_token: null }),
      },
    );
    if (!vendorRes.ok) {
      const errText = await vendorRes.text();
      console.error("deleteStaleToken vendors.fcm_token failed", vendorRes.status, errText);
    }
  } catch (err) {
    console.error("deleteStaleToken vendors.fcm_token error", err);
  }
}
