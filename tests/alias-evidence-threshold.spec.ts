/**
 * Alias proposals must not reach admin pending_review until 3 independent actors.
 * One weak signal stays in evidence; a repeated distinct signal queues.
 */
import { test, expect } from "@playwright/test";
import { supabaseAdmin, getActiveCategoryByLabel } from "./helpers/setup";

const T = Date.now();
const TERM = `alias-ev-${T}`;
const createdTermIds: string[] = [];

test.afterAll(async () => {
  if (createdTermIds.length) {
    await supabaseAdmin.from("category_search_terms").delete().in("id", createdTermIds);
  }
  await supabaseAdmin.from("category_search_terms").delete().eq("term", TERM);
  await supabaseAdmin
    .from("category_search_term_evidence")
    .delete()
    .eq("term", TERM);
});

test("ALIAS-EV-01 — single actor stays off the admin queue; third distinct actor queues", async () => {
  const cat = await getActiveCategoryByLabel("Pharmacy");

  const first = await supabaseAdmin.rpc("record_search_alias_evidence", {
    p_category_id: cat.id,
    p_term: TERM,
    p_source: "proactive_ai",
    p_actor_key: `vendor-a-${T}`,
    p_confidence: 0.8,
    p_ai_reasoning: "first independent proposal",
    p_suggested_by_vendor_id: null,
  });
  expect(first.error, first.error?.message).toBeNull();
  expect(first.data).toBe("recorded");

  const retrySame = await supabaseAdmin.rpc("record_search_alias_evidence", {
    p_category_id: cat.id,
    p_term: TERM,
    p_source: "proactive_ai",
    p_actor_key: `vendor-a-${T}`,
    p_confidence: 0.9,
    p_ai_reasoning: "same vendor retry must not count",
    p_suggested_by_vendor_id: null,
  });
  expect(retrySame.error, retrySame.error?.message).toBeNull();
  expect(retrySame.data).toBe("recorded");

  const { data: pendingAfterOne } = await supabaseAdmin
    .from("category_search_terms")
    .select("id, status")
    .eq("category_id", cat.id)
    .eq("term", TERM)
    .maybeSingle();
  expect(pendingAfterOne).toBeNull();

  const second = await supabaseAdmin.rpc("record_search_alias_evidence", {
    p_category_id: cat.id,
    p_term: TERM,
    p_source: "proactive_ai",
    p_actor_key: `vendor-b-${T}`,
    p_confidence: 0.81,
    p_ai_reasoning: "second independent proposal",
    p_suggested_by_vendor_id: null,
  });
  expect(second.error, second.error?.message).toBeNull();
  expect(second.data).toBe("recorded");

  const { data: pendingAfterTwo } = await supabaseAdmin
    .from("category_search_terms")
    .select("id")
    .eq("category_id", cat.id)
    .eq("term", TERM)
    .maybeSingle();
  expect(pendingAfterTwo).toBeNull();

  const third = await supabaseAdmin.rpc("record_search_alias_evidence", {
    p_category_id: cat.id,
    p_term: TERM,
    p_source: "corrective_ai",
    p_actor_key: `device-c-${T}`,
    p_confidence: 0.7,
    p_ai_reasoning: "wrong source must not mix counts",
    p_suggested_by_vendor_id: null,
  });
  expect(third.error, third.error?.message).toBeNull();
  expect(third.data).toBe("recorded");

  const { data: pendingMixed } = await supabaseAdmin
    .from("category_search_terms")
    .select("id")
    .eq("category_id", cat.id)
    .eq("term", TERM)
    .maybeSingle();
  expect(pendingMixed).toBeNull();

  const queued = await supabaseAdmin.rpc("record_search_alias_evidence", {
    p_category_id: cat.id,
    p_term: TERM,
    p_source: "proactive_ai",
    p_actor_key: `vendor-c-${T}`,
    p_confidence: 0.85,
    p_ai_reasoning: "third independent proposal",
    p_suggested_by_vendor_id: null,
  });
  expect(queued.error, queued.error?.message).toBeNull();
  expect(queued.data).toBe("queued");

  const { data: pending } = await supabaseAdmin
    .from("category_search_terms")
    .select("id, status, source, term")
    .eq("category_id", cat.id)
    .eq("term", TERM)
    .single();
  expect(pending?.status).toBe("pending_review");
  expect(pending?.source).toBe("proactive_ai");
  if (pending?.id) createdTermIds.push(pending.id);

  const already = await supabaseAdmin.rpc("record_search_alias_evidence", {
    p_category_id: cat.id,
    p_term: TERM,
    p_source: "proactive_ai",
    p_actor_key: `vendor-d-${T}`,
    p_confidence: 0.7,
    p_ai_reasoning: "already queued",
    p_suggested_by_vendor_id: null,
  });
  expect(already.error, already.error?.message).toBeNull();
  expect(already.data).toBe("skipped_exists_pending");
});

test("ALIAS-EV-02 — corrective_ai needs 3 distinct customer actors", async () => {
  const cat = await getActiveCategoryByLabel("Electrician");
  const term = `corr-ev-${T}`;

  const one = await supabaseAdmin.rpc("record_search_alias_evidence", {
    p_category_id: cat.id,
    p_term: term,
    p_source: "corrective_ai",
    p_actor_key: `cust-1-${T}`,
    p_confidence: 0.72,
    p_ai_reasoning: "customer 1 exhausted search",
    p_suggested_by_vendor_id: null,
  });
  expect(one.data).toBe("recorded");

  const two = await supabaseAdmin.rpc("record_search_alias_evidence", {
    p_category_id: cat.id,
    p_term: term,
    p_source: "corrective_ai",
    p_actor_key: `cust-2-${T}`,
    p_confidence: 0.73,
    p_ai_reasoning: "customer 2 exhausted search",
    p_suggested_by_vendor_id: null,
  });
  expect(two.data).toBe("recorded");

  const { data: stillHidden } = await supabaseAdmin
    .from("category_search_terms")
    .select("id")
    .eq("term", term)
    .maybeSingle();
  expect(stillHidden).toBeNull();

  const three = await supabaseAdmin.rpc("record_search_alias_evidence", {
    p_category_id: cat.id,
    p_term: term,
    p_source: "corrective_ai",
    p_actor_key: `cust-3-${T}`,
    p_confidence: 0.74,
    p_ai_reasoning: "customer 3 exhausted search",
    p_suggested_by_vendor_id: null,
  });
  expect(three.data).toBe("queued");

  const { data: pending } = await supabaseAdmin
    .from("category_search_terms")
    .select("id, status, source")
    .eq("term", term)
    .single();
  expect(pending?.status).toBe("pending_review");
  expect(pending?.source).toBe("corrective_ai");
  if (pending?.id) createdTermIds.push(pending.id);

  await supabaseAdmin.from("category_search_term_evidence").delete().eq("term", term);
});
