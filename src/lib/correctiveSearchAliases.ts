import { getDeviceId } from "@/lib/deviceId";

/**
 * Fire-and-forget: after an exhausted Home search, propose the AI best-guess
 * category as a corrective_ai pending alias for admin review.
 */
export function triggerCorrectiveAliasProposal(params: {
  term: string;
  originalTermIfRephrased?: string | null;
  bestGuessCategoryId: string;
  unresolvedId?: string | null;
  confidence?: number | null;
}): void {
  const term = params.term.trim();
  const categoryId = params.bestGuessCategoryId.trim();
  if (!term || !categoryId) return;

  void (async () => {
    try {
      const { supabase } = await import("@/lib/supabase");
      const { error } = await supabase.functions.invoke("propose-corrective-alias", {
        body: {
          term,
          original_term_if_rephrased: params.originalTermIfRephrased?.trim() || null,
          best_guess_category_id: categoryId,
          unresolved_id: params.unresolvedId ?? null,
          confidence: params.confidence ?? null,
          device_id: getDeviceId(),
        },
      });
      if (error) console.warn("propose-corrective-alias", error.message);
    } catch (err) {
      console.warn("propose-corrective-alias failed", err);
    }
  })();
}

/** Log unresolved term and return row id (null on skip/failure). */
export async function logUnresolvedSearchTermReturningId(params: {
  term: string;
  originalTermIfRephrased?: string | null;
}): Promise<string | null> {
  const term = params.term.trim();
  if (!term) return null;
  try {
    const { supabase } = await import("@/lib/supabase");
    const { data, error } = await supabase.rpc("log_unresolved_search_term", {
      p_term: term,
      p_original_term_if_rephrased: params.originalTermIfRephrased?.trim() || null,
    });
    if (error) {
      console.warn("log_unresolved_search_term", error);
      return null;
    }
    return typeof data === "string" && data ? data : null;
  } catch (err) {
    console.warn("log_unresolved_search_term failed", err);
    return null;
  }
}
