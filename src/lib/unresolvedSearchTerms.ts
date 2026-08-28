/**
 * Fire-and-forget capture when Home search exhausts rephrase and falls through
 * to the category browse grid. Future corrective-alias learning will read these rows.
 */
export async function logUnresolvedSearchTerm(params: {
  term: string;
  originalTermIfRephrased?: string | null;
}): Promise<void> {
  const term = params.term.trim();
  if (!term) return;
  try {
    const { supabase } = await import("@/lib/supabase");
    const { error } = await supabase.rpc("log_unresolved_search_term", {
      p_term: term,
      p_original_term_if_rephrased: params.originalTermIfRephrased?.trim() || null,
    });
    if (error) console.warn("log_unresolved_search_term", error);
  } catch (err) {
    console.warn("log_unresolved_search_term failed", err);
  }
}
