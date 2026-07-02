const PENDING_PUSH_NAV_KEY = "aaspaas:pending_push_nav";

export function storePendingPushNav(data: Record<string, unknown>): void {
  try {
    sessionStorage.setItem(PENDING_PUSH_NAV_KEY, JSON.stringify(data));
  } catch {
    /* ignore quota / private mode */
  }
}

export function consumePendingPushNav(): Record<string, unknown> | undefined {
  try {
    const raw = sessionStorage.getItem(PENDING_PUSH_NAV_KEY);
    if (!raw) return undefined;
    sessionStorage.removeItem(PENDING_PUSH_NAV_KEY);
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore malformed payload */
  }
  return undefined;
}
