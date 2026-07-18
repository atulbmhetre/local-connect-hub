/** Whether a vendor should appear on customer Radar given subscription state. */
export function isVendorSubscriptionVisibleOnRadar(vendor: {
  subscription_status?: string | null;
  grace_ends_at?: string | null;
}): boolean {
  const status = String(vendor.subscription_status ?? "trial").trim().toLowerCase();
  if (status === "active" || status === "trial") return true;
  if (status === "grace") {
    if (!vendor.grace_ends_at) return true;
    return new Date(vendor.grace_ends_at).getTime() > Date.now();
  }
  return false;
}
