/**
 * TEST: hybrid session identity on reputational/cosmetic RPCs.
 * Usage: node scripts/probes/test-vendor-session-hybrid-b2-rep.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const TEST_REF = "hhdylnhqdzfabsolwxdz";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ".env.test"), override: true });

const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const anon = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
if (!url.includes(TEST_REF) || !anon || !service) {
  console.error("HARD STOP: .env.test is not TEST or missing keys");
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });
const T = Date.now();
const phoneA = `98216${String(T).slice(-5)}`;
const phoneB = `98217${String(T).slice(-5)}`;
const emailA = `test+91${phoneA}@aaspaas.invalid`;
const passwordA = `test_pw_${phoneA}`;
const custB = `88017${String(T).slice(-5)}`;
const custA = `88018${String(T).slice(-5)}`;

let vendorA = null;
let vendorB = null;
let reqA = null;
let reqB = null;
let reviewA = null;
let reviewB = null;
let userAId = null;

function msg(err) {
  return err?.message ?? null;
}

function isUnauthorized(err) {
  return String(msg(err) ?? "").includes("not_found_or_unauthorized");
}

async function seedVendor(phone, tag) {
  const { data, error } = await admin
    .from("vendors")
    .insert({
      name: `B2Rep ${tag} ${T}`,
      shop_name: `!B2REP-${tag}-${T}`,
      phone,
      category: "Test",
      service_mode: "delivery",
      is_active: true,
      profile_status: "complete",
      latitude: 18.52,
      longitude: 73.85,
      service_radius_km: 5,
      verification_status: "identity_linked",
    })
    .select("id, phone, verification_status")
    .single();
  if (error || !data) throw new Error(`seed vendor ${tag}: ${error?.message}`);
  return data;
}

async function seedRequest(vendorId, userPhone) {
  const { data, error } = await admin
    .from("requests")
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      device_id: `b2rep-${userPhone}`,
      message: "bucket2 rep session probe",
      status: "fulfilled",
      service_mode: "delivery",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed request: ${error?.message}`);
  return data.id;
}

async function seedReview(vendorId, requestId, userPhone) {
  const { data, error } = await admin
    .from("vendor_reviews")
    .insert({
      vendor_id: vendorId,
      request_id: requestId,
      user_phone: userPhone,
      rating: 5,
      review_text: "probe",
      service_mode: "delivery",
    })
    .select("id, vendor_response")
    .single();
  if (error || !data) throw new Error(`seed review: ${error?.message}`);
  return data.id;
}

try {
  vendorA = await seedVendor(phoneA, "A");
  vendorB = await seedVendor(phoneB, "B");

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: emailA,
    phone: `+91${phoneA}`,
    email_confirm: true,
    phone_confirm: true,
    password: passwordA,
  });
  if (createErr && !/already|exists|registered/i.test(createErr.message)) {
    throw new Error(`createUser A: ${createErr.message}`);
  }
  userAId = created?.user?.id ?? null;

  reqA = await seedRequest(vendorA.id, custA);
  reqB = await seedRequest(vendorB.id, custB);
  reviewA = await seedReview(vendorA.id, reqA, custA);
  reviewB = await seedReview(vendorB.id, reqB, custB);

  const noSession = createClient(url, anon, { auth: { persistSession: false } });
  const asA = createClient(url, anon, { auth: { persistSession: false } });
  const { error: signErr } = await asA.auth.signInWithPassword({
    email: emailA,
    password: passwordA,
  });
  if (signErr) throw new Error(`signIn A: ${signErr.message}`);

  const d1reply = await asA.rpc("vendor_reply_to_review", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_review_id: reviewB,
    p_response: "hijack reply",
  });
  const { data: reviewBAfterD1 } = await admin
    .from("vendor_reviews")
    .select("vendor_response")
    .eq("id", reviewB)
    .single();

  const offerArgs = (vendorId, phone, content) => ({
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_content: content,
    p_lat: 18.52,
    p_lng: 73.85,
    p_business_category_id: null,
  });

  const d1offer = await asA.rpc("vendor_post_offer", offerArgs(vendorB.id, phoneB, `hijack-offer-${T}`));
  const { count: hijackOffers } = await admin
    .from("feed_posts")
    .select("id", { count: "exact", head: true })
    .eq("vendor_id", vendorB.id)
    .eq("content", `hijack-offer-${T}`);

  const d1promote = await asA.rpc("vendor_promote_green_pending", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });
  const { data: vendorBAfterD1 } = await admin
    .from("vendors")
    .select("verification_status")
    .eq("id", vendorB.id)
    .single();

  const d2reply = await asA.rpc("vendor_reply_to_review", {
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
    p_review_id: reviewA,
    p_response: "own reply",
  });
  const { data: reviewAAfter } = await admin
    .from("vendor_reviews")
    .select("vendor_response")
    .eq("id", reviewA)
    .single();

  const d2offer = await asA.rpc("vendor_post_offer", offerArgs(vendorA.id, phoneA, `own-offer-${T}`));
  const { count: ownOffers } = await admin
    .from("feed_posts")
    .select("id", { count: "exact", head: true })
    .eq("vendor_id", vendorA.id)
    .eq("content", `own-offer-${T}`);

  const d2promote = await asA.rpc("vendor_promote_green_pending", {
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
  });

  const d3reply = await noSession.rpc("vendor_reply_to_review", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_review_id: reviewB,
    p_response: "old-client reply",
  });
  const { data: reviewBAfterD3 } = await admin
    .from("vendor_reviews")
    .select("vendor_response")
    .eq("id", reviewB)
    .single();

  const d3offer = await noSession.rpc("vendor_post_offer", offerArgs(vendorB.id, phoneB, `old-offer-${T}`));
  const { count: oldOffers } = await admin
    .from("feed_posts")
    .select("id", { count: "exact", head: true })
    .eq("vendor_id", vendorB.id)
    .eq("content", `old-offer-${T}`);

  const d3promote = await noSession.rpc("vendor_promote_green_pending", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });

  const report = {
    d1_sessionA_reply_B: { error: msg(d1reply.error), response: reviewBAfterD1?.vendor_response ?? null },
    d1_sessionA_offer_B: { error: msg(d1offer.error), hijack_rows: hijackOffers ?? 0 },
    d1_sessionA_promote_B: {
      error: msg(d1promote.error),
      status: vendorBAfterD1?.verification_status,
    },
    d2_sessionA_reply_A: { error: msg(d2reply.error), response: reviewAAfter?.vendor_response ?? null },
    d2_sessionA_offer_A: { error: msg(d2offer.error), own_rows: ownOffers ?? 0 },
    d2_sessionA_promote_A: { error: msg(d2promote.error), data: d2promote.data },
    d3_no_session_reply_B: {
      error: msg(d3reply.error),
      response: reviewBAfterD3?.vendor_response ?? null,
    },
    d3_no_session_offer_B: { error: msg(d3offer.error), old_rows: oldOffers ?? 0 },
    d3_no_session_promote_B: { error: msg(d3promote.error), data: d3promote.data },
  };
  console.log(JSON.stringify(report, null, 2));

  const d1ok =
    isUnauthorized(d1reply.error) &&
    !reviewBAfterD1?.vendor_response &&
    isUnauthorized(d1offer.error) &&
    (hijackOffers ?? 0) === 0 &&
    isUnauthorized(d1promote.error) &&
    vendorBAfterD1?.verification_status === "identity_linked";
  const d2ok =
    !d2reply.error &&
    reviewAAfter?.vendor_response === "own reply" &&
    !d2offer.error &&
    (ownOffers ?? 0) === 1 &&
    !isUnauthorized(d2promote.error);
  const d3ok =
    !d3reply.error &&
    reviewBAfterD3?.vendor_response === "old-client reply" &&
    !d3offer.error &&
    (oldOffers ?? 0) === 1 &&
    !isUnauthorized(d3promote.error);

  if (!d1ok || !d2ok || !d3ok) {
    console.error("OVERALL: FAIL", { d1ok, d2ok, d3ok });
    process.exit(2);
  }
  console.log("OVERALL: PASS");
} finally {
  if (vendorA) await admin.from("feed_posts").delete().eq("vendor_id", vendorA.id);
  if (vendorB) await admin.from("feed_posts").delete().eq("vendor_id", vendorB.id);
  for (const id of [reviewA, reviewB]) {
    if (id) await admin.from("vendor_reviews").delete().eq("id", id);
  }
  for (const id of [reqA, reqB]) {
    if (id) await admin.from("requests").delete().eq("id", id);
  }
  if (vendorA) await admin.from("vendors").delete().eq("id", vendorA.id);
  if (vendorB) await admin.from("vendors").delete().eq("id", vendorB.id);
  if (userAId) {
    await admin.auth.admin.deleteUser(userAId).catch(() => {});
  }
}
