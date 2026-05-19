/**
 * Stable anonymous device id for saved vendors and order requests (no login).
 */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem("aaspaas:device_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("aaspaas:device_id", id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
