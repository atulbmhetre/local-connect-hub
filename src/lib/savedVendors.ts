/** Display label for a saved neighbour: custom nickname if set, else shop name. */
export function savedNeighbourDisplayName(
  nickname: string | null | undefined,
  shopName: string | null | undefined,
): string {
  const nick = (nickname ?? "").trim();
  if (nick) return nick;
  const shop = (shopName ?? "").trim();
  return shop || "Shop";
}

const NEIGHBOURS_DIRTY_KEY = "aaspaas:neighbours_dirty";

/** Marks Home/Radar neighbour lists for refresh after save/unsave/nickname changes. */
export function markNeighboursDirty(): void {
  try {
    localStorage.setItem(NEIGHBOURS_DIRTY_KEY, "true");
  } catch {
    /* ignore */
  }
}

/** Clears the neighbours_dirty flag; returns whether it was set. */
export function consumeNeighboursDirty(): boolean {
  try {
    if (localStorage.getItem(NEIGHBOURS_DIRTY_KEY) === "true") {
      localStorage.removeItem(NEIGHBOURS_DIRTY_KEY);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
