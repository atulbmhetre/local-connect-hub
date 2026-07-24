import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { SOSButton } from "@/components/SOSButton";
import { CategoryPicker } from "@/components/CategoryPicker";
import { SearchSuggestSheet, SUGGEST_TIER1_COUNT } from "@/components/SearchSuggestSheet";
import { ParchiSheet } from "@/components/ParchiSheet";
import { AiBridgeSheet } from "@/components/AiBridgeSheet";
import { NeighbourSheet, type SavedVendorInfo } from "@/components/NeighbourSheet";
import { Loader2, Mic, Search, X } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { toast } from "sonner";
import {
  classifySearchTermForRadar,
  fetchCategories,
  groupCategoriesByMode,
  supabase,
  type Category,
  type CategoryGroup,
  type ClassifySearchCandidate,
  type Vendor,
  emojiForVendorCategory,
  useCategoryLabel,
} from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone, hasBeenWelcomed, markWelcomed } from "@/lib/userIdentity";
import { registerUserPushToken } from "@/lib/pushNotifications";
import { useLanguage } from "@/lib/language";
import { useAppConfig } from "@/hooks/useAppConfig";
import { SettingsPageHeader, SettingsSectionLabel } from "@/components/settings/SettingsSection";
import { NotificationBell } from "@/components/NotificationBell";
import { FirstOpenFlow } from "@/components/FirstOpenFlow";
import { cn } from "@/lib/utils";
import { captureError } from "@/lib/sentry";
import { customerOrderShowsLiveLocation } from "@/lib/vendorTrackingPolicy";

type SavedNeighbourTile = {
  savedId: string;
  vendor: Vendor;
  nickname: string;
  category: string;
};

type HelpOrderBanner = {
  orderId: string;
  shopName: string;
  vendorLastUpdated: string | null;
};

type SavedVendorRemovalNotice = {
  id: string;
  shop_name: string;
  category_label: string | null;
  reason: "category_removed" | "account_deleted" | "vendor_banned";
};

/** Tiered AI-search suggestion sheet state (null = closed). */
type SuggestSheetState = {
  /** The user's original free text, preserved verbatim. */
  searchText: string;
  candidates: ClassifySearchCandidate[];
  tier: 1 | 2;
  /** Both tiers rejected — showing the rephrase input. */
  rephrasing: boolean;
  /** This classification came from a rephrased search (second attempt). */
  wasRephrased: boolean;
};

function isVendorLocationStale(
  lastUpdated: string | null | undefined,
  stoppedMinutes: number,
): boolean {
  if (!lastUpdated?.trim()) return false;
  const t = new Date(lastUpdated).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t >= stoppedMinutes * 60 * 1000;
}

const Index = () => {
  const { s, lang } = useLanguage();
  const { config } = useAppConfig();
  const getCategoryLabel = useCategoryLabel();
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [suggest, setSuggest] = useState<SuggestSheetState | null>(null);
  const [savedNeighbours, setSavedNeighbours] = useState<SavedNeighbourTile[]>([]);
  const [parchiVendor, setParchiVendor] = useState<Vendor | null>(null);
  const [parchiOpen, setParchiOpen] = useState(false);
  const [neighbourSheetVendor, setNeighbourSheetVendor] = useState<Vendor | null>(null);
  const [neighbourSheetSaved, setNeighbourSheetSaved] = useState<SavedVendorInfo | null>(null);
  const [neighbourSheetOpen, setNeighbourSheetOpen] = useState(false);
  const [aiSheetOpen, setAiSheetOpen] = useState(false);
  const [aiBridgeVendor, setAiBridgeVendor] = useState<Vendor | null>(null);
  const [activeOrderCount, setActiveOrderCount] = useState(0);
  const [neighbourDeliveryActiveOrder, setNeighbourDeliveryActiveOrder] = useState(false);
  const [appointmentActiveFromDb, setAppointmentActiveFromDb] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [categoriesError, setCategoriesError] = useState(false);
  const [savedNeighboursError, setSavedNeighboursError] = useState(false);
  const [activeOrderCountError, setActiveOrderCountError] = useState(false);
  const [helpBannerError, setHelpBannerError] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pushRegisteredUserRef = useRef<string | null>(null);
  const [userPhone, setUserPhone] = useState(() => getUserPhone());
  const [helpOrderBanner, setHelpOrderBanner] = useState<HelpOrderBanner | null>(null);
  const [helpBannerTick, setHelpBannerTick] = useState(0);
  const [removalNotices, setRemovalNotices] = useState<SavedVendorRemovalNotice[]>([]);
  const [welcomed, setWelcomed] = useState(() => hasBeenWelcomed());

  const loadSavedNeighbours = useCallback(async () => {
    setSavedNeighboursError(false);
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    const { data: saved, error } = await supabase.rpc("get_saved_vendors", {
      p_user_phone: userPhone,
      p_device_id: device_id,
    });
    if (error) {
      captureError(error, { homeSurface: "saved_neighbours", operation: "get_saved_vendors" });
      setSavedNeighboursError(true);
      setSavedNeighbours([]);
      return;
    }
    if (!saved?.length) {
      setSavedNeighbours([]);
      return;
    }
    const vendorIds = [...new Set(saved.map((s) => s.vendor_id))];
    if (vendorIds.length === 0) {
      setSavedNeighbours([]);
      return;
    }
    const { data: vendors, error: vErr } = await supabase
      .from("vendors")
      .select(
        "id, name, shop_name, shop_photo_url, is_active, category, service_mode, phone, verification_status, is_manual_verified, upi_verified, vendor_note, total_helped, on_time_rate",
      )
      .in("id", vendorIds)
      .eq("is_banned", false)
      .eq("discoverable", true);
    if (vErr) {
      captureError(vErr, { homeSurface: "saved_neighbours", operation: "load_vendors" });
      setSavedNeighboursError(true);
      setSavedNeighbours([]);
      return;
    }
    if (!vendors?.length) {
      setSavedNeighbours([]);
      return;
    }
    const byId = new Map(vendors.map((v) => [v.id, v as Vendor]));
    const tiles: SavedNeighbourTile[] = [];
    for (const r of saved) {
      const v = byId.get(r.vendor_id);
      if (v) tiles.push({ savedId: r.id, vendor: v, nickname: r.nickname, category: r.category });
    }
    setSavedNeighbours(tiles);
  }, []);

  useEffect(() => {
    const handler = () => setUserPhone(getUserPhone());
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  useEffect(() => {
    if (!userPhone) return;
    if (pushRegisteredUserRef.current === userPhone) return;
    pushRegisteredUserRef.current = userPhone;
    void registerUserPushToken(userPhone);
  }, [userPhone]);

  useEffect(() => {
    if (location.pathname !== "/") return;
    try {
      if (localStorage.getItem("aaspaas:neighbours_dirty") === "true") {
        localStorage.removeItem("aaspaas:neighbours_dirty");
      }
    } catch {
      /* ignore */
    }
    void loadSavedNeighbours();
  }, [location.pathname, location.key, userPhone, loadSavedNeighbours]);

  const loadRemovalNotices = useCallback(async () => {
    const phone = getUserPhone();
    if (!phone) {
      setRemovalNotices([]);
      return;
    }
    const { data, error } = await supabase.rpc("get_saved_vendor_removal_notices", {
      p_user_phone: phone,
    });
    if (error) {
      console.error("loadRemovalNotices", error);
      setRemovalNotices([]);
      return;
    }
    setRemovalNotices((data ?? []) as SavedVendorRemovalNotice[]);
  }, []);

  useEffect(() => {
    if (location.pathname !== "/") return;
    void loadRemovalNotices();
  }, [location.pathname, location.key, userPhone, loadRemovalNotices]);

  const dismissRemovalNotices = useCallback(async () => {
    const phone = getUserPhone();
    const ids = removalNotices.map((n) => n.id);
    setRemovalNotices([]);
    if (!phone || ids.length === 0) return;
    const { error } = await supabase.rpc("mark_saved_vendor_removal_notices_shown", {
      p_user_phone: phone,
      p_notice_ids: ids,
    });
    if (error) console.error("mark_saved_vendor_removal_notices_shown", error);
  }, [removalNotices]);

  useEffect(() => {
    const run = async () => {
      setCategoriesLoading(true);
      setCategoriesError(false);
      try {
        const cats = await fetchCategories();
        setCategories(cats);
        const modeLabels = {
          help: s.category_mode_help,
          delivery: s.category_mode_delivery,
          appointment: s.category_mode_appointment,
        };
        setCategoryGroups(groupCategoriesByMode(cats, modeLabels));
      } catch (error) {
        captureError(error, { homeSurface: "category_grid", operation: "fetch_categories" });
        setCategories([]);
        setCategoryGroups([]);
        setCategoriesError(true);
      } finally {
        setCategoriesLoading(false);
      }
    };
    void run();
  }, [s.category_mode_help, s.category_mode_delivery, s.category_mode_appointment]);

  const loadHelpOrderBanner = useCallback(async () => {
    setHelpBannerError(false);
    const phone = getUserPhone();
    if (!phone) {
      setHelpOrderBanner(null);
      return;
    }
    // Direct requests reads return zero rows under OTP-off (auth_user_phone()
    // NULL in RLS); read via the identity-scoped RPC instead.
    const { data, error } = await supabase.rpc("get_my_help_banner_orders", {
      p_user_phone: phone,
    });
    if (error) {
      captureError(error, { homeSurface: "help_banner", operation: "get_my_help_banner_orders" });
      setHelpBannerError(true);
      setHelpOrderBanner(null);
      return;
    }
    type HelpRow = {
      id: string;
      status: string;
      updated_at: string;
      created_at?: string | null;
      delivery_slot?: string | null;
      appointment_time?: string | null;
      vendor_shop_name: string | null;
      vendor_service_mode: string | null;
      vendor_last_updated: string | null;
    };
    // Live-location scope: Help continuous; instant Delivery/Appointment only.
    const match = ((data ?? []) as HelpRow[]).find((row) =>
      customerOrderShowsLiveLocation({
        id: row.id,
        status: row.status,
        created_at: row.created_at,
        delivery_slot: row.delivery_slot,
        appointment_time: row.appointment_time,
        service_mode: row.vendor_service_mode,
      }),
    );
    if (!match) {
      setHelpOrderBanner(null);
      return;
    }
    setHelpOrderBanner({
      orderId: match.id,
      shopName: match.vendor_shop_name?.trim() || s.myOrders_shopFallback,
      vendorLastUpdated: match.vendor_last_updated ?? null,
    });
  }, [s.myOrders_shopFallback]);

  useEffect(() => {
    if (location.pathname !== "/") return;
    void loadHelpOrderBanner();
  }, [location.pathname, location.key, userPhone, loadHelpOrderBanner]);

  useEffect(() => {
    const phone = getUserPhone();
    if (!phone) return;

    const channel = supabase
      .channel("home-help-order-banner")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "requests",
          filter: `user_phone=eq.${phone}`,
        },
        () => {
          void loadHelpOrderBanner();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userPhone, loadHelpOrderBanner]);

  useEffect(() => {
    if (!helpOrderBanner) return;
    const onTick = () => {
      setHelpBannerTick((n) => n + 1);
      void loadHelpOrderBanner();
    };
    const t = window.setInterval(onTick, 60_000);
    return () => window.clearInterval(t);
  }, [helpOrderBanner, loadHelpOrderBanner]);

  const loadActiveOrderCount = useCallback(async () => {
    setActiveOrderCountError(false);
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    // Same user-role active window as buildRequestsActiveWindowOrFilter("user"),
    // evaluated server-side (OTP-off callers get zero rows from direct reads).
    const { data, error } = await supabase.rpc("get_my_active_order_count", {
      p_user_phone: userPhone,
      p_device_id: device_id,
    });
    if (error) {
      captureError(error, {
        homeSurface: "active_orders",
        operation: "get_my_active_order_count",
      });
      setActiveOrderCountError(true);
      setActiveOrderCount(0);
      return;
    }
    setActiveOrderCount(typeof data === "number" ? data : 0);
  }, []);

  useEffect(() => {
    if (location.pathname !== "/") return;
    void loadActiveOrderCount();
  }, [location.pathname, location.key, userPhone, loadActiveOrderCount]);

  useEffect(() => {
    if (!neighbourSheetOpen || !neighbourSheetVendor) {
      setNeighbourDeliveryActiveOrder(false);
      return;
    }
    const mode = String(neighbourSheetVendor.service_mode ?? "").trim().toLowerCase();
    if (mode !== "delivery") {
      setNeighbourDeliveryActiveOrder(false);
      return;
    }
    let cancelled = false;
    const run = async () => {
      // Device-scoped (matches the old direct read); RPC because direct
      // requests reads are RLS-blocked for OTP-off callers.
      const { data } = await supabase.rpc("get_my_active_request_vendor_ids", {
        p_user_phone: null,
        p_device_id: getDeviceId(),
        p_vendor_ids: [neighbourSheetVendor.id],
      });
      if (!cancelled) setNeighbourDeliveryActiveOrder(!!data?.length);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [neighbourSheetOpen, neighbourSheetVendor, parchiOpen]);

  useEffect(() => {
    if (!neighbourSheetOpen || !neighbourSheetVendor) {
      setAppointmentActiveFromDb(false);
      return;
    }
    const mode = String(neighbourSheetVendor.service_mode ?? "").trim().toLowerCase();
    if (mode !== "appointment") {
      setAppointmentActiveFromDb(false);
      return;
    }
    let cancelled = false;
    const run = async () => {
      // Device-scoped (matches the old direct read); RPC because direct
      // requests reads are RLS-blocked for OTP-off callers.
      const { data } = await supabase.rpc("get_my_active_request_vendor_ids", {
        p_user_phone: null,
        p_device_id: getDeviceId(),
        p_vendor_ids: [neighbourSheetVendor.id],
      });
      if (!cancelled) setAppointmentActiveFromDb(!!data?.length);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [neighbourSheetOpen, neighbourSheetVendor, parchiOpen]);

  useEffect(() => {
    const st = location.state as { focusSearch?: boolean } | null;
    if (st?.focusSearch) {
      searchInputRef.current?.focus();
    }
  }, [location.state]);

  useEffect(() => {
    if (!localStorage.getItem("aaspaas:role")) {
      localStorage.setItem("aaspaas:role", "user");
    }
  }, []);

  // Navigate to the dedicated Radar screen with the search term in the URL.
  // Keeps Home as a pure entry point and lets Radar own all fetch/rank logic.
  const goToRadar = (term: string, mode?: Category["service_mode"]) => {
    const t = term.trim();
    const validMode = parseRadarMode(mode ?? null);
    const params = new URLSearchParams();
    if (t) params.set("q", t);
    if (validMode) params.set("mode", validMode);
    const qs = params.toString();
    navigate(qs ? `/radar?${qs}` : "/radar");
  };

  function parseRadarMode(raw: string | null): Category["service_mode"] | null {
    const m = raw?.trim().toLowerCase();
    if (m === "help" || m === "delivery" || m === "appointment") return m;
    return null;
  }

  /** Graceful degradation shared by AI-search dead ends: browse the full grid. */
  const fallThroughToCategoryGrid = () => {
    toast.info(s.search_fallback, { duration: 3000 });
    document.getElementById("category-grid")?.scrollIntoView({ behavior: "smooth" });
  };

  /**
   * AI classifier for typed / voice free text only (not Quick Assist / picker).
   * Only an exact category-label match navigates directly; every AI guess is
   * surfaced as ranked candidates the user must confirm in the suggest sheet.
   */
  const runFreeTextSearch = async (raw: string, wasRephrased = false) => {
    const term = raw.trim();
    if (!term) return;
    setClassifying(true);
    try {
      const r = await classifySearchTermForRadar(term, categories);
      if (r.outcome === "exact") {
        goToRadar(r.query);
        return;
      }
      if (r.outcome === "hint") {
        toast.info(r.message);
        return;
      }
      if (r.outcome === "fallback") {
        fallThroughToCategoryGrid();
        return;
      }
      setSuggest({
        searchText: term,
        candidates: r.candidates,
        tier: 1,
        rephrasing: false,
        wasRephrased,
      });
    } finally {
      setClassifying(false);
    }
  };

  const handleSuggestPick = (candidate: ClassifySearchCandidate) => {
    setSuggest(null);
    goToRadar(candidate.label, candidate.mode);
  };

  const handleSuggestNone = () => {
    if (!suggest) return;
    if (suggest.tier === 1 && suggest.candidates.length > SUGGEST_TIER1_COUNT) {
      setSuggest({ ...suggest, tier: 2 });
      return;
    }
    // All candidates rejected. First attempt gets a rephrase prompt; a
    // rephrased attempt falls through to the browse-categories grid.
    if (suggest.wasRephrased) {
      setSuggest(null);
      fallThroughToCategoryGrid();
      return;
    }
    setSuggest({ ...suggest, rephrasing: true });
  };

  const handleSuggestRephrase = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    setSuggest(null);
    setQuery(t);
    await runFreeTextSearch(t, true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const term = query.trim();
    if (!term) {
      setPickerOpen(true);
      return;
    }
    await runFreeTextSearch(term);
  };

  const handleSOS = async () => {
    const term = query.trim();
    if (!term) {
      setPickerOpen(true);
      return;
    }
    await runFreeTextSearch(term);
  };

  const openAiBridgeFromNeighbour = useCallback((vendor: Vendor) => {
    setAiBridgeVendor(vendor);
    setAiSheetOpen(true);
  }, []);

  const completeFirstOpen = () => {
    markWelcomed();
    setWelcomed(true);
    setUserPhone(getUserPhone());
    // Same-tab restore does not fire `storage`; explicitly refresh Home surfaces.
    void loadSavedNeighbours();
    void loadActiveOrderCount();
    void loadRemovalNotices();
  };

  const startVoice = async () => {
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) {
        toast.error(s.home_voice_unavailable);
        return;
      }
      await SpeechRecognition.requestPermissions();
      setListening(true);
      const result = await SpeechRecognition.start({
        language: "en-IN",
        maxResults: 1,
        popup: false,
        partialResults: false,
      });
      if (result?.matches?.length > 0) {
        setQuery(result.matches[0]);
      }
    } catch (e) {
      console.error("Voice error:", e);
    } finally {
      setListening(false);
    }
  };

  return (
    <AppShell theme="light">
      <div className="space-y-3 pb-24" data-testid="home-screen">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <SettingsPageHeader title={s.appName} subtitle={s.taglineSub} />
        </div>
        <NotificationBell className="mt-6 mr-4" />
      </div>

      {removalNotices.length > 0 && (
        <div
          data-testid="home-saved-vendor-removal-banner"
          className="mx-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm relative"
          role="status"
        >
          <button
            type="button"
            data-testid="home-saved-vendor-removal-dismiss"
            onClick={() => void dismissRemovalNotices()}
            className="absolute top-3 right-3 h-8 w-8 grid place-items-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40"
            aria-label={s.home_saved_vendor_removed_dismiss}
          >
            <X className="h-4 w-4" />
          </button>
          <p className="font-semibold text-amber-800 dark:text-amber-300 pr-10">
            {s.home_saved_vendor_removed_title}
          </p>
          <ul className="mt-2 space-y-1.5 pr-8 text-muted-foreground leading-snug list-none">
            {removalNotices.map((n) => (
              <li key={n.id} data-testid="home-saved-vendor-removal-item">
                {n.reason === "account_deleted"
                  ? s.home_saved_vendor_account_closed(n.shop_name)
                  : n.reason === "vendor_banned"
                    ? s.home_saved_vendor_banned(n.shop_name)
                  : s.home_saved_vendor_category_removed(
                      n.shop_name,
                      n.category_label ? getCategoryLabel(n.category_label) : "",
                    )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            data-testid="home-saved-vendor-removal-got-it"
            onClick={() => void dismissRemovalNotices()}
            className="mt-3 text-xs font-semibold text-amber-800 dark:text-amber-300 underline-offset-2 hover:underline"
          >
            {s.home_saved_vendor_removed_dismiss}
          </button>
        </div>
      )}

      {helpBannerError && (
        <p
          data-testid="home-help-banner-error"
          role="status"
          className="mx-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {s.home_help_banner_load_error}
        </p>
      )}

      {helpOrderBanner &&
        (() => {
          void helpBannerTick;
          const stopped = isVendorLocationStale(
            helpOrderBanner.vendorLastUpdated,
            config.vendorStoppedMinutes,
          );
          return (
            <button
              type="button"
              onClick={() => navigate("/my-orders")}
              className={cn(
                "mx-4 w-[calc(100%-2rem)] rounded-xl border bg-surface px-4 py-3 text-left active:scale-[0.99] transition-transform",
                stopped
                  ? "border-l-4 border-l-amber-500 border-amber-500/30 bg-amber-500/5"
                  : "border-l-4 border-l-brand border-brand/30 bg-brand/5",
              )}
            >
              <p
                className={cn(
                  "text-sm font-semibold leading-snug",
                  stopped ? "text-amber-400" : "text-green-700 dark:text-brand",
                )}
              >
                <span className="mr-1.5" aria-hidden>
                  {stopped ? "⚠️" : "🚗"}
                </span>
                {stopped ? s.home_help_vendor_stopped : s.home_help_ontheway}
              </p>
              {!stopped && (
                <p className="mt-0.5 text-xs text-muted-foreground truncate">{helpOrderBanner.shopName}</p>
              )}
            </button>
          );
        })()}

      <div>
        <form onSubmit={handleSubmit} className="relative mx-4">
          <div className="absolute -top-2.5 left-4 z-10 px-2 bg-background">
            <span className="text-[10px] uppercase tracking-[0.2em] font-semibold text-brand inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-brand animate-pulse" />
              {s.aiSearch}
            </span>
          </div>
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={classifying}
            placeholder={s.searchPlaceholder}
            className="w-full bg-surface border border-surface-border rounded-2xl pl-12 pr-12 py-4 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand disabled:opacity-70"
          />
          {Capacitor.isNativePlatform() && (
            <button
              type="button"
              onClick={() => void startVoice()}
              disabled={classifying}
              aria-label={s.home_voice_search_aria}
              className={cn(
                "absolute right-2 top-1/2 -translate-y-1/2 h-10 w-10 rounded-xl grid place-items-center transition-colors disabled:opacity-50",
                listening ? "bg-brand text-page-bg animate-pulse" : "bg-surface border border-surface-border text-muted-foreground",
              )}
            >
              <Mic className="h-5 w-5" />
            </button>
          )}
        </form>
        {classifying && (
          <p className="mt-2 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" aria-hidden />
            {s.findingMatch}
          </p>
        )}
      </div>

      <div className="flex justify-center">
        <SOSButton onClick={() => void handleSOS()} />
      </div>

      {savedNeighboursError && (
        <p
          data-testid="home-saved-neighbours-error"
          role="status"
          className="mx-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {s.home_saved_neighbours_load_error}
        </p>
      )}

      {savedNeighbours.length > 0 && (
        <section className="animate-fade-up">
          <SettingsSectionLabel>{s.myNeighbourhood}</SettingsSectionLabel>
          <div className="flex gap-3 overflow-x-auto pb-1 px-4 scrollbar-hide">
            {savedNeighbours.map(({ savedId, vendor, nickname, category }) => (
              <button
                key={savedId}
                data-testid="saved-neighbour-tile"
                type="button"
                onClick={async () => {
                  const { data } = await supabase
                    .from("vendors")
                    .select("is_active")
                    .eq("id", vendor.id)
                    .single();
                  if (!data?.is_active) {
                    toast.error(s.radar_vendorWentOffline);
                    return;
                  }
                  setNeighbourSheetVendor(vendor);
                  setNeighbourSheetSaved({ nickname, category });
                  setNeighbourSheetOpen(true);
                }}
                className="flex-shrink-0 w-44 rounded-2xl border border-surface-border bg-surface text-left px-4 py-3 flex gap-3 active:scale-[0.98] transition-transform"
              >
                <div className="relative h-14 w-14 rounded-xl overflow-hidden bg-muted shrink-0 grid place-items-center">
                  {vendor.shop_photo_url ? (
                    <img
                      src={vendor.shop_photo_url}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="text-2xl leading-none" aria-hidden>
                      {emojiForVendorCategory(category, categories)}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1 py-0.5">
                  <p className="font-semibold text-sm truncate inline-flex items-center gap-1.5 max-w-full">
                    <span className="truncate">{nickname}</span>
                    {vendor.is_active === true && (
                      <span
                        className="h-2 w-2 rounded-full bg-brand shrink-0"
                        aria-label={s.online}
                      />
                    )}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {getCategoryLabel(category)}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {activeOrderCount > 0 && (
        <div className="mb-6 text-center animate-fade-up">
          <button
            type="button"
            onClick={() => navigate("/my-orders")}
            className="text-sm text-green-700 hover:text-green-800 underline underline-offset-2 font-medium"
          >
            {s.activeOrders(activeOrderCount)}
          </button>
        </div>
      )}
      {activeOrderCountError && (
        <p
          data-testid="home-active-orders-error"
          role="status"
          className="px-4 text-center text-xs text-destructive"
        >
          {s.home_active_orders_load_error}
        </p>
      )}

      <NeighbourSheet
        vendor={neighbourSheetVendor}
        savedVendor={neighbourSheetSaved}
        isOpen={neighbourSheetOpen}
        onClose={() => {
          setNeighbourSheetOpen(false);
          setNeighbourSheetVendor(null);
          setNeighbourSheetSaved(null);
        }}
        onRemove={() => {
          void loadSavedNeighbours();
        }}
        activeDeliveryOrder={neighbourDeliveryActiveOrder}
        activeAppointmentOrder={appointmentActiveFromDb}
        categories={categories}
        onOpenParchi={(v) => {
          setParchiVendor(v);
          setParchiOpen(true);
        }}
        onOpenAiBridge={(v) => {
          void openAiBridgeFromNeighbour(v);
        }}
        onNavigateOrders={() => navigate("/my-orders")}
      />

      {aiBridgeVendor && (
        <AiBridgeSheet
          open={aiSheetOpen}
          onClose={() => {
            setAiSheetOpen(false);
            setAiBridgeVendor(null);
          }}
          vendor={aiBridgeVendor}
          callerPhone={getUserPhone() ?? ""}
          userNeed={aiBridgeVendor.category}
          distanceKm={null}
          onCallSuccess={(vendorId) => {
            try {
              sessionStorage.setItem(`aaspaas:called:${vendorId}`, "1");
            } catch {
              /* ignore */
            }
          }}
        />
      )}

      <ParchiSheet
        vendor={parchiVendor}
        vendorId={parchiVendor?.id}
        serviceMode={parchiVendor?.service_mode}
        isOpen={parchiOpen}
        onClose={() => {
          setParchiOpen(false);
          void loadActiveOrderCount();
          void loadSavedNeighbours();
        }}
      />

      <section id="category-grid" className="animate-fade-up">
        {categoriesLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : categoriesError ? (
          <p
            data-testid="home-categories-error"
            role="status"
            className="mx-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            {s.home_categories_load_error}
          </p>
        ) : (
          <div className="space-y-3">
            {categoryGroups.map((group) => (
              <div key={group.service_mode}>
                <SettingsSectionLabel>{group.label}</SettingsSectionLabel>
                <div className="flex gap-3 overflow-x-auto pb-1 px-4 scrollbar-hide">
                  {group.categories.map((cat) => (
                    <button
                      key={cat.id}
                      data-testid="home-category-button"
                      onClick={() => goToRadar(cat.label, cat.service_mode)}
                      className="flex-shrink-0 w-20 rounded-2xl bg-surface active:scale-95 transition-all flex flex-col items-center justify-center gap-1.5 border border-surface-border py-3 px-2"
                    >
                      <span className="text-3xl">{cat.emoji}</span>
                      <span className="font-semibold text-[10px] text-center leading-tight">
                        {getCategoryLabel(cat.label)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <CategoryPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(label) => {
          setPickerOpen(false);
          const cat = categories.find((c) => c.label === label);
          goToRadar(label, cat?.service_mode);
        }}
        onMic={startVoice}
        categories={categories}
      />

      <SearchSuggestSheet
        open={suggest !== null}
        searchText={suggest?.searchText ?? ""}
        candidates={suggest?.candidates ?? []}
        tier={suggest?.tier ?? 1}
        rephrasing={suggest?.rephrasing ?? false}
        onPick={handleSuggestPick}
        onNone={handleSuggestNone}
        onRephrase={(text) => void handleSuggestRephrase(text)}
        onClose={() => setSuggest(null)}
      />
      </div>
      {!welcomed && (
        <FirstOpenFlow
          onComplete={completeFirstOpen}
          onVendorRegister={() => {
            markWelcomed();
            setWelcomed(true);
            navigate("/vendor");
          }}
        />
      )}
    </AppShell>
  );
};

export default Index;
