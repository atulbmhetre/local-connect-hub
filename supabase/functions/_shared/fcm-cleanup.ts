export async function deleteStaleToken(
  token: string,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<void> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/user_devices?fcm_token=eq.${encodeURIComponent(token)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      console.error("deleteStaleToken failed", res.status, errText);
    }
  } catch (err) {
    console.error("deleteStaleToken error", err);
  }
}
