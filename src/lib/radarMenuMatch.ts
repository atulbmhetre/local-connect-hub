import { trigramSimilarity } from "@/lib/categorySearchTerms";
import { compareRadarResults, type TrustLevel } from "@/lib/trustLevel";

/** Client trigram floor — same ballpark as Phase 6 strong-ish hits, used only for menu names. */
export const RADAR_MENU_TRIGRAM_MIN = 0.45;

export function foldRadarSearchText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** True when the typed query is not just the category label (e.g. "CCTV installation" vs Electrician). */
export function isSearchMoreSpecificThanCategoryLabels(
  term: string,
  categoryLabels: string[],
): boolean {
  const t = foldRadarSearchText(term);
  if (!t || categoryLabels.length === 0) return false;
  return categoryLabels.every((label) => foldRadarSearchText(label) !== t);
}

export function shouldApplyRadarMenuRanking(opts: {
  radarMode: string;
  searchTerm: string;
  categoryLabels: string[];
}): boolean {
  const mode = opts.radarMode.trim().toLowerCase();
  if (mode !== "help" && mode !== "appointment") return false;
  return isSearchMoreSpecificThanCategoryLabels(opts.searchTerm, opts.categoryLabels);
}

export function menuItemNameMatchesTerm(name: string, term: string): boolean {
  const n = foldRadarSearchText(name);
  const t = foldRadarSearchText(term);
  if (!n || !t) return false;
  if (n === t) return true;
  if (n.includes(t)) return true;
  if (t.includes(n) && n.length >= 4) return true;
  const termTokens = t.split(" ").filter((tok) => tok.length >= 3);
  if (termTokens.length > 0 && termTokens.every((tok) => n.includes(tok))) return true;
  return trigramSimilarity(n, t) >= RADAR_MENU_TRIGRAM_MIN;
}

export function bestMatchingMenuItem<T extends { name: string }>(
  items: T[],
  term: string,
): T | null {
  for (const item of items) {
    if (menuItemNameMatchesTerm(item.name, term)) return item;
  }
  return null;
}

/** Keep preview short, but put the matched service first so the card can highlight it. */
export function promoteMatchedMenuPreview<T extends { name: string }>(
  items: T[],
  matchedName: string | null,
  limit = 5,
): T[] {
  if (!matchedName) return items.slice(0, limit);
  const hitIdx = items.findIndex((item) => item.name === matchedName);
  if (hitIdx < 0) return items.slice(0, limit);
  const hit = items[hitIdx];
  const rest = items.filter((_, i) => i !== hitIdx);
  return [hit, ...rest].slice(0, limit);
}

export function compareRadarResultsWithMenuMatch<T extends {
  menuMatch: boolean;
  dist: number | null;
  trustLevel: TrustLevel;
}>(a: T, b: T): number {
  if (a.menuMatch !== b.menuMatch) return a.menuMatch ? -1 : 1;
  return compareRadarResults(a, b);
}
