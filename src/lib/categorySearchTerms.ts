import { createClient } from "@supabase/supabase-js";

export type CategorySearchTermSource = "manual" | "proactive_ai" | "corrective_ai";
export type CategorySearchTermStatus = "active" | "pending_review";

/** One active alias row joined to its category label (for client resolution). */
export type CategorySearchTermRow = {
  category_id: string;
  term: string;
  label: string;
  language: string;
  source: CategorySearchTermSource;
  status: CategorySearchTermStatus;
  confidence: number | null;
};

/** One canonical category hit for a free-text search term. */
export type CanonicalCategoryMatch = {
  categoryId: string;
  label: string;
};

type KnownSeed = { label: string; aliases: string[] };

type CacheState = {
  rows: CategorySearchTermRow[];
  loadedAt: string | null;
  fromFallback: boolean;
};

let cache: CacheState | null = null;
let knownSeedProvider: (() => KnownSeed[]) | null = null;

/** Own client — avoid circular import with lib/supabase.ts ↔ categories.ts. */
function termsClient() {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !key) throw new Error("Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Avoid circular import: categories.ts registers KNOWN_CATEGORIES as offline seed. */
export function registerKnownCategoriesSeed(provider: () => KnownSeed[]) {
  knownSeedProvider = provider;
}

export function searchTermsFromKnownSeed(): CategorySearchTermRow[] {
  const seeds = knownSeedProvider?.() ?? [];
  const rows: CategorySearchTermRow[] = [];
  for (const def of seeds) {
    for (const term of def.aliases) {
      rows.push({
        category_id: `known:${def.label}`,
        term,
        label: def.label,
        language: "en",
        source: "manual",
        status: "active",
        confidence: null,
      });
    }
  }
  return rows;
}

/** Default pg_trgm similarity floor for Phase 6 fuzzy fallback (hybrid gate). */
export const FUZZY_CATEGORY_SIMILARITY_THRESHOLD = 0.3;
/** Strong trigram hit — accepted without the typo-shaped prefix guard. */
export const FUZZY_CATEGORY_STRONG_SIMILARITY = 0.5;

/** One fuzzy hit (never use for silent exact navigation — confirm via suggest sheet). */
export type FuzzyCanonicalMatch = CanonicalCategoryMatch & {
  matchedTerm: string;
  score: number;
};

/**
 * Exact + substring match (both directions). Returns ALL matching categories
 * (many-to-many ready for multi-category display).
 * Does NOT include trigram/typo fuzzy matches — those are a separate fallback tier.
 */
export function resolveCanonicalTerms(
  rawInput: string,
  rows?: CategorySearchTermRow[],
): CanonicalCategoryMatch[] {
  const t = rawInput.toLowerCase().trim();
  if (!t) return [];

  const list = rows ?? cache?.rows ?? searchTermsFromKnownSeed();
  const byKey = new Map<string, CanonicalCategoryMatch>();

  for (const row of list) {
    if (row.status !== "active") continue;
    const term = row.term.toLowerCase().trim();
    const label = row.label.toLowerCase().trim();
    if (!term || !label) continue;

    const hit =
      t === label ||
      t === term ||
      t.includes(term) ||
      term.includes(t) ||
      t.includes(label) ||
      label.includes(t);

    if (!hit) continue;
    const key = row.category_id.startsWith("known:")
      ? `label:${row.label.toLowerCase()}`
      : row.category_id;
    if (!byKey.has(key)) {
      byKey.set(key, {
        categoryId: row.category_id,
        label: row.label,
      });
    }
  }

  return [...byKey.values()];
}

/** pg_trgm-style trigram set (padded). */
function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** Approximate extensions.similarity() for offline / unit-test fallback. */
export function trigramSimilarity(a: string, b: string): number {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ta = trigrams(x);
  const tb = trigrams(y);
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter += 1;
  }
  const denom = ta.size + tb.size - inter;
  return denom <= 0 ? 0 : inter / denom;
}

function fuzzyTokens(q: string): string[] {
  return q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 5);
}

function passesFuzzyGate(
  cand: string,
  against: string,
  score: number,
  threshold: number,
): boolean {
  if (score >= FUZZY_CATEGORY_STRONG_SIMILARITY) return true;
  if (score < threshold) return false;
  const c = cand.toLowerCase().trim();
  const a = against.toLowerCase().trim();
  return (
    c.slice(0, 2) === a.slice(0, 2) && Math.abs(c.length - a.length) <= 2
  );
}

function bestFuzzyScore(
  candidate: string,
  q: string,
  tokens: string[],
  threshold: number,
): { score: number; against: string } | null {
  const c = candidate.toLowerCase().trim();
  if (!c || c.includes(" ")) return null;
  let best: { score: number; against: string } | null = null;
  const consider = (against: string) => {
    if (Math.abs(c.length - against.length) > 2) return;
    const score = trigramSimilarity(c, against);
    if (!passesFuzzyGate(c, against, score, threshold)) return;
    if (!best || score > best.score) best = { score, against };
  };
  if (q.length >= 5) consider(q);
  for (const tok of tokens) consider(tok);
  return best;
}

/**
 * Client-side fuzzy over cached rows (mirrors RPC guards). Exact/substring
 * hits must be filtered by the caller first — this is a fallback tier only.
 */
export function resolveFuzzyCanonicalTermsLocal(
  rawInput: string,
  rows?: CategorySearchTermRow[],
  threshold = FUZZY_CATEGORY_SIMILARITY_THRESHOLD,
): FuzzyCanonicalMatch[] {
  const q = rawInput.toLowerCase().trim();
  if (q.length < 4) return [];

  const tokens = fuzzyTokens(q);
  const list = rows ?? cache?.rows ?? searchTermsFromKnownSeed();
  const byKey = new Map<string, FuzzyCanonicalMatch>();

  for (const row of list) {
    if (row.status !== "active") continue;
    const termHit = bestFuzzyScore(row.term, q, tokens, threshold);
    const labelHit = bestFuzzyScore(row.label, q, tokens, threshold);
    const best =
      !termHit ? labelHit
      : !labelHit ? termHit
      : termHit.score >= labelHit.score ? termHit : labelHit;
    if (!best) continue;

    const key = row.category_id.startsWith("known:")
      ? `label:${row.label.toLowerCase()}`
      : row.category_id;
    const matchedTerm =
      labelHit && (!termHit || labelHit.score >= termHit.score) ? row.label : row.term;
    const prev = byKey.get(key);
    if (!prev || best.score > prev.score) {
      byKey.set(key, {
        categoryId: row.category_id,
        label: row.label,
        matchedTerm,
        score: best.score,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/**
 * Fuzzy fallback via DB RPC (pg_trgm). Falls back to local trigram over cache
 * when the RPC is unavailable. Never merge these into resolveCanonicalTerms.
 */
export async function resolveFuzzyCanonicalTerms(
  rawInput: string,
  threshold = FUZZY_CATEGORY_SIMILARITY_THRESHOLD,
): Promise<FuzzyCanonicalMatch[]> {
  const q = rawInput.trim();
  if (q.length < 4) return [];

  try {
    const { data, error } = await termsClient().rpc("fuzzy_match_category_search_terms", {
      p_input: q,
      p_threshold: threshold,
    });
    if (!error && Array.isArray(data) && data.length > 0) {
      const byKey = new Map<string, FuzzyCanonicalMatch>();
      for (const raw of data) {
        const categoryId = String(raw?.category_id ?? "");
        const label = String(raw?.label ?? "").trim();
        const matchedTerm = String(raw?.matched_term ?? label).trim();
        const score = Number(raw?.score);
        if (!categoryId || !label || !Number.isFinite(score) || score < threshold) continue;
        const prev = byKey.get(categoryId);
        if (!prev || score > prev.score) {
          byKey.set(categoryId, { categoryId, label, matchedTerm, score });
        }
      }
      const hits = [...byKey.values()].sort(
        (a, b) => b.score - a.score || a.label.localeCompare(b.label),
      );
      if (hits.length > 0) return hits;
    }
  } catch (err) {
    console.warn("[categorySearchTerms] fuzzy RPC failed; using local fallback", err);
  }

  return resolveFuzzyCanonicalTermsLocal(q, undefined, threshold);
}

export function getCategorySearchTermsCache(): CategorySearchTermRow[] | null {
  return cache?.rows ?? null;
}

export function setCategorySearchTermsCacheForTests(rows: CategorySearchTermRow[] | null) {
  cache = rows
    ? { rows, loadedAt: new Date().toISOString(), fromFallback: false }
    : null;
}

export async function refreshCategorySearchTermsCache(): Promise<CategorySearchTermRow[]> {
  try {
    const { data, error } = await termsClient()
      .from("category_search_terms")
      .select(
        "category_id, term, language, source, status, confidence, categories!inner(label, is_active)",
      )
      .eq("status", "active")
      .eq("categories.is_active", true);

    if (error) {
      console.warn("[categorySearchTerms] load failed; using static fallback", error.message);
      const fallback = searchTermsFromKnownSeed();
      cache = { rows: fallback, loadedAt: null, fromFallback: true };
      return fallback;
    }

    const rows: CategorySearchTermRow[] = [];
    for (const raw of data ?? []) {
      const cats = raw.categories as
        | { label?: string; is_active?: boolean }
        | { label?: string; is_active?: boolean }[]
        | null;
      const cat = Array.isArray(cats) ? cats[0] : cats;
      const label = cat?.label?.trim();
      if (!label || !raw.category_id || !raw.term) continue;
      rows.push({
        category_id: String(raw.category_id),
        term: String(raw.term),
        label,
        language: String(raw.language ?? "en"),
        source: (raw.source as CategorySearchTermSource) ?? "manual",
        status: (raw.status as CategorySearchTermStatus) ?? "active",
        confidence:
          raw.confidence == null || Number.isNaN(Number(raw.confidence))
            ? null
            : Number(raw.confidence),
      });
    }

    cache = {
      rows,
      loadedAt: new Date().toISOString(),
      fromFallback: false,
    };
    return rows;
  } catch (err) {
    console.warn("[categorySearchTerms] load threw; using static fallback", err);
    const fallback = searchTermsFromKnownSeed();
    cache = { rows: fallback, loadedAt: null, fromFallback: true };
    return fallback;
  }
}
