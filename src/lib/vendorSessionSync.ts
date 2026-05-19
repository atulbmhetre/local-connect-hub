const VENDOR_ID_KEY = "aaspaas:vendor_id";

/** localStorage does not fire the `storage` event in the same tab; bottom nav listens for this. */
export const VENDOR_ID_CHANGED_EVENT = "aaspaas:vendor_id_changed";

export function readHasVendorId(): boolean {
  try {
    const v = localStorage.getItem(VENDOR_ID_KEY);
    return v != null && String(v).trim() !== "";
  } catch {
    return false;
  }
}

export function notifyVendorIdChanged() {
  window.dispatchEvent(new CustomEvent(VENDOR_ID_CHANGED_EVENT));
}
