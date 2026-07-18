import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { SOSButton } from "@/components/SOSButton";
import { CategoryPicker } from "@/components/CategoryPicker";
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
  type Vendor,
  emojiForVendorCategory,
  useCategoryLabel,
} from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone, hasBeenWelcomed, markWelcomed } from "@/lib/userIdentity";
import { registerUserPushToken } from "@/lib/pushNotifications";
import { buildRequestsActiveWindowOrFilter } from "@/lib/orders";
import { useLanguage } from "@/lib/language";
import { useAppConfig } from "@/hooks/useAppConfig";
import { SettingsPageHeader, SettingsSectionLabel } from "@/components/settings/SettingsSection";
import { NotificationBell } from "@/components/NotificationBell";
import { FirstOpenFlow } from "@/components/FirstOpenFlow";
import { cn } from "@/lib/utils";

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
  reason: "category_removed" | "account_deleted";
};

const HELP_ORDER_WINDOW_MS = 48 * 60 * 60 * 1000;

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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pushRegisteredUserRef = useRef<string | null>(null);
  const [userPhone, setUserPhone] = useState(() => getUserPhone());
  const [helpOrderBanner, setHelpOrderBanner] = useState<HelpOrderBanner | null>(null);
  const [helpBannerTick, setHelpBannerTick] = useState(0);
  const [removalNotices, setRemovalNotices] = useState<SavedVendorRemovalNotice[]>([]);
  const [welcomed, setWelcomed] = useState(() => hasBeenWelcomed());

  const loadSavedNeighbours = useCallback(async () => {
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    const { data: saved, error } = await supabase.rpc("get_saved_vendors", {
      p_user_phone: userPhone,
      p_device_id: device_id,
    });
    if (error || !saved?.length) {
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
    if (vErr || !vendors?.length) {
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
      const cats = await fetchCategories();
      setCategories(cats);
      const modeLabels = {
        help: s.category_mode_help,
        delivery: s.category_mode_delivery,
        appointment: s.category_mode_appointment,
      };
      setCategoryGroups(groupCategoriesByMode(cats, modeLabels));
      setCategoriesLoading(false);
    };
    void run();
  }, [s.category_mode_help, s.category_mode_delivery, s.category_mode_appointment]);

  const loadHelpOrderBanner = useCallback(async () => {
    const phone = getUserPhone();
    if (!phone) {
      setHelpOrderBanner(null);
      return;
    }
    const since48h = new Date(Date.now() - HELP_ORDER_WINDOW_MS).toISOString();
    const { data, error } = await supabase
      .from("requests")
      .select("id, status, updated_at, vendors(shop_name, service_mode, last_updated)")
      .eq("user_phone", phone)
      .eq("status", "accepted")
      .gt("updated_at", since48h)
      .order("updated_at", { ascending: false });
    if (error) {
      setHelpOrderBanner(null);
      return;
    }
    type HelpRow = {
      id: string;
      status: string;
      updated_at: string;
      vendors: { shop_name: string; service_mode: string | null; last_updated: string | null } | null;
    };
    const match = ((data ?? []) as unknown as HelpRow[]).find(
      (row) => String(row.vendors?.service_mode ?? "").trim().toLowerCase() === "help",
    );
    if (!match) {
      setHelpOrderBanner(null);
      return;
    }
    setHelpOrderBanner({
      orderId: match.id,
      shopName: match.vendors?.shop_name?.trim() || s.myOrders_shopFallback,
      vendorLastUpdated: match.vendors?.last_updated ?? null,
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
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    const windowOr = buildRequestsActiveWindowOrFilter("user");
    let countQuery = supabase
      .from("requests")
      .select("id", { count: "exact", head: true })
      .or(windowOr);
    countQuery =
      userPhone != null ? countQuery.eq("user_phone", userPhone) : countQuery.eq("device_id", device_id);
    const { count, error } = await countQuery;
    if (error) {
      setActiveOrderCount(0);
      return;
    }
    setActiveOrderCount(count ?? 0);
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
      const device_id = getDeviceId();
      const { data } = await supabase
        .from("requests")
        .select("id")
        .eq("device_id", device_id)
        .eq("vendor_id", neighbourSheetVendor.id)
        .in("status", ["sent", "seen"])
        .limit(1);
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
      const device_id = getDeviceId();
      const { data } = await supabase
        .from("requests")
        .select("id")
        .eq("device_id", device_id)
        .eq("vendor_id", neighbourSheetVendor.id)
        .in("status", ["sent", "seen"])
        .limit(1);
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

  /** AI classifier for typed / voice free text only (not Quick Assist / picker). */
  const runFreeTextSearch = async (raw: string) => {
    const term = raw.trim();
    if (!term) return;
    setClassifying(true);
    try {
      const r = await classifySearchTermForRadar(term, categories);
      if (r.outcome === "hint") {
        toast.info(r.message);
        return;
      }
      if (r.outcome === "fallback") {
        toast.info(s.search_fallback, { duration: 3000 });
        document.getElementById("category-grid")?.scrollIntoView({ behavior: "smooth" });
        return;
      }
      goToRadar(r.query);
    } finally {
      setClassifying(false);
    }
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
      goToRadar("");
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
        toast.error("Voice not available on this device");
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
              aria-label="Voice search"
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

      {savedNeighbours.length > 0 && (
        <section className="animate-fade-up">
          <SettingsSectionLabel>{s.myNeighbourhood}</SettingsSectionLabel>
          <div className="flex gap-3 overflow-x-auto pb-1 px-4 scrollbar-hide">
            {savedNeighbours.map(({ savedId, vendor, nickname, category }) => (
              <button
                key={savedId}
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
                        aria-label="Online"
                      />
                    )}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">{category}</p>
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
        ) : (
          <div className="space-y-3">
            {categoryGroups.map((group) => (
              <div key={group.service_mode}>
                <SettingsSectionLabel>{group.label}</SettingsSectionLabel>
                <div className="flex gap-3 overflow-x-auto pb-1 px-4 scrollbar-hide">
                  {group.categories.map((cat) => (
                    <button
                      key={cat.id}
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
