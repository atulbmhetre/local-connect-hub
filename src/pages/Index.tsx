import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { SOSButton } from "@/components/SOSButton";
import { CategoryPicker } from "@/components/CategoryPicker";
import { ParchiSheet } from "@/components/ParchiSheet";
import { AiBridgeSheet } from "@/components/AiBridgeSheet";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Loader2, Mic, Phone, Search } from "lucide-react";
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
import { getUserPhone } from "@/lib/userIdentity";
import { registerUserPushToken } from "@/lib/pushNotifications";
import { buildRequestsActiveWindowOrFilter } from "@/lib/orders";
import { useLanguage } from "@/lib/language";

type SavedNeighbourTile = {
  savedId: string;
  vendor: Vendor;
  nickname: string;
  category: string;
};

const Index = () => {
  const { s, lang } = useLanguage();
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

  const loadSavedNeighbours = useCallback(async () => {
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    let savedQuery = supabase
      .from("saved_vendors")
      .select("id, vendor_id, nickname, category, saved_at")
      .order("saved_at", { ascending: false });
    savedQuery =
      userPhone != null ? savedQuery.eq("user_phone", userPhone) : savedQuery.eq("device_id", device_id);
    const { data: saved, error } = await savedQuery;
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
      .in("id", vendorIds);
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
    void loadSavedNeighbours();
  }, [location.pathname, location.key, loadSavedNeighbours]);

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
  }, [location.pathname, location.key, loadActiveOrderCount]);

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
  const goToRadar = (term: string) => {
    const t = term.trim();
    navigate(t ? `/radar?q=${encodeURIComponent(t)}` : "/radar");
  };

  /** AI classifier for typed / voice free text only (not Quick Assist / picker). */
  const runFreeTextSearch = async (raw: string) => {
    const term = raw.trim();
    if (!term) return;
    setClassifying(true);
    try {
      const r = await classifySearchTermForRadar(term);
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

  const startVoice = async () => {
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) {
        toast.error("Voice not available on this device");
        return;
      }
      await (
        SpeechRecognition as unknown as {
          requestPermission: () => Promise<{ speechRecognition: string }>;
        }
      ).requestPermission();
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
    } catch {
      // user cancelled or denied — silent
    } finally {
      setListening(false);
    }
  };

  return (
    <AppShell theme="light">
      <header className="text-center mb-6 animate-fade-up">
        <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">{s.appName}</p>
        <h1 className="font-display text-3xl font-bold mt-1">{s.tagline}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {s.taglineSub}
        </p>
      </header>

      <div className="mb-8">
        <form onSubmit={handleSubmit} className="relative">
          <div className="absolute -top-2.5 left-4 z-10 px-2 bg-background">
            <span className="text-[10px] uppercase tracking-[0.2em] font-semibold text-primary inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
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
            className="w-full bg-card border border-border rounded-2xl pl-12 pr-12 py-4 text-base shadow-card focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-70"
          />
          {Capacitor.isNativePlatform() && (
            <button
              type="button"
              onClick={() => void startVoice()}
              disabled={classifying}
              aria-label="Voice search"
              className={`absolute right-2 top-1/2 -translate-y-1/2 h-10 w-10 rounded-xl grid place-items-center transition-colors disabled:opacity-50 ${
                listening ? "bg-primary text-primary-foreground animate-pulse" : "bg-muted text-foreground"
              }`}
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

      <div className="flex justify-center mb-8">
        <SOSButton onClick={handleSOS} />
      </div>

      {savedNeighbours.length > 0 && (
        <section className="mb-8 animate-fade-up">
          <p className="text-xs uppercase tracking-[0.25em] text-green-700 dark:text-brand text-center mb-3 font-semibold">
            {s.myNeighbourhood}
          </p>
          <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-hide">
            {savedNeighbours.map(({ savedId, vendor, nickname, category }) => (
              <button
                key={savedId}
                type="button"
                onClick={() => {
                  setNeighbourSheetVendor(vendor);
                  setNeighbourSheetOpen(true);
                }}
                className="flex-shrink-0 w-40 rounded-2xl bg-card border border-border shadow-card text-left p-3 flex gap-3 active:scale-[0.98] transition-transform hover:bg-muted/50"
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
                  {vendor.is_active && (
                    <span
                      className="absolute bottom-1 right-1 h-2 w-2 rounded-full bg-brand ring-2 ring-card"
                      aria-label="Online"
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1 py-0.5">
                  <p className="font-semibold text-sm truncate">{nickname}</p>
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

      <Sheet
        open={neighbourSheetOpen}
        onOpenChange={(open) => {
          setNeighbourSheetOpen(open);
          if (!open) setNeighbourSheetVendor(null);
        }}
      >
        <SheetContent
          side="bottom"
          className="bg-card border-t border-border rounded-t-2xl max-h-[85vh] overflow-y-auto"
        >
          {neighbourSheetVendor && (
            <>
              <SheetHeader className="text-left space-y-3 pr-8">
                <div className="flex items-start gap-3">
                  <div className="relative shrink-0">
                    <span
                      className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card ${
                        neighbourSheetVendor.is_active ? "bg-brand" : "bg-muted-foreground/50"
                      }`}
                      aria-hidden
                    />
                    <div className="h-12 w-12 rounded-xl overflow-hidden bg-muted grid place-items-center">
                      {neighbourSheetVendor.shop_photo_url ? (
                        <img
                          src={neighbourSheetVendor.shop_photo_url}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="text-2xl" aria-hidden>
                          {emojiForVendorCategory(neighbourSheetVendor.category, categories)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <SheetTitle className="text-left font-display text-lg">
                      {neighbourSheetVendor.shop_name}
                    </SheetTitle>
                    <p className="text-sm text-muted-foreground">{neighbourSheetVendor.category}</p>
                    <p className="text-xs text-muted-foreground">
                      {neighbourSheetVendor.is_active ? (
                        <span className="text-brand font-medium">{s.online}</span>
                      ) : (
                        <span>{s.offline}</span>
                      )}
                    </p>
                  </div>
                </div>
                <SheetDescription className="sr-only">
                  Choose how to contact this saved vendor
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 flex flex-col gap-2">
                {String(neighbourSheetVendor.service_mode ?? "")
                  .trim()
                  .toLowerCase() === "delivery" ? (
                  neighbourDeliveryActiveOrder ? (
                    <>
                      <button
                        type="button"
                        className="w-full text-left text-sm text-muted-foreground underline underline-offset-2 py-1"
                        onClick={() => {
                          setNeighbourSheetOpen(false);
                          navigate("/my-orders");
                        }}
                      >
                        {s.yourActiveOrders}
                      </button>
                      <button
                        type="button"
                        className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
                        onClick={() => {
                          const v = neighbourSheetVendor;
                          setNeighbourSheetOpen(false);
                          setParchiVendor(v);
                          setParchiOpen(true);
                        }}
                      >
                        {s.sendNewOrder}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
                      onClick={() => {
                        const v = neighbourSheetVendor;
                        setNeighbourSheetOpen(false);
                        setParchiVendor(v);
                        setParchiOpen(true);
                      }}
                    >
                      {s.sendOrder}
                    </button>
                  )
                ) : String(neighbourSheetVendor.service_mode ?? "")
                    .trim()
                    .toLowerCase() === "appointment" ? (
                  <>
                    {appointmentActiveFromDb ? (
                      <>
                        <button
                          type="button"
                          className="w-full text-left text-sm text-muted-foreground underline underline-offset-2 py-1"
                          onClick={() => {
                            setNeighbourSheetOpen(false);
                            navigate("/my-orders");
                          }}
                        >
                          {s.yourActiveBookings}
                        </button>
                        <button
                          type="button"
                          className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
                          onClick={() => {
                            const v = neighbourSheetVendor;
                            setNeighbourSheetOpen(false);
                            setParchiVendor(v);
                            setParchiOpen(true);
                          }}
                        >
                          {s.bookAgain}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
                        onClick={() => {
                          const v = neighbourSheetVendor;
                          setNeighbourSheetOpen(false);
                          setParchiVendor(v);
                          setParchiOpen(true);
                        }}
                      >
                        {s.bookService}
                      </button>
                    )}
                    <button
                      type="button"
                      className="w-full rounded-xl border border-border py-3 text-sm font-semibold text-muted-foreground"
                      onClick={() => setNeighbourSheetOpen(false)}
                    >
                      {s.cancel}
                    </button>
                    <button
                      type="button"
                      className="w-full py-2 text-xs font-medium text-destructive hover:underline"
                      onClick={async () => {
                        const v = neighbourSheetVendor;
                        if (!v) return;
                        const device_id = getDeviceId();
                        const userPhone = getUserPhone();
                        let del = supabase.from("saved_vendors").delete().eq("vendor_id", v.id);
                        del =
                          userPhone != null
                            ? del.eq("user_phone", userPhone)
                            : del.eq("device_id", device_id);
                        const { error } = await del;
                        if (error) {
                          toast.error(s.couldNotRemove, { description: error.message });
                          return;
                        }
                        try {
                          sessionStorage.removeItem(`aaspaas:saved:${v.id}`);
                        } catch {
                          /* ignore */
                        }
                        setNeighbourSheetOpen(false);
                        setNeighbourSheetVendor(null);
                        void loadSavedNeighbours();
                        toast.success(s.removedFromNeighbourhood);
                      }}
                    >
                      {s.removeFromNeighbourhood}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold flex items-center justify-center gap-2 active:scale-[0.98]"
                    onClick={() => {
                      const v = neighbourSheetVendor;
                      setNeighbourSheetOpen(false);
                      void openAiBridgeFromNeighbour(v);
                    }}
                  >
                    <Phone className="h-4 w-4" />
                    {s.connectAiBridge}
                  </button>
                )}
                {String(neighbourSheetVendor.service_mode ?? "")
                  .trim()
                  .toLowerCase() !== "appointment" && (
                <>
                <button
                  type="button"
                  className="w-full rounded-xl border border-border py-3 text-sm font-semibold text-muted-foreground"
                  onClick={() => setNeighbourSheetOpen(false)}
                >
                  {s.cancel}
                </button>
                <button
                  type="button"
                  className="w-full py-2 text-xs font-medium text-destructive hover:underline"
                  onClick={async () => {
                    const v = neighbourSheetVendor;
                    if (!v) return;
                    const device_id = getDeviceId();
                    const userPhone = getUserPhone();
                    let del = supabase.from("saved_vendors").delete().eq("vendor_id", v.id);
                    del =
                      userPhone != null ? del.eq("user_phone", userPhone) : del.eq("device_id", device_id);
                    const { error } = await del;
                    if (error) {
                      toast.error(s.couldNotRemove, { description: error.message });
                      return;
                    }
                    try {
                      sessionStorage.removeItem(`aaspaas:saved:${v.id}`);
                    } catch {
                      /* ignore */
                    }
                    setNeighbourSheetOpen(false);
                    setNeighbourSheetVendor(null);
                    void loadSavedNeighbours();
                    toast.success(s.removedFromNeighbourhood);
                  }}
                >
                  {s.removeFromNeighbourhood}
                </button>
                </>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

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
        isOpen={parchiOpen}
        onClose={() => {
          setParchiOpen(false);
          void loadActiveOrderCount();
          void loadSavedNeighbours();
        }}
      />

      <section id="category-grid" className="mb-4 animate-fade-up">
        {categoriesLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            {categoryGroups.map((group) => (
              <div key={group.service_mode}>
                <p className="text-xs uppercase tracking-[0.25em] text-muted-foreground mb-2 font-semibold">
                  {group.label}
                </p>
                <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-hide">
                  {group.categories.map((cat) => (
                    <button
                      key={cat.id}
                      onClick={() => goToRadar(cat.label)}
                      className="flex-shrink-0 w-20 rounded-2xl bg-card hover:bg-muted active:scale-95 transition-all flex flex-col items-center justify-center gap-1.5 border border-border shadow-card py-3 px-2"
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
        onPick={(cat) => {
          setPickerOpen(false);
          goToRadar(cat);
        }}
        onMic={startVoice}
        categories={categories}
      />
    </AppShell>
  );
};

export default Index;
