import { useCallback, useEffect, useState } from "react";
import {
  MapPin,
  Phone,
  Store,
  Clock,
  HeartHandshake,
  Package,
} from "lucide-react";
import { supabase, type Vendor, type Category, useCategoryLabel } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone, migrateUserPhone } from "@/lib/userIdentity";
import { PhoneEntrySheet } from "@/components/PhoneEntrySheet";
import { ParchiSheet } from "@/components/ParchiSheet";
import { AiBridgeSheet } from "@/components/AiBridgeSheet";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { VerificationBadge, vendorTier, verificationCopy } from "@/components/VerificationBadge";
import { TrustWarningBanner } from "@/components/TrustWarningBanner";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";

const RESOLUTION_SESSION_PREFIX = "aaspaas:resolution:";
const VENDOR_SELF_STORAGE_KEY = "aaspaas:vendor_id";

function readResolutionMarked(vendorId: string): boolean {
  try {
    return sessionStorage.getItem(`${RESOLUTION_SESSION_PREFIX}${vendorId}`) === "1";
  } catch {
    return false;
  }
}

function writeResolutionMarked(vendorId: string) {
  try {
    sessionStorage.setItem(`${RESOLUTION_SESSION_PREFIX}${vendorId}`, "1");
  } catch {
    /* ignore quota / private mode */
  }
}

const CALLED_SESSION_PREFIX = "aaspaas:called:";
const PARCHI_SESSION_PREFIX = "aaspaas:parchi:";

function readCalledVendor(vendorId: string): boolean {
  try {
    return sessionStorage.getItem(`${CALLED_SESSION_PREFIX}${vendorId}`) === "1";
  } catch {
    return false;
  }
}

function writeCalledVendor(vendorId: string) {
  try {
    sessionStorage.setItem(`${CALLED_SESSION_PREFIX}${vendorId}`, "1");
  } catch {
    /* ignore */
  }
}

const SAVED_SESSION_PREFIX = "aaspaas:saved:";
const NEIGHBOURS_DIRTY_KEY = "aaspaas:neighbours_dirty";
const MAX_SAVED_NEIGHBOURS = 20;

export function markNeighboursDirty(): void {
  try {
    localStorage.setItem(NEIGHBOURS_DIRTY_KEY, "true");
  } catch {
    /* ignore */
  }
}

export function readSessionSaved(vendorId: string): boolean {
  try {
    return sessionStorage.getItem(`${SAVED_SESSION_PREFIX}${vendorId}`) === "1";
  } catch {
    return false;
  }
}

function writeSessionSaved(vendorId: string) {
  try {
    sessionStorage.setItem(`${SAVED_SESSION_PREFIX}${vendorId}`, "1");
  } catch {
    /* ignore */
  }
}

function clearSessionSaved(vendorId: string) {
  try {
    sessionStorage.removeItem(`${SAVED_SESSION_PREFIX}${vendorId}`);
  } catch {
    /* ignore */
  }
}

async function countSavedNeighbours(): Promise<number> {
  const device_id = getDeviceId();
  const userPhone = getUserPhone();
  let q = supabase.from("saved_vendors").select("id", { count: "exact", head: true });
  if (userPhone != null) {
    q = q.or(`user_phone.eq.${userPhone},device_id.eq.${device_id}`);
  } else {
    q = q.eq("device_id", device_id);
  }
  const { count, error } = await q;
  if (error) return 0;
  return count ?? 0;
}

function readIsOwnVendorCard(vendorId: string, vendorPhone: string | null | undefined): boolean {
  try {
    const mine = localStorage.getItem(VENDOR_SELF_STORAGE_KEY);
    if (mine == null || mine !== vendorId) return false;
    const userPhone = localStorage.getItem("aaspaas:user_phone");
    if (!userPhone?.trim() || !vendorPhone?.trim()) return false;
    const digits = (p: string) => {
      const cleaned = p.replace(/\D/g, "");
      return cleaned.length === 12 && cleaned.startsWith("91") ? cleaned.slice(2) : cleaned;
    };
    return digits(userPhone) === digits(vendorPhone);
  } catch {
    return false;
  }
}

/** Subtle reputation line: below trust badge area, above Connect CTA. */
const VendorReputationLine = ({
  vendor,
  totalHelpedOverride,
  totalDeliveredOverride,
}: {
  vendor: Vendor;
  totalHelpedOverride?: number;
  totalDeliveredOverride?: number;
}) => {
  const { s } = useLanguage();
  const mode = String(vendor.service_mode ?? "")
    .trim()
    .toLowerCase();

  if (mode === "help") {
    const n = totalHelpedOverride ?? vendor.total_helped ?? 0;
    if (n <= 0) return null;
    return (
      <div className="mt-3 flex items-center gap-1.5 text-[11px] leading-snug text-muted-foreground/90">
        <span className="inline-flex items-center gap-1 shrink-0">
          <HeartHandshake className="h-3.5 w-3.5 opacity-80" />
          <span className="font-semibold">Helped</span>
        </span>
        <span>
          {s.radar_helped}
          <span className="font-semibold tabular-nums text-brand">{n}</span>{" "}
          {n === 1 ? s.radar_person : s.radar_people}
        </span>
      </div>
    );
  }

  if (mode === "delivery") {
    const d = totalDeliveredOverride ?? vendor.total_delivered ?? 0;
    if (d <= 0) return null;
    const raw = vendor.on_time_rate;
    const pct = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : null;
    return (
      <div className="mt-3 flex items-center gap-1.5 text-[11px] leading-snug text-muted-foreground/90">
        <span className="inline-flex items-center gap-1 shrink-0">
          <Package className="h-3.5 w-3.5 opacity-80" />
          <span className="font-semibold">Delivered</span>
        </span>
        <span>
          <span className="font-semibold tabular-nums text-brand">{d}</span>
          {s.radar_orders_served}
          {pct !== null && d > 0 && (
            <>
              {" "}
              · <span className="font-semibold tabular-nums text-brand">{pct}</span>
              {s.radar_on_time}
            </>
          )}
        </span>
      </div>
    );
  }

  return null;
};

type Props = {
  vendor: Vendor;
  onOrder: (vendor: Vendor) => void;
  onAiBridge: (vendor: Vendor) => void;
  onSave: (vendor: Vendor) => void;
  isSaved: boolean;
  hasOrdered: boolean;
  categories: Category[];
  dist: number | null;
  index: number;
  userNeed: string;
};

export function RadarVendorCard({
  vendor,
  onOrder,
  onAiBridge,
  onSave,
  isSaved,
  hasOrdered,
  categories: _categories,
  dist,
  index,
  userNeed,
}: Props) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const tier = vendorTier(vendor);
  const serviceMode = String(vendor.service_mode ?? "")
    .trim()
    .toLowerCase();
  const isOwnVendor = readIsOwnVendorCard(vendor.id, vendor.phone);

  const [helpCount, setHelpCount] = useState(() => vendor.total_helped ?? 0);
  const [deliveredCount, setDeliveredCount] = useState(() => vendor.total_delivered ?? 0);
  const [resolutionMarked, setResolutionMarked] = useState(() => readResolutionMarked(vendor.id));
  const [resolutionBusy, setResolutionBusy] = useState(false);

  const [aiSheetOpen, setAiSheetOpen] = useState(false);

  const [parchiOpen, setParchiOpen] = useState(false);
  const [savedVendorLocked, setSavedVendorLocked] = useState(() =>
    isSaved || readSessionSaved(vendor.id),
  );
  const [resolutionSessionTick, setResolutionSessionTick] = useState(0);
  const [deliveryActiveFromDb, setDeliveryActiveFromDb] = useState(false);
  const [deliveryFulfilledFromDb, setDeliveryFulfilledFromDb] = useState(false);
  const [phoneSheetOpen, setPhoneSheetOpen] = useState(false);
  const [menuItems, setMenuItems] = useState<
    { name: string; price: number; unit: string | null; is_available: boolean }[]
  >([]);
  const [rateCardOpen, setRateCardOpen] = useState(false);
  const [rateCardLoading, setRateCardLoading] = useState(false);
  const [rateCardItems, setRateCardItems] = useState<
    { name: string; price: number; unit: string | null }[]
  >([]);

  useEffect(() => {
    void supabase
      .from("vendor_menu_items")
      .select("name, price, unit, is_available")
      .eq("vendor_id", vendor.id)
      .eq("is_available", true)
      .order("sort_order", { ascending: true })
      .limit(5)
      .then(({ data }) => setMenuItems(data ?? []));
  }, [vendor.id]);

  const openRateCard = useCallback(async () => {
    setRateCardOpen(true);
    if (rateCardItems.length > 0 || rateCardLoading) return;
    setRateCardLoading(true);
    const { data } = await supabase
      .from("vendor_menu_items")
      .select("name, price, unit")
      .eq("vendor_id", vendor.id)
      .eq("is_available", true)
      .order("sort_order", { ascending: true });
    setRateCardItems(data ?? []);
    setRateCardLoading(false);
  }, [rateCardItems.length, rateCardLoading, vendor.id]);

  useEffect(() => {
    setHelpCount(vendor.total_helped ?? 0);
    setDeliveredCount(vendor.total_delivered ?? 0);
    setResolutionMarked(readResolutionMarked(vendor.id));
    setSavedVendorLocked(isSaved || readSessionSaved(vendor.id));
  }, [vendor.id, vendor.total_delivered, vendor.total_helped, isSaved]);

  useEffect(() => {
    if ((serviceMode !== "delivery" && serviceMode !== "appointment") || isOwnVendor) {
      setDeliveryActiveFromDb(false);
      return;
    }
    let cancelled = false;
    const run = async () => {
      const device_id = getDeviceId();
      const { data } = await supabase
        .from("requests")
        .select("id")
        .eq("device_id", device_id)
        .eq("vendor_id", vendor.id)
        .in("status", ["sent", "seen"])
        .limit(1);
      if (!cancelled) setDeliveryActiveFromDb(!!data?.length);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [vendor.id, serviceMode, isOwnVendor, resolutionSessionTick]);

  useEffect(() => {
    if (serviceMode !== "delivery" || isOwnVendor) {
      setDeliveryFulfilledFromDb(false);
      return;
    }
    let cancelled = false;
    const run = async () => {
      const device_id = getDeviceId();
      const { data } = await supabase
        .from("requests")
        .select("id")
        .eq("device_id", device_id)
        .eq("vendor_id", vendor.id)
        .eq("status", "fulfilled")
        .limit(1);
      if (!cancelled) setDeliveryFulfilledFromDb(!!data?.length);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [vendor.id, serviceMode, isOwnVendor, resolutionSessionTick]);

  useEffect(() => {
    if (isOwnVendor) return;
    if (isSaved || readSessionSaved(vendor.id)) {
      setSavedVendorLocked(true);
      return;
    }
    let cancelled = false;
    const run = async () => {
      const deviceId = getDeviceId();
      const userPhone = getUserPhone();
      console.log("[RadarVendorCard] saved_vendors check", {
        deviceId,
        userPhone,
        vendorId: vendor.id,
      });
      let savedQuery = supabase
        .from("saved_vendors")
        .select("id")
        .eq("vendor_id", vendor.id)
        .limit(1);
      savedQuery =
        userPhone != null ? savedQuery.eq("user_phone", userPhone) : savedQuery.eq("device_id", deviceId);
      const { data } = await savedQuery;
      if (cancelled || !data?.length) return;
      writeSessionSaved(vendor.id);
      setSavedVendorLocked(true);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [vendor.id, isOwnVendor, isSaved]);

  const showResolution =
    !isOwnVendor &&
    ((serviceMode === "help" && readCalledVendor(vendor.id)) ||
      (serviceMode === "delivery" && deliveryFulfilledFromDb));

  const showSendOrderSection = !isOwnVendor && (serviceMode === "delivery" || serviceMode === "appointment");

  const deliveryOrderSent = hasOrdered || deliveryActiveFromDb;

  const showConnectAiBridge =
    serviceMode === "help" || deliveryOrderSent;

  const isNeighbourSaved = !isOwnVendor && (isSaved || savedVendorLocked);
  const showSaveRow = !isOwnVendor && !isNeighbourSaved;
  const showUnsaveRow = isNeighbourSaved;

  const accentRing =
    tier === "green"
      ? "ring-brand/50 shadow-[0_0_24px_rgba(34,197,94,0.25)]"
      : tier === "yellow"
        ? "ring-warning/40"
        : "ring-destructive/30";

  const handleConnect = useCallback(() => {
    onAiBridge(vendor);
    setAiSheetOpen(true);
  }, [onAiBridge, vendor]);

  const handleSaveVendor = useCallback(async () => {
    if (savedVendorLocked || isSaved) return;
    const userPhone = getUserPhone();
    if (userPhone === null) {
      setPhoneSheetOpen(true);
      return;
    }
    const existing = await countSavedNeighbours();
    if (existing >= MAX_SAVED_NEIGHBOURS) {
      toast.error(s.neighbours_max_reached);
      return;
    }
    const device_id = getDeviceId();
    const { error } = await supabase.from("saved_vendors").insert({
      device_id,
      vendor_id: vendor.id,
      category: vendor.category,
      nickname: vendor.shop_name,
      user_phone: userPhone,
    });
    if (error) {
      if (error.code === "23505") {
        writeSessionSaved(vendor.id);
        setSavedVendorLocked(true);
        onSave(vendor);
        markNeighboursDirty();
        toast.success(`✅ ${s.radar_saved_success}`);
        return;
      }
      toast.error(s.radar_could_not_save, { description: error.message });
      return;
    }
    writeSessionSaved(vendor.id);
    setSavedVendorLocked(true);
    onSave(vendor);
    markNeighboursDirty();
    toast.success(`✅ ${s.radar_saved_success}`);
  }, [isSaved, onSave, savedVendorLocked, vendor, s]);

  const handleUnsaveVendor = useCallback(async () => {
    if (!savedVendorLocked && !isSaved) return;
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    let del = supabase.from("saved_vendors").delete().eq("vendor_id", vendor.id);
    del = userPhone != null ? del.eq("user_phone", userPhone) : del.eq("device_id", device_id);
    const { error } = await del;
    if (error) {
      toast.error(s.couldNotRemove, { description: error.message });
      return;
    }
    clearSessionSaved(vendor.id);
    setSavedVendorLocked(false);
    markNeighboursDirty();
    toast.success(s.neighbours_removed);
  }, [isSaved, savedVendorLocked, vendor.id, s]);

  const handleResolution = useCallback(async () => {
    if (resolutionMarked || resolutionBusy) return;
    const kind = serviceMode === "delivery" ? "delivery" : "help";
    const rpc = kind === "help" ? "increment_vendor_helped" : "increment_vendor_delivered";
    setResolutionBusy(true);
    const { error } = await supabase.rpc(rpc, { p_vendor_id: vendor.id });
    setResolutionBusy(false);
    if (error) {
      toast.error(s.radar_could_not_save, { description: error.message });
      return;
    }
    writeResolutionMarked(vendor.id);
    setResolutionMarked(true);
    if (kind === "help") setHelpCount((c) => c + 1);
    else setDeliveredCount((c) => c + 1);
    toast.success(s.radar_thank_community);
  }, [resolutionMarked, resolutionBusy, serviceMode, vendor.id, s]);

  const openParchi = useCallback(() => {
    onOrder(vendor);
    setParchiOpen(true);
  }, [onOrder, vendor]);

  const serviceModePill =
    serviceMode === "delivery"
      ? "🚚 Delivery"
      : serviceMode === "appointment"
        ? "📅 Booking"
        : "🚶 Help";

  return (
    <div
      className={cn(
        "mx-4 mb-3 rounded-2xl border border-surface-border bg-surface p-4 animate-fade-up",
        accentRing,
      )}
      style={{ animationDelay: `${Math.min(index * 70, 420)}ms` }}
    >
      <div className="flex items-start gap-3">
        <div className="h-12 w-12 rounded-xl bg-gradient-vendor grid place-items-center shrink-0 overflow-hidden">
          {vendor.shop_photo_url ? (
            <img
              src={vendor.shop_photo_url}
              alt={`${vendor.shop_name} shop`}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <Store className="h-6 w-6 text-primary-foreground" aria-hidden />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-1.5 min-w-0">
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold text-foreground break-words leading-snug">
                {vendor.shop_name}
              </h3>
              {readIsOwnVendorCard(vendor.id, vendor.phone) && (
                <span className="text-[10px] font-medium text-muted-foreground">• You</span>
              )}
            </div>
            <span className="inline-flex items-center gap-1 shrink-0">
              <VerificationBadge vendor={vendor} />
              <span className="text-[10px] font-medium text-muted-foreground whitespace-nowrap">
                {verificationCopy[tier].label}
              </span>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            <span className="text-xs rounded-full px-2 py-0.5 border border-surface-border text-muted-foreground bg-surface">
              {getLabel(vendor.category)}
            </span>
            <span className="text-xs rounded-full px-2 py-0.5 bg-brand/20 text-brand font-medium">
              {serviceModePill}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            {dist != null ? (
              <span className="text-xs bg-surface-border rounded-full px-2 py-0.5 inline-flex items-center gap-1 text-muted-foreground">
                <MapPin className="h-3 w-3" />
                {dist < 1 ? `${Math.round(dist * 1000)} mtr away` : `${dist.toFixed(1)} km away`}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">{s.radar_location_unknown}</span>
            )}
            {vendor.avg_rating && vendor.review_count ? (
              <span className="text-xs">
                <span className="text-brand font-bold">⭐ {vendor.avg_rating.toFixed(1)}</span>
                <span className="text-muted-foreground">
                  {" "}
                  ({vendor.review_count} {s.review_reviews})
                </span>
              </span>
            ) : null}
          </div>
          {serviceMode === "help" && dist != null && (
            <div className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-brand-muted ring-1 ring-brand/30 px-2 py-0.5 text-[11px] font-semibold text-green-700 dark:text-brand">
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                <span>ETA</span>
              </span>
              {s.radar_est_arrival}
              {Math.max(1, Math.round(dist * 2))}
              {s.radar_min}
            </div>
          )}
        </div>
      </div>

      <TrustWarningBanner tier={tier} context="radar" />

      <VendorReputationLine
        vendor={vendor}
        totalHelpedOverride={helpCount}
        totalDeliveredOverride={deliveredCount}
      />

      {menuItems.length > 0 && (
        <div className="mt-3 pt-3 border-t border-surface-border space-y-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {s.menu_preview}
          </p>
          {menuItems.slice(0, 3).map((item, i) => (
            <div key={i} className="flex justify-between items-center gap-2">
              <span className="text-foreground text-sm flex-1 truncate">{item.name}</span>
              <span className="text-sm shrink-0 text-muted-foreground">
                ₹{item.price}
                {item.unit ? `/${item.unit}` : ""}
              </span>
            </div>
          ))}
          {(serviceMode === "appointment" || serviceMode === "delivery") && menuItems.length > 3 && (
            <button
              type="button"
              onClick={() => void openRateCard()}
              className="text-[11px] text-muted-foreground hover:text-foreground text-left pt-1"
            >
              {serviceMode === "delivery" ? "View full menu →" : "View full rate card →"}
            </button>
          )}
          {menuItems.length > 3 && (
            <p className="text-[10px] text-muted-foreground">
              +{menuItems.length - 3} {s.menu_moreItems}
            </p>
          )}
        </div>
      )}

      <Sheet open={rateCardOpen} onOpenChange={setRateCardOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl max-h-[80vh] overflow-y-auto">
          <SheetHeader className="text-left">
            <SheetTitle>
              {serviceMode === "delivery"
                ? `Menu — ${vendor.shop_name}`
                : `Rate Card — ${vendor.shop_name}`}
            </SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {rateCardLoading ? (
              <p className="text-sm text-muted-foreground">{s.settings_loading}</p>
            ) : (
              <div className="rounded-xl border border-border overflow-hidden">
                {rateCardItems.map((item, idx) => (
                  <div
                    key={`${item.name}-${idx}`}
                    className={cn(
                      "flex items-center justify-between px-3 py-2 text-sm",
                      idx !== 0 && "border-t border-border",
                    )}
                  >
                    <span className="text-foreground">{item.name}</span>
                    <span className="text-brand font-semibold tabular-nums">
                      ₹{item.price}
                      {item.unit ? `/${item.unit}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {vendor.vendor_note && (
            <div className="mt-4 text-xs text-muted-foreground">
              <span className="font-semibold">About</span>
              <span className="text-muted-foreground"> · </span>
              <span>{vendor.vendor_note}</span>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setRateCardOpen(false);
              openParchi();
            }}
            className="mt-5 w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98] transition-transform"
          >
            Connect
          </button>
        </SheetContent>
      </Sheet>

      {showConnectAiBridge && (
        <button
          type="button"
          onClick={handleConnect}
          className="mt-3 w-full rounded-xl bg-brand text-white py-2.5 flex items-center justify-center gap-2 font-semibold active:scale-[0.98] transition-transform"
        >
          <Phone className="h-4 w-4" />
          {s.radar_connect_ai}
        </button>
      )}

      <AiBridgeSheet
        open={aiSheetOpen}
        onClose={() => setAiSheetOpen(false)}
        vendor={vendor}
        callerPhone={getUserPhone() ?? ""}
        userNeed={userNeed}
        distanceKm={dist}
        onCallSuccess={(vendorId) => {
          writeCalledVendor(vendorId);
          setResolutionSessionTick((n) => n + 1);
        }}
      />

      {showSendOrderSection &&
        (deliveryOrderSent ? (
          <div
            className={cn(
              "mt-2 w-full rounded-xl border px-3 py-2.5 text-sm",
              "border-brand/50 bg-brand/5 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1",
            )}
          >
            <span className="text-muted-foreground font-medium">
              {serviceMode === "appointment"
                ? `📅 ${s.radar_booking_requested}`
                : `✅ ${s.radar_order_sent}`}
            </span>
            <span className="text-muted-foreground" aria-hidden>
              ·
            </span>
            <button
              type="button"
              onClick={openParchi}
              className="font-semibold text-green-700 dark:text-brand underline underline-offset-2 hover:opacity-90"
            >
              {serviceMode === "appointment" ? s.radar_book_again : s.radar_send_new_order}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={openParchi}
            className="mt-2 w-full rounded-xl bg-brand text-white py-2.5 px-3 text-sm font-semibold active:scale-[0.99] transition-transform"
          >
            {serviceMode === "appointment"
              ? `📅 ${s.radar_book_service}`
              : `📋 ${s.radar_send_order}`}
          </button>
        ))}

      {showResolution && (
        <button
          type="button"
          onClick={handleResolution}
          disabled={resolutionMarked || resolutionBusy}
          className={cn(
            "mt-2 w-full rounded-xl border py-2.5 px-3 text-sm font-semibold transition-colors active:scale-[0.99]",
            "border-brand/70 text-brand bg-transparent",
            "hover:bg-brand-muted",
            (resolutionMarked || resolutionBusy) && "opacity-60 cursor-not-allowed hover:bg-transparent",
          )}
        >
          {resolutionMarked
            ? `✅ ${s.radar_marked}`
            : serviceMode === "delivery"
              ? `📦 ${s.radar_delivered_on_time}`
              : `✅ ${s.radar_he_helped}`}
        </button>
      )}

      {showSaveRow && (
        <button
          type="button"
          onClick={() => void handleSaveVendor()}
          className={cn(
            "mt-2 w-full rounded-xl border py-2.5 px-3 text-sm font-semibold transition-colors active:scale-[0.99]",
            "border-border text-foreground bg-muted/40 hover:bg-muted/60",
          )}
        >
          {`🔖 ${s.radar_save_as}${getLabel(vendor.category) || s.radar_vendor_fallback}`}
        </button>
      )}
      {showUnsaveRow && (
        <button
          type="button"
          onClick={() => void handleUnsaveVendor()}
          className={cn(
            "mt-2 w-full rounded-xl border py-2.5 px-3 text-sm font-semibold transition-colors active:scale-[0.99]",
            "border-border text-muted-foreground bg-muted/30 hover:bg-muted/50",
          )}
        >
          {s.neighbours_saved_button}
        </button>
      )}
      <ParchiSheet
        vendor={vendor}
        vendorId={vendor.id}
        serviceMode={vendor.service_mode}
        isOpen={parchiOpen}
        onClose={() => setParchiOpen(false)}
        onOrderSent={() => setResolutionSessionTick((n) => n + 1)}
      />
      <PhoneEntrySheet
        isOpen={phoneSheetOpen}
        context="save"
        onClose={() => setPhoneSheetOpen(false)}
        onConfirmed={async (phone) => {
          setPhoneSheetOpen(false);
          await migrateUserPhone(phone, getDeviceId());
          void handleSaveVendor();
        }}
      />
    </div>
  );
}
