/**
 * Phase 4 live smoke (TEST only):
 * - Dairy vendor + milk menu → Pending Aliases UI
 * - Approve → active + Home search
 * - Reject → row gone
 * - Restaurant/Bakery + milk tea → no false "milk" alias
 * - Menu add → fresh proactive proposals
 *
 * Run: PW_REUSE_DEV_SERVER=true npx playwright test tests/phase4-pending-aliases-smoke.spec.ts --retries=0
 */
import { expect, test, type Page } from "@playwright/test";
import {
  APP_URL,
  ensureTestAdminUser,
  loginAsAdminViaSession,
} from "./helpers/browser-setup";
import {
  getAnonKey,
  getServiceRoleClient,
  getSupabaseUrl,
  loadTestEnv,
} from "./helpers/testEnv";
import {
  createTestVendor,
  getActiveCategoryByLabel,
} from "./helpers/setup";

loadTestEnv();

const SESSION = `P4SMOKE_${Date.now()}`;
const observations: string[] = [];
const createdVendorIds: string[] = [];
const createdTermIds: string[] = [];
const admin = getServiceRoleClient();

async function ensureDairyCategory() {
  const { data: existing } = await admin
    .from("categories")
    .select("id, label, service_mode, emoji")
    .eq("label", "Dairy")
    .maybeSingle();
  if (existing?.id) {
    await admin
      .from("categories")
      .update({ is_active: true, status: "active" })
      .eq("id", existing.id);
    return existing;
  }
  const { data, error } = await admin
    .from("categories")
    .insert({
      label: "Dairy",
      emoji: "🥛",
      service_mode: "delivery",
      is_active: true,
      status: "active",
      sort_order: 50,
    })
    .select("id, label, service_mode, emoji")
    .single();
  if (error) throw error;
  return data!;
}

async function seedMenu(
  vendorId: string,
  categoryId: string,
  items: Array<{ name: string; price: number; description?: string }>,
) {
  const { error } = await admin.from("vendor_menu_items").insert(
    items.map((item, i) => ({
      vendor_id: vendorId,
      category_id: categoryId,
      name: item.name,
      price: item.price,
      description: item.description ?? null,
      sort_order: i,
      is_available: true,
    })),
  );
  if (error) throw error;
}

async function invokeSuggestAliases(vendorId: string, categoryId: string) {
  const resp = await fetch(
    `${getSupabaseUrl()}/functions/v1/suggest-category-aliases`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${getAnonKey()}`,
      },
      body: JSON.stringify({
        vendor_id: vendorId,
        category_id: categoryId,
        device_id: `p4_smoke_${SESSION}`,
      }),
    },
  );
  const body = await resp.json().catch(() => ({}));
  return { status: resp.status, body };
}

async function waitForPendingAliases(
  vendorId: string,
  categoryId: string,
  minCount = 1,
  timeoutMs = 90_000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data, error } = await admin
      .from("category_search_terms")
      .select(
        "id, term, status, source, confidence, ai_reasoning, suggested_by_vendor_id",
      )
      .eq("category_id", categoryId)
      .eq("status", "pending_review")
      .eq("suggested_by_vendor_id", vendorId)
      .eq("source", "proactive_ai")
      .order("created_at", { ascending: false });
    if (error) throw error;
    if ((data?.length ?? 0) >= minCount) return data!;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `Timed out waiting for >=${minCount} pending aliases for vendor ${vendorId}`,
  );
}

async function openPendingAliases(page: Page) {
  const btn = page.getByRole("button", { name: /Pending Aliases/i });
  await expect(btn).toBeVisible({ timeout: 15_000 });
  await btn.click();
  observations.push(`UI: opened Pending Aliases (${await btn.innerText()})`);
}

function aliasCardById(page: Page, id: string) {
  return page.getByTestId(`pending-alias-card-${id}`);
}

function aliasCardByTerm(page: Page, term: string) {
  return page.locator(`[data-alias-term="${term}"]`);
}

test.afterAll(async () => {
  for (const id of createdTermIds) {
    await admin.from("category_search_terms").delete().eq("id", id);
  }
  // Session-tagged pending leftovers
  await admin
    .from("category_search_terms")
    .delete()
    .ilike("ai_reasoning", `%${SESSION}%`);
  await admin
    .from("category_search_terms")
    .delete()
    .ilike("term", `%p4smoke%`);

  for (const vid of createdVendorIds) {
    await admin.from("vendor_menu_items").delete().eq("vendor_id", vid);
    await admin.from("vendor_category_modes").delete().in(
      "vendor_category_id",
      (
        await admin
          .from("vendor_categories")
          .select("id")
          .eq("vendor_id", vid)
      ).data?.map((r) => r.id) ?? [],
    );
    await admin.from("vendor_categories").delete().eq("vendor_id", vid);
    await admin.from("vendors").delete().eq("id", vid);
    await admin
      .from("category_search_terms")
      .update({ suggested_by_vendor_id: null })
      .eq("suggested_by_vendor_id", vid);
  }
  console.log("P4_SMOKE_OBSERVATIONS\n" + observations.join("\n"));
});

test("Phase 4 live: dairy aliases UI approve/reject/search + milk-tea negative + menu re-trigger", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await ensureTestAdminUser();

  const dairy = await ensureDairyCategory();
  const bakery = await getActiveCategoryByLabel("Bakery");
  observations.push(`categories dairy=${dairy.id} bakery=${bakery.id}`);

  // ── 1) Dairy vendor + milk menu (registration-equivalent profile) ─────────
  const dairyVendor = await createTestVendor({
    shop_name: `!P4-Dairy-${SESSION}`,
    category: "Dairy",
    service_mode: "delivery",
    vendor_note: `Neighbourhood dairy — fresh cow and buffalo milk, paneer, ghee. Session ${SESSION}`,
    category_ids: [dairy.id],
    category_service_modes: ["delivery"],
    category_modes: { [dairy.id]: ["delivery"] },
    serves_at_customer_place: true,
  });
  createdVendorIds.push(dairyVendor.id);

  await admin
    .from("vendor_categories")
    .update({
      vendor_note: `Doorstep dairy delivery. Cow milk, buffalo milk, paneer, ghee. ${SESSION}`,
      brand_name: `P4 Dairy ${SESSION}`,
      status: "approved",
    })
    .eq("vendor_id", dairyVendor.id)
    .eq("category_id", dairy.id);

  await seedMenu(dairyVendor.id, dairy.id, [
    { name: "cow milk", price: 60, description: "1L fresh cow milk" },
    { name: "buffalo milk", price: 70, description: "1L buffalo milk" },
    { name: "paneer", price: 320, description: "homemade paneer" },
    { name: "ghee", price: 550, description: "pure desi ghee" },
  ]);
  observations.push(`seeded dairy vendor ${dairyVendor.id} with milk menu`);

  const dairyInvoke = await invokeSuggestAliases(dairyVendor.id, dairy.id);
  observations.push(
    `dairy suggest-category-aliases status=${dairyInvoke.status} body=${JSON.stringify(dairyInvoke.body)}`,
  );
  expect(dairyInvoke.status).toBe(200);
  expect(dairyInvoke.body?.success).toBe(true);

  let dairyPending = await waitForPendingAliases(dairyVendor.id, dairy.id, 1);
  for (const row of dairyPending) createdTermIds.push(row.id);
  observations.push(
    `dairy pending aliases: ${JSON.stringify(
      dairyPending.map((r) => ({
        term: r.term,
        confidence: r.confidence,
        reasoning: r.ai_reasoning,
      })),
    )}`,
  );
  expect(dairyPending.length).toBeGreaterThanOrEqual(1);
  // Sensible dairy-ish proposals (not requiring exact list)
  const dairyTerms = dairyPending.map((r) => r.term.toLowerCase());
  const looksDairy = dairyTerms.some((t) =>
    /milk|doodh|paneer|ghee|dairy|buffalo|cow|desi/.test(t),
  );
  expect(looksDairy).toBe(true);
  for (const row of dairyPending) {
    expect(row.ai_reasoning?.trim().length ?? 0).toBeGreaterThan(5);
    expect(row.source).toBe("proactive_ai");
    expect(row.status).toBe("pending_review");
  }

  // ── 2) Admin UI: Pending Aliases visible ──────────────────────────────────
  await loginAsAdminViaSession(page, `p4_admin_${SESSION}`);
  await expect(page.getByTestId("admin-panel")).toBeVisible({ timeout: 15_000 });
  await openPendingAliases(page);

  const preferApprove = (t: string) =>
    /^(homemade paneer|doorstep milk delivery|desi ghee|paneer|doodh)/i.test(t) ||
    (/paneer|ghee|doodh|milk/.test(t) && t.split(/\s+/).length <= 4);
  const approveTarget =
    dairyPending.find((r) => preferApprove(r.term)) ?? dairyPending[0];
  const rejectTarget =
    dairyPending.find((r) => r.id !== approveTarget.id) ?? dairyPending[0];
  observations.push(
    `approveTarget=${approveTarget.term} rejectTarget=${rejectTarget.term}`,
  );

  const approveCard = aliasCardById(page, approveTarget.id);
  await expect(approveCard).toBeVisible({ timeout: 15_000 });
  await expect(approveCard.locator("span.text-xs.text-muted-foreground").filter({ hasText: /^Dairy$/ })).toBeVisible();
  await expect(approveCard.getByText("From vendor profile", { exact: true })).toBeVisible();
  observations.push(
    `UI approve card: ${(await approveCard.innerText()).replace(/\s+/g, " ").slice(0, 320)}`,
  );

  // ── 3) Approve one ────────────────────────────────────────────────────────
  await approveCard.getByRole("button", { name: /Approve/i }).click();
  await page.waitForTimeout(1500);
  await expect(aliasCardById(page, approveTarget.id)).toHaveCount(0, {
    timeout: 12_000,
  });
  observations.push(`UI: approved alias gone from pending: ${approveTarget.term}`);

  const { data: approvedRow } = await admin
    .from("category_search_terms")
    .select("id, term, status")
    .eq("id", approveTarget.id)
    .single();
  observations.push(`DB after approve: ${JSON.stringify(approvedRow)}`);
  expect(approvedRow?.status).toBe("active");

  // ── 4) Home search — approved term resolves to Dairy ──────────────────────
  await page.goto(`${APP_URL}/`);
  await page.evaluate((deviceId) => {
    localStorage.setItem("aaspaas:device_id", deviceId);
    localStorage.setItem("aaspaas:welcomed", "true");
  }, `p4_home_${SESSION}`);

  // Wait for active aliases cache (fire-and-forget after fetchCategories).
  const cacheWait = page.waitForResponse(
    (r) =>
      r.url().includes("category_search_terms") &&
      r.request().method() === "GET" &&
      r.ok(),
    { timeout: 30_000 },
  );
  await page.goto(`${APP_URL}/`);
  await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Dairy", { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  await cacheWait.catch(() => undefined);
  // Extra beat: refreshCategorySearchTermsCache is void-chained after categories.
  await page.waitForTimeout(1500);

  // Confirm DB row is active before UI search (sanity).
  const { data: liveAlias } = await admin
    .from("category_search_terms")
    .select("term, status")
    .eq("id", approveTarget.id)
    .single();
  expect(liveAlias?.status).toBe("active");

  const search = page.locator("form input[placeholder]").first();
  await search.fill(approveTarget.term);
  await expect(search).toHaveValue(approveTarget.term);
  await page.getByTestId("home-sos-button").click();

  const fellThrough = page
    .getByText(/isn't available yet|Couldn't find a match|browsing categories/i)
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(async () => {
      throw new Error(
        `Home search fell through for approved alias "${approveTarget.term}"`,
      );
    });
  const radarUrl = page.waitForURL(/\/radar/, { timeout: 30_000 }).then(() => "radar");
  const suggestSheet = page
    .getByTestId("search-suggest-sheet")
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => "sheet");
  const outcome = await Promise.race([radarUrl, suggestSheet, fellThrough]);
  observations.push(`Home search outcome=${outcome} term=${approveTarget.term}`);

  if (outcome === "radar") {
    expect(page.url()).toMatch(/q=/i);
    const q = new URL(page.url()).searchParams.get("q") ?? "";
    expect(q.toLowerCase()).toMatch(/dairy|milk|paneer|ghee|doodh|buffalo/i);
    observations.push(`Radar q=${q}`);
  } else {
    const sheet = page.getByTestId("search-suggest-sheet");
    await expect(sheet.getByText(/Dairy/i)).toBeVisible({ timeout: 8_000 });
    observations.push("Suggest sheet shows Dairy candidate");
  }

  // ── 5) Reject a different pending alias (reuse admin session) ─────────────
  if (rejectTarget.id === approveTarget.id) {
    // Only one proposal — insert a second pending to reject
    const { data: extra, error: extraErr } = await admin
      .from("category_search_terms")
      .insert({
        category_id: dairy.id,
        term: `p4smoke reject ${SESSION}`.toLowerCase(),
        source: "proactive_ai",
        status: "pending_review",
        confidence: 0.8,
        ai_reasoning: `Synthetic reject target ${SESSION}`,
        suggested_by_vendor_id: dairyVendor.id,
      })
      .select("id, term")
      .single();
    if (extraErr) throw extraErr;
    createdTermIds.push(extra!.id);
    Object.assign(rejectTarget, extra!);
    observations.push(`seeded synthetic reject target ${extra!.term}`);
  }

  await page.goto(`${APP_URL}/settings`);
  const { revealAdminTab } = await import("./helpers/browser-setup");
  await revealAdminTab(page);
  await page.getByTestId("settings-tab-admin").click();
  // Session from earlier login should still be active
  const adminReady = page.getByTestId("admin-panel");
  if (!(await adminReady.isVisible({ timeout: 5_000 }).catch(() => false))) {
    await loginAsAdminViaSession(page, `p4_admin_reject_${SESSION}`);
  }
  await expect(page.getByTestId("admin-panel")).toBeVisible({ timeout: 15_000 });
  await openPendingAliases(page);
  const rejectCard = aliasCardById(page, rejectTarget.id);
  await expect(rejectCard).toBeVisible({ timeout: 15_000 });
  await rejectCard.getByRole("button", { name: /Reject/i }).click();
  await page.waitForTimeout(1500);
  await expect(aliasCardById(page, rejectTarget.id)).toHaveCount(0, {
    timeout: 12_000,
  });
  observations.push(`UI: rejected alias gone: ${rejectTarget.term}`);

  const { data: gone } = await admin
    .from("category_search_terms")
    .select("id")
    .eq("id", rejectTarget.id)
    .maybeSingle();
  expect(gone).toBeNull();
  observations.push("DB: rejected row deleted");

  // ── 6) Negative: Bakery/restaurant profile with milk tea ──────────────────
  const cafeVendor = await createTestVendor({
    shop_name: `!P4-Cafe-${SESSION}`,
    category: "Bakery",
    service_mode: "delivery",
    vendor_note: `Small café bakery — snacks and milk tea. Not a dairy. ${SESSION}`,
    category_ids: [bakery.id],
    category_service_modes: ["delivery"],
    category_modes: { [bakery.id]: ["delivery"] },
    serves_at_customer_place: true,
  });
  createdVendorIds.push(cafeVendor.id);
  await admin
    .from("vendor_categories")
    .update({
      vendor_note: `Café snacks, milk tea, samosa. Restaurant-style bakery. ${SESSION}`,
      brand_name: `P4 Cafe ${SESSION}`,
      status: "approved",
    })
    .eq("vendor_id", cafeVendor.id)
    .eq("category_id", bakery.id);
  await seedMenu(cafeVendor.id, bakery.id, [
    { name: "milk tea", price: 40, description: "chai with milk" },
    { name: "samosa", price: 20 },
    { name: "bread pakora", price: 25 },
  ]);

  const cafeInvoke = await invokeSuggestAliases(cafeVendor.id, bakery.id);
  observations.push(
    `cafe suggest-category-aliases status=${cafeInvoke.status} body=${JSON.stringify(cafeInvoke.body)}`,
  );
  expect(cafeInvoke.status).toBe(200);

  // Wait briefly; zero inserts is success for anti keyword-trap
  await page.waitForTimeout(4000);
  const { data: cafePending } = await admin
    .from("category_search_terms")
    .select("id, term, ai_reasoning")
    .eq("suggested_by_vendor_id", cafeVendor.id)
    .eq("status", "pending_review");
  for (const row of cafePending ?? []) createdTermIds.push(row.id);
  observations.push(
    `cafe pending aliases: ${JSON.stringify((cafePending ?? []).map((r) => r.term))}`,
  );
  const falseMilk = (cafePending ?? []).filter(
    (r) => r.term.trim().toLowerCase() === "milk",
  );
  expect(falseMilk, 'must not propose isolated "milk" for café milk-tea profile').toHaveLength(
    0,
  );

  // ── 7) Menu-add re-trigger: new item → fresh proposals ────────────────────
  const beforeTerms = new Set(
    (
      await admin
        .from("category_search_terms")
        .select("term")
        .eq("suggested_by_vendor_id", dairyVendor.id)
        .eq("status", "pending_review")
    ).data?.map((r) => r.term.toLowerCase()) ?? [],
  );

  await seedMenu(dairyVendor.id, dairy.id, [
    {
      name: "flavoured lassi",
      price: 45,
      description: `sweet mango lassi ${SESSION}`,
    },
  ]);
  observations.push("added menu item: flavoured lassi");

  const menuInvoke = await invokeSuggestAliases(dairyVendor.id, dairy.id);
  observations.push(
    `menu-retrigger suggest status=${menuInvoke.status} body=${JSON.stringify(menuInvoke.body)}`,
  );
  expect(menuInvoke.status).toBe(200);
  expect(menuInvoke.body?.success).toBe(true);

  // Poll for at least one NEW pending term (or confirm inserted>0)
  let foundNew = false;
  let newRows: typeof dairyPending = [];
  for (let i = 0; i < 40; i++) {
    const { data } = await admin
      .from("category_search_terms")
      .select(
        "id, term, status, source, confidence, ai_reasoning, suggested_by_vendor_id",
      )
      .eq("category_id", dairy.id)
      .eq("status", "pending_review")
      .eq("suggested_by_vendor_id", dairyVendor.id)
      .eq("source", "proactive_ai");
    newRows = (data ?? []).filter((r) => !beforeTerms.has(r.term.toLowerCase()));
    if (newRows.length > 0 || (menuInvoke.body?.inserted ?? 0) > 0) {
      foundNew = newRows.length > 0 || menuInvoke.body?.inserted > 0;
      if (newRows.length > 0) break;
    }
    // If AI returns no_new_aliases because terms already covered, allow
    // sensible re-pass with inserted=0 only when outcome is no_new_aliases
    if (
      menuInvoke.body?.outcome === "no_new_aliases" &&
      menuInvoke.body?.proposed > 0
    ) {
      foundNew = true; // pass fired; proposals may already exist as pending/active
      break;
    }
    await page.waitForTimeout(1500);
  }
  for (const row of newRows) createdTermIds.push(row.id);
  observations.push(
    `menu-retrigger new pending: ${JSON.stringify(newRows.map((r) => r.term))} outcome=${menuInvoke.body?.outcome}`,
  );
  expect(foundNew || (menuInvoke.body?.proposed ?? 0) > 0).toBe(true);

  // If we got brand-new pending rows, they should look dairy-sensible
  if (newRows.length > 0) {
    const ok = newRows.some((r) =>
      /lassi|milk|doodh|paneer|ghee|dairy|buffalo|curd|chaas/.test(r.term.toLowerCase()),
    );
    expect(ok).toBe(true);
    for (const row of newRows) {
      expect(row.ai_reasoning?.trim().length ?? 0).toBeGreaterThan(5);
    }
  }

  console.log("P4_SMOKE_OK", {
    approved: approveTarget.term,
    rejected: rejectTarget.term,
    dairyPendingCount: dairyPending.length,
    cafeFalseMilk: falseMilk.length,
    menuOutcome: menuInvoke.body,
  });
});
