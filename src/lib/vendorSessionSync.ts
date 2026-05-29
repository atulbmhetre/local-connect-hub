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

const VENDOR_ACTIVE_KEY = "aaspaas:vendor_active";

/** Same-tab updates for vendor active state (bottom nav ME·Online label). */
export const VENDOR_ACTIVE_CHANGED_EVENT = "aaspaas:vendor_active_changed";

export function readIsVendorActive(): boolean {
  try {
    return localStorage.getItem(VENDOR_ACTIVE_KEY) === "1";
  } catch {
    return false;
  }
}
