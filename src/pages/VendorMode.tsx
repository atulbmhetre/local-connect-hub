import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAppConfig } from "@/hooks/useAppConfig";
import { useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import {
  supabase,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  type Vendor,
  type VerificationStatus,
  type CategoryClassification,
  CATEGORIES,
  SHOP_PHOTOS_BUCKET,
  GPS_MATCH_TOLERANCE_M,
  isValidPhone,
  isValidUpi,
  isMobileCategory,
  distanceMeters,
  classifyCategory,
  useCategoryLabel,
  useServiceModeLabel,
  invokeNotifyUser,
} from "@/lib/supabase";
import { toast } from "sonner";
import {
  ArrowLeft,
  Bell,
  CheckCircle2,
  Loader2,
  Power,
  AlertCircle,
  MapPin,
  Camera,
  ShieldCheck,
  AlertTriangle,
  Truck,
  ChevronRight,
} from "lucide-react";
import { LiveCamera, type CapturedShot } from "@/components/LiveCamera";
import { VerificationBadge } from "@/components/VerificationBadge";
import { IncomingOrdersSection } from "@/components/IncomingOrdersSection";
import { VendorNoteEditor } from "@/components/vendor/VendorNoteEditor";
import { VendorAnalytics } from "@/components/vendor/VendorAnalytics";
import { cn } from "@/lib/utils";
import { notifyVendorIdChanged } from "@/lib/vendorSessionSync";
import { useLanguage } from '@/lib/language';
import { registerPushToken } from "../lib/pushNotifications";
import { Capacitor } from "@capacitor/core";
import {
  VendorOnboarding,
  isVendorOnboardingComplete,
} from "@/components/VendorOnboarding";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const STORAGE_KEY = "aaspaas:vendor_id";

/** Categories that default to delivery mode (matches DB seed / radar behaviour). */
const DELIVERY_CATEGORIES = new Set([
  "Pharmacy",
  "Grocery Store",
  "Medicine Delivery",
  "Beautician",
]);

function defaultServiceModeForCategory(category: string): "help" | "delivery" {
  return DELIVERY_CATEGORIES.has(category.trim()) ? "delivery" : "help";
}

function isAppointmentToday(iso: string): boolean {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function orderBlocksGoingOffline(
  order: { delivery_slot: string | null; appointment_time: string | null },
  serviceMode: string | null | undefined,
): boolean {
  const mode = serviceMode ?? "help";
  if (mode === "help") return true;
  if (mode === "delivery") {
    return (order.delivery_slot ?? "").trim().toLowerCase() !== "tomorrow";
  }
  if (mode === "appointment") {
    return order.appointment_time != null && isAppointmentToday(order.appointment_time);
  }
  return false;
}

type BlockingOfflineOrder = {
  id: string;
  user_phone: string | null;
  delivery_slot: string | null;
  appointment_time: string | null;
};

async function fetchBlockingActiveOrders(
  vendorId: string,
  serviceMode: string | null | undefined,
): Promise<BlockingOfflineOrder[]> {
  const { data, error } = await supabase
    .from("requests")
    .select("id, user_phone, delivery_slot, appointment_time")
    .eq("vendor_id", vendorId)
    .in("status", ["sent", "seen", "accepted"]);
  if (error || !data?.length) return [];
  return data.filter((row) => orderBlocksGoingOffline(row, serviceMode));
}

// Heuristic gibberish detector: rejects keyboard mashing like "asdfasdf"
// or strings without any vowels. Tuned to be permissive for real names.
function looksLikeGibberish(s: string) {
  const t = s.trim().toLowerCase();
  if (t.length < 2) return true;
  if (!/[aeiouy]/.test(t)) return true;                  // no vowels
  if (/(.)\1{3,}/.test(t)) return true;                  // 4+ repeats: "aaaa"
  if (/^[asdfghjkl;]+$/.test(t) && t.length > 4) return true; // home-row mash
  if (/^[qwertyuiop]+$/.test(t) && t.length > 4) return true;
  return false;
}

const VendorPostRegistrationGuidance = ({ vendor }: { vendor: Vendor }) => {
  const { s } = useLanguage();
  const hasPhoto =
    vendor.shop_photo_url != null && String(vendor.shop_photo_url).trim() !== "";

  if (!!vendor.is_manual_verified) {
    return (
      <div className="rounded-2xl border border-brand/45 bg-brand-muted p-4 text-sm">
        <p className="font-semibold text-brand">🟢 {s.vendor_verified_title}</p>
        <p className="mt-2 text-muted-foreground leading-relaxed">
          {s.vendor_verified_body}
        </p>
        <p className="mt-2 text-muted-foreground leading-relaxed">
          {s.vendor_verified_cta}
        </p>
      </div>
    );
  }

  if (hasPhoto && !vendor.is_manual_verified) {
    return (
      <div className="rounded-2xl border border-amber-500/45 bg-amber-500/10 p-4 text-sm">
        <p className="font-semibold text-amber-100">📋 {s.vendor_submitted_title}</p>
        <p className="mt-2 text-muted-foreground leading-relaxed">
          {s.vendor_submitted_body}
        </p>
      </div>
    );
  }

  return null;
};

const VendorMode = () => {
  const navigate = useNavigate();
  const { s } = useLanguage();
  const { config } = useAppConfig();
  const getLabel = useCategoryLabel();
  const getMode = useServiceModeLabel();
  const [vendorId, setVendorId] = useState<string | null>(
    localStorage.getItem(STORAGE_KEY),
  );
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const trialDaysLeft =
    vendor != null
      ? Math.max(
          0,
          config.vendorTrialDays -
            Math.floor(
              (Date.now() - new Date(vendor.created_at).getTime()) / (1000 * 60 * 60 * 24),
            ),
        )
      : null;
  const isInTrial =
    trialDaysLeft !== null && trialDaysLeft > 0 && !vendor?.subscription_active;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- registration form ----
  const [name, setName] = useState("");
  const [shopName, setShopName] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0].label);
  const [customCategory, setCustomCategory] = useState("");
  const [categorySuggestion, setCategorySuggestion] =
    useState<CategoryClassification | null>(null);
  const [classifyingCategory, setClassifyingCategory] = useState(false);
  const [confirmedCategory, setConfirmedCategory] = useState<string | null>(null);
  /** help | delivery | appointment — set after category step; required before register. */
  const [serviceMode, setServiceMode] = useState<"help" | "delivery" | "appointment" | null>(null);
  const [vendorNote, setVendorNote] = useState("");
  const [referralCodeInput, setReferralCodeInput] = useState("");
  const [upi, setUpi] = useState("");
  const [phone, setPhone] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);

  // ---- profile actions ----
  const [cameraOpen, setCameraOpen] = useState(false);
  const [verifyingUpi, setVerifyingUpi] = useState(false);
  const [updatingLocation, setUpdatingLocation] = useState(false);
  const [verificationSheetOpen, setVerificationSheetOpen] = useState(false);
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  const [lookupPhone, setLookupPhone] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const ordersRef = useRef<HTMLDivElement>(null);
  const pushRegisteredVendorRef = useRef<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [offlineConfirmOpen, setOfflineConfirmOpen] = useState(false);
  const [checkingOffline, setCheckingOffline] = useState(false);
  const [offlineBlockingOrders, setOfflineBlockingOrders] = useState<BlockingOfflineOrder[]>([]);

  useEffect(() => {
    localStorage.setItem("aaspaas:role", "vendor");
  }, []);

  // Broadcast vendor "live" state so the BottomNav can pulse the Vendor tab.
  useEffect(() => {
    const live = !!vendor?.is_active;
    if (live) localStorage.setItem("aaspaas:vendor_live", "1");
    else localStorage.removeItem("aaspaas:vendor_live");
    window.dispatchEvent(new CustomEvent("aaspaas:vendor_live", { detail: live }));
    return () => {
      // On unmount we don't clear — the flag should reflect DB state, not route.
    };
  }, [vendor?.is_active]);

  useEffect(() => {
    if (!vendorId) return;
    let cancelled = false;
    setLoading(true);
    supabase
      .from("vendors")
      .select("*")
      .eq("id", vendorId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setError(error.message);
        else if (!data) {
          localStorage.removeItem(STORAGE_KEY);
          setVendorId(null);
        } else setVendor(data as Vendor);
        setLoading(false);
      });

    const channel = supabase
      .channel(`vendor-${vendorId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "vendors", filter: `id=eq.${vendorId}` },
        (payload) => setVendor(payload.new as Vendor),
      )
      .subscribe();

    const pingInterval = window.setInterval(() => {
      void (async () => {
        if (!vendor?.is_active) return;
        const { error } = await supabase
          .from("vendors")
          .update({ last_updated: new Date().toISOString() })
          .eq("id", vendorId);
        if (error) console.error("Vendor ping failed:", error.message);
      })();
    }, 20 * 60 * 1000);

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      window.clearInterval(pingInterval);
    };
  }, [vendorId, vendor?.is_active]);

  useEffect(() => {
    if (!vendorId || vendor?.id !== vendorId) return;
    if (pushRegisteredVendorRef.current === vendorId) return;
    pushRegisteredVendorRef.current = vendorId;
    void registerPushToken(vendorId);
  }, [vendorId, vendor?.id]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    if (!vendorId || !vendor) return;
    if (isVendorOnboardingComplete()) return;
    setShowOnboarding(true);
  }, [vendorId, vendor]);

  const detectLocation = (): Promise<{ lat: number; lng: number } | null> => {
    return new Promise((resolve) => {
      if (!("geolocation" in navigator)) {
        toast.error(s.vendor_geo_not_supported);
        resolve(null);
        return;
      }
      setLocating(true);
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const c = { lat: p.coords.latitude, lng: p.coords.longitude };
          setCoords(c);
          setLocating(false);
          toast.success(s.vendor_location_captured);
          resolve(c);
        },
        (err) => {
          setLocating(false);
          toast.error(s.vendor_location_failed, { description: err.message });
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
      );
    });
  };

  // ---- registration ----
  const phoneOk = isValidPhone(phone);
  const upiFmtOk = isValidUpi(upi);
  const isOther = category === "Other";
  const effectiveCategory =
    isOther && confirmedCategory ? confirmedCategory : isOther ? customCategory.trim() : category.trim();
  const categoryOk =
    effectiveCategory.length > 1 && !looksLikeGibberish(effectiveCategory);
  const nameOk = name.trim().length > 1 && !looksLikeGibberish(name);
  const shopOk = shopName.trim().length > 1 && !looksLikeGibberish(shopName);

  const awaitingOtherCanonicalConfirm =
    isOther &&
    Boolean(categorySuggestion?.canonical) &&
    !confirmedCategory;

  const categoryConfirmedForFlow =
    nameOk &&
    shopOk &&
    categoryOk &&
    !awaitingOtherCanonicalConfirm &&
    !(isOther && classifyingCategory);

  const canRegister =
    nameOk &&
    shopOk &&
    categoryOk &&
    serviceMode !== null &&
    phoneOk &&
    upiFmtOk &&
    !loading;

  useEffect(() => {
    if (!isOther) {
      setCategorySuggestion(null);
      setClassifyingCategory(false);
      setConfirmedCategory(null);
      return;
    }

    const raw = customCategory.trim();
    setConfirmedCategory(null);
    if (raw.length < 2 || looksLikeGibberish(raw)) {
      setCategorySuggestion(null);
      setClassifyingCategory(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setClassifyingCategory(true);
      try {
        const result = await classifyCategory(raw);
        if (cancelled) return;
        setCategorySuggestion(result);
      } catch {
        if (cancelled) return;
        setCategorySuggestion(null);
      } finally {
        if (!cancelled) setClassifyingCategory(false);
      }
    }, 1000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOther, customCategory]);

  const suggestedServiceMode = useMemo((): "help" | "delivery" | "appointment" | null => {
    if (!categoryConfirmedForFlow) return null;
    const fromCategory = defaultServiceModeForCategory(effectiveCategory);
    const aiMode = categorySuggestion?.mode;
    if (aiMode === "delivery" || aiMode === "help") return aiMode;
    return fromCategory;
  }, [categoryConfirmedForFlow, effectiveCategory, categorySuggestion?.mode]);

  // Apply AI / category default when the suggestion changes; manual taps persist until then.
  useEffect(() => {
    if (suggestedServiceMode == null) {
      setServiceMode(null);
      return;
    }
    setServiceMode(suggestedServiceMode);
  }, [suggestedServiceMode]);

  const register = async (e: FormEvent) => {
    e.preventDefault();
    // Surface the most useful error first.
    if (!nameOk) {
      toast.error(s.vendor_name_invalid, {
        description: s.vendor_name_invalid_body,
      });
      return;
    }
    if (!shopOk) {
      toast.error(s.vendor_shopname_invalid, {
        description: s.vendor_shopname_invalid_body,
      });
      return;
    }
    if (!categoryOk) {
      toast.error(s.vendor_specify_service, {
        description: s.vendor_specify_service_body,
      });
      return;
    }
    if (!serviceMode) {
      toast.error(s.vendor_choose_service, {
        description: s.vendor_choose_service_body,
      });
      return;
    }
    if (!phoneOk) {
      toast.error(s.vendor_phone_invalid, {
        description: s.vendor_phone_invalid_body,
      });
      return;
    }
    if (!upiFmtOk) {
      toast.error(s.vendor_upi_invalid, {
        description: s.vendor_upi_invalid_body,
      });
      return;
    }
    setLoading(true);
    setError(null);

    // Phone + UPI on file ⇒ identity_linked
    const initialStatus: VerificationStatus = "identity_linked";

    const { data, error } = await supabase
      .from("vendors")
      .insert({
        name: name.trim(),
        shop_name: shopName.trim(),
        category: effectiveCategory,
        upi_id: upi.trim(),
        phone: phone.trim(),
        is_active: false,
        service_mode: serviceMode,
        vendor_note: vendorNote.trim() || null,
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
        verification_status: initialStatus,
        upi_verified: false,
        is_manual_verified: false,
        shop_photo_url: null,
      })
      .select()
      .single();
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    const newVendorId = data.id;
    localStorage.setItem(STORAGE_KEY, newVendorId);
    notifyVendorIdChanged();
    setVendorId(newVendorId);
    setVendor(data as Vendor);
    if (referralCodeInput.trim()) {
      void fetch(`${SUPABASE_URL}/functions/v1/process-vendor-referral`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          new_vendor_id: newVendorId,
          referral_code: referralCodeInput.trim(),
        }),
      });
    }
    toast.success(s.vendor_welcome_title, {
      description: s.vendor_welcome_body,
    });
  };

  const lookupVendorByPhone = async (e: FormEvent) => {
    e.preventDefault();
    const cleaned = lookupPhone.replace(/\D/g, "");
    const digits =
      cleaned.length === 12 && cleaned.startsWith("91")
        ? cleaned.slice(2)
        : cleaned.length === 11 && cleaned.startsWith("1")
          ? cleaned.slice(1)
          : cleaned;
    if (digits.length !== 10 || !/^[6-9]/.test(digits)) {
      setLookupError(s.vendor_phone_invalid_body);
      return;
    }
    setLookupError(null);
    setLookupLoading(true);
    try {
      const variants = [digits, `+91${digits}`, `91${digits}`, `+91 ${digits}`];
      let found: Vendor | null = null;
      for (const v of variants) {
        const { data, error } = await supabase.from("vendors").select("*").eq("phone", v).maybeSingle();
        if (error) continue;
        if (data) {
          found = data as Vendor;
          break;
        }
      }
      if (found) {
        localStorage.setItem(STORAGE_KEY, found.id);
        notifyVendorIdChanged();
        setVendorId(found.id);
        setVendor(found);
        setLookupPhone("");
        setAlreadyRegistered(false);
        setLookupError(null);
        toast.success(s.vendor_welcome_back);
      } else {
        setLookupError(s.vendor_not_found);
      }
    } finally {
      setLookupLoading(false);
    }
  };

  // ---- runtime actions ----
  const applyActiveState = async (next: boolean): Promise<boolean> => {
    if (!vendor) return false;
    setVendor({ ...vendor, is_active: next });

    let liveCoords: { lat: number; lng: number } | null = null;
    if (next && isMobileCategory(vendor.category)) {
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          if (!("geolocation" in navigator)) {
            reject(new Error("Geolocation not supported"));
            return;
          }
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 8000,
            maximumAge: 0,
          });
        });
        liveCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      } catch {
        setVendor({ ...vendor, is_active: !next });
        toast.error(s.vendor_location_required, {
          description: s.vendor_location_required_body,
        });
        return false;
      }
    }

    const patch: Record<string, unknown> = { is_active: next };
    if (next) {
      patch.last_updated = new Date().toISOString();
    }
    if (liveCoords) {
      patch.latitude = liveCoords.lat;
      patch.longitude = liveCoords.lng;
    }

    const { error } = await supabase
      .from("vendors")
      .update(patch)
      .eq("id", vendor.id);
    if (error) {
      setVendor({ ...vendor, is_active: !next });
      toast.error(s.vendor_status_failed, { description: error.message });
      return false;
    }

    toast(next ? s.vendor_you_are_live : s.vendor_you_are_offline, {
      description: next
        ? liveCoords
          ? s.vendor_live_body
          : s.vendor_live_body_short
        : s.vendor_offline_body,
    });
    return true;
  };

  const notifyUsersVendorOffline = (orders: BlockingOfflineOrder[]) => {
    const phones = [
      ...new Set(
        orders
          .map((o) => o.user_phone?.trim())
          .filter((phone): phone is string => !!phone),
      ),
    ];
    for (const userPhone of phones) {
      void invokeNotifyUser({
        user_phone: userPhone,
        title: s.user_vendor_offline_title,
        body: s.user_vendor_offline_body,
      });
    }
  };

  const toggleActive = async () => {
    if (!vendor || checkingOffline) return;
    const next = !vendor.is_active;

    if (!next) {
      setCheckingOffline(true);
      const blockingOrders = await fetchBlockingActiveOrders(
        vendor.id,
        vendor.service_mode,
      );
      setCheckingOffline(false);
      if (blockingOrders.length > 0) {
        setOfflineBlockingOrders(blockingOrders);
        setOfflineConfirmOpen(true);
        return;
      }
      setOfflineBlockingOrders([]);
    }

    await applyActiveState(next);
  };

  const confirmGoOfflineAnyway = async () => {
    const ordersToNotify = offlineBlockingOrders;
    setOfflineConfirmOpen(false);
    setOfflineBlockingOrders([]);
    const ok = await applyActiveState(false);
    if (ok && ordersToNotify.length > 0) {
      notifyUsersVendorOffline(ordersToNotify);
    }
  };

  const verifyUpi = async () => {
    if (!vendor) return;
    if (!isValidUpi(vendor.upi_id)) {
      toast.error(s.vendor_upi_format_invalid, { description: s.vendor_upi_format_body });
      return;
    }
    setVerifyingUpi(true);
    // Simulated bank-name lookup. Replace with a real PSP call later.
    await new Promise((r) => setTimeout(r, 900));
    const bank = vendor.upi_id.split("@")[1] ?? "bank";
    const { error } = await supabase
      .from("vendors")
      .update({ upi_verified: true })
      .eq("id", vendor.id);
    setVerifyingUpi(false);
    if (error) {
      toast.error(s.vendor_upi_check_failed, { description: error.message });
      return;
    }
    toast.success(`${s.vendor_upi_verified}${bank.toUpperCase()}`, {
      description: s.vendor_upi_bank_valid,
    });
  };

  const handleShopPhoto = async (shot: CapturedShot) => {
    if (!vendor) return;
    setCameraOpen(false);

    // 1. GPS match check vs the recorded shop coords.
    if (vendor.latitude == null || vendor.longitude == null) {
      toast.error(s.vendor_set_location_first, {
        description: s.vendor_set_location_first_body,
      });
      return;
    }
    const meters = distanceMeters(
      { lat: vendor.latitude, lng: vendor.longitude },
      shot.coords,
    );
    if (meters > GPS_MATCH_TOLERANCE_M) {
      toast.error(s.vendor_mismatch_title, {
        description: `Photo was taken ${Math.round(meters)} m from your shop. Must be within ${GPS_MATCH_TOLERANCE_M} m.`,
      });
      return;
    }

    // 2. Upload to Storage.
    const path = `${vendor.id}/${Date.now()}.jpg`;
    const { error: upErr } = await supabase.storage
      .from(SHOP_PHOTOS_BUCKET)
      .upload(path, shot.blob, {
        contentType: "image/jpeg",
        upsert: true,
      });
    if (upErr) {
      toast.error(s.vendor_upload_failed, { description: upErr.message });
      return;
    }
    const { data: pub } = supabase.storage.from(SHOP_PHOTOS_BUCKET).getPublicUrl(path);

    // 3. Promote to business_verified (admin still gates the green glow).
    const { error: updErr } = await supabase
      .from("vendors")
      .update({
        shop_photo_url: pub.publicUrl,
        verification_status: "business_verified" as VerificationStatus,
      })
      .eq("id", vendor.id);
    if (updErr) {
      toast.error(s.vendor_save_verification_failed, { description: updErr.message });
      return;
    }
    toast.success(s.vendor_photo_verified, {
      description: vendor.is_manual_verified
        ? s.vendor_green_badge_live
        : s.vendor_awaiting_admin,
    });
  };

  const updateShopLocation = async () => {
    if (!vendor) return;
    if (vendor.verification_status === "business_verified") {
      const ok = window.confirm(
        s.vendor_location_reset_confirm,
      );
      if (!ok) return;
    }
    const c = await detectLocation();
    if (!c) return;
    setUpdatingLocation(true);

    // If they were business_verified, drop them back to identity_linked and
    // clear the manual flag — admin must re-approve after a fresh photo.
    const downgraded = vendor.verification_status === "business_verified";
    const patch: Partial<Vendor> = {
      latitude: c.lat,
      longitude: c.lng,
      ...(downgraded
        ? {
            verification_status: "identity_linked" as VerificationStatus,
            shop_photo_url: null,
            is_manual_verified: false,
          }
        : {}),
    };
    const { error } = await supabase
      .from("vendors")
      .update(patch)
      .eq("id", vendor.id);
    setUpdatingLocation(false);
    if (error) {
      toast.error(s.vendor_location_update_failed, { description: error.message });
      return;
    }
    toast(downgraded ? s.vendor_reverification_required : s.vendor_location_updated, {
      description: downgraded
        ? s.vendor_reverification_body
        : s.vendor_location_updated_body,
    });
  };

  return (
    <AppShell theme="dark">
      {showOnboarding && vendorId && vendor && (
        <VendorOnboarding onComplete={() => setShowOnboarding(false)} />
      )}
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="h-10 w-10 shrink-0 grid place-items-center rounded-xl bg-card border border-border"
            aria-label={s.vendor_back_home}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">{s.vendor_mode_title}</p>
            <h1 className="font-display text-3xl font-bold mt-1">{s.vendor_tagline}</h1>
          </div>
        </div>
        {vendor != null && (
          <div className="relative shrink-0 ml-3">
            <button
              type="button"
              onClick={() => ordersRef.current?.scrollIntoView({ behavior: "smooth" })}
              className="h-10 w-10 grid place-items-center rounded-xl bg-card border border-border"
              aria-label={s.vendor_view_orders}
            >
              <Bell className="h-5 w-5" />
            </button>
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 rounded-full bg-brand text-[#0b1f14] text-[10px] font-bold min-w-[1.125rem] h-[1.125rem] px-1 grid place-items-center tabular-nums">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </div>
        )}
      </header>

      {error && (
        <div className="mb-4 rounded-2xl bg-destructive/10 border border-destructive/30 p-4 flex gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive break-words">{error}</p>
        </div>
      )}

      {!vendorId && !alreadyRegistered && (
        <>
          <form onSubmit={register} className="space-y-3 animate-fade-up">
          <Field label={s.vendor_your_name} value={name} onChange={setName} placeholder={s.vendor_name_placeholder} required />
          <Field label={s.vendor_shop_name} value={shopName} onChange={setShopName} placeholder={s.vendor_shop_placeholder} required />
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{s.vendor_category_label}</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="mt-1 w-full bg-surface text-foreground border-surface-border rounded-xl px-4 py-3.5 text-base focus:outline-none focus:ring-2 focus:ring-primary vendor-select"
            >
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.label}>{c.emoji}  {c.label}</option>
              ))}
            </select>
            {isOther && (
              <div className="mt-3 animate-fade-up">
                <Field
                  label={s.vendor_specify_category}
                  value={customCategory}
                  onChange={setCustomCategory}
                  placeholder={s.vendor_specify_placeholder}
                  required
                  error={
                    customCategory.length > 0 && !categoryOk
                      ? s.vendor_specify_hint
                      : undefined
                  }
                />
                {classifyingCategory && (
                  <p className="mt-2 text-xs text-muted-foreground inline-flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {s.vendor_understanding}
                  </p>
                )}
                {categorySuggestion && !confirmedCategory && categorySuggestion.canonical === null && (
                  <div className="mt-2 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3">
                    <p className="text-sm text-amber-200 font-medium">
                      {categorySuggestion.message ?? s.vendor_more_specific}
                    </p>
                  </div>
                )}
                {categorySuggestion && !confirmedCategory && categorySuggestion.canonical != null && (
                  <div className="mt-2 rounded-xl border border-brand/40 bg-brand-muted p-3">
                    <p className="text-sm text-brand font-medium">
                      {s.vendor_we_think} {categorySuggestion.canonical} {categorySuggestion.emoji} (
                      {categorySuggestion.mode === "help" ? s.vendor_help_service : s.vendor_delivery_service})
                      {categorySuggestion.is_government ? ` ${s.vendor_govt_service}` : ""}
                    </p>
                    <button
                      type="button"
                      onClick={() => setConfirmedCategory(categorySuggestion.canonical!)}
                      className="mt-2 rounded-lg bg-brand text-[#0b1f14] px-3 py-1.5 text-xs font-semibold"
                    >
                      {s.vendor_confirm}
                    </button>
                  </div>
                )}
                {confirmedCategory && (
                  <p className="mt-2 text-xs text-brand font-semibold">
                    {s.vendor_confirmed_category} {confirmedCategory}
                  </p>
                )}
              </div>
            )}
          </div>

          {(category !== "Other" || confirmedCategory) && (
            <div className="space-y-3 pt-1">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {s.vendor_how_serve}
              </label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setServiceMode("help")}
                  className={cn(
                    "rounded-2xl border-2 p-3 text-left transition-colors active:scale-[0.98]",
                    "bg-surface border-surface-border",
                    serviceMode === "help" &&
                      "border-brand bg-brand/15 ring-1 ring-brand/30",
                  )}
                >
                  <p className="text-base font-display font-bold text-foreground leading-tight">
                    {s.vendor_mode_visit}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground leading-snug">
                    {s.vendor_mode_visit_eg}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setServiceMode("delivery")}
                  className={cn(
                    "rounded-2xl border-2 p-3 text-left transition-colors active:scale-[0.98]",
                    "bg-surface border-surface-border",
                    serviceMode === "delivery" &&
                      "border-brand bg-brand/15 ring-1 ring-brand/30",
                  )}
                >
                  <p className="text-base font-display font-bold text-foreground leading-tight">
                    {s.vendor_mode_deliver}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground leading-snug">
                    {s.vendor_mode_deliver_eg}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setServiceMode("appointment")}
                  className={cn(
                    "rounded-2xl border-2 p-3 text-left transition-colors active:scale-[0.98]",
                    "bg-surface border-surface-border",
                    serviceMode === "appointment" &&
                      "border-brand bg-brand/15 ring-1 ring-brand/30",
                  )}
                >
                  <p className="text-base font-display font-bold text-foreground leading-tight">
                    {s.vendor_mode_booking}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground leading-snug">
                    {s.vendor_mode_booking_eg}
                  </p>
                </button>
              </div>
            </div>
          )}

          <Field
            label={s.vendor_phone_label}
            value={phone}
            onChange={setPhone}
            placeholder={s.vendor_phone_placeholder}
            required
            error={phone.length > 0 && !phoneOk ? s.vendor_phone_hint : undefined}
          />
          <Field
            label={s.vendor_upi_label}
            value={upi}
            onChange={setUpi}
            placeholder={s.vendor_upi_placeholder}
            required
            error={upi.length > 0 && !upiFmtOk ? s.vendor_upi_hint : undefined}
          />

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.vendor_note_label}
            </label>
            <textarea
              value={vendorNote}
              onChange={(e) => setVendorNote(e.target.value.slice(0, 100))}
              rows={2}
              placeholder={s.vendor_note_placeholder}
              className="mt-1 w-full bg-card border border-border rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            />
            <p className="text-[10px] text-muted-foreground text-right mt-0.5">
              {vendorNote.length}/100
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-gray-400">{s.vendor_referralCodeLabel}</label>
            <input
              type="text"
              value={referralCodeInput}
              onChange={(e) => setReferralCodeInput(e.target.value.toUpperCase().trim())}
              placeholder={s.vendor_referralCodePlaceholder}
              maxLength={10}
              className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-brand/50"
            />
          </div>

          <p className="text-[11px] text-amber-400/90 text-center px-2">
            ⚠️ {s.vendor_gps_warning}
          </p>

          <button
            type="button"
            onClick={detectLocation}
            className={`w-full rounded-xl border-2 py-3.5 flex items-center justify-center gap-2 font-semibold transition-colors ${
              coords ? "border-secondary text-secondary bg-secondary/5" : "border-border text-foreground"
            }`}
          >
            {locating ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
            {coords
              ? `${s.vendor_location_set} (${coords.lat.toFixed(3)}, ${coords.lng.toFixed(3)})`
              : s.vendor_capture_location}
          </button>

          <button
            disabled={!canRegister}
            className="w-full mt-2 rounded-2xl bg-gradient-vendor text-white py-4 font-semibold shadow-card active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
            {s.vendor_register_btn}
          </button>
          {!phoneOk && (
            <p className="text-xs text-muted-foreground text-center">
              {s.vendor_register_hint}
            </p>
          )}
          </form>

          <div className="relative py-6 animate-fade-up">
            <div className="absolute inset-0 flex items-center" aria-hidden>
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs uppercase tracking-wider">
              <span className="bg-background px-3 text-muted-foreground">{s.vendor_or}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              setAlreadyRegistered(true);
              setLookupError(null);
            }}
            className="w-full text-center text-sm font-semibold text-brand hover:underline py-2 animate-fade-up"
          >
            {s.vendor_already_registered}
          </button>
        </>
      )}

      {!vendorId && alreadyRegistered && (
        <form onSubmit={lookupVendorByPhone} className="space-y-4 animate-fade-up">
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">{s.vendor_find_account_title}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {s.vendor_find_account_hint}
            </p>
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Phone
            </label>
            <div className="mt-1 flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3">
              <span className="text-sm text-muted-foreground font-medium">+91</span>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                placeholder="98765 43210"
                value={lookupPhone}
                onChange={(e) => {
                  setLookupPhone(e.target.value.replace(/\D/g, "").slice(0, 10));
                  setLookupError(null);
                }}
                className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/50"
                autoComplete="tel-national"
              />
            </div>
            {lookupError && <p className="mt-1 text-xs text-destructive">{lookupError}</p>}
          </div>

          <button
            type="submit"
            disabled={lookupLoading}
            className="w-full rounded-2xl bg-gradient-vendor text-secondary-foreground py-3.5 font-semibold shadow-card active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {lookupLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
            {s.vendor_find_btn}
          </button>

          <button
            type="button"
            onClick={() => {
              setAlreadyRegistered(false);
              setLookupError(null);
              setLookupPhone("");
            }}
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground py-2"
          >
            {s.vendor_back_to_reg}
          </button>
        </form>
      )}

      {vendorId && loading && !vendor && (
        <div className="grid place-items-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {vendor && (
        <div className="space-y-5 animate-fade-up">
          {isInTrial && (
            <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning text-center">
              {s.vendor_trialDaysLeft(trialDaysLeft!)}
            </div>
          )}
          {trialDaysLeft === 0 && !vendor.subscription_active && (
            <div className="rounded-xl border border-danger/30 bg-danger-muted px-3 py-2 text-xs text-danger text-center">
              {s.vendor_trialExpired}
            </div>
          )}
          {/* Status card */}
          <div className="rounded-3xl bg-card border border-border shadow-card p-6 text-center">
            <p
              className={`mt-1 font-display text-xl font-semibold ${
                vendor.is_active ? "text-brand" : "text-gray-400"
              }`}
            >
              {vendor.is_active ? s.vendor_ready : s.vendor_offline_label}
            </p>

            <button
              onClick={() => void toggleActive()}
              disabled={checkingOffline}
              aria-pressed={vendor.is_active}
              className={`mt-6 mx-auto rounded-full grid place-items-center transition-all active:scale-95 disabled:opacity-60 ${
                vendor.is_active
                  ? "h-11 w-11 bg-brand border-0 text-black"
                  : "h-[72px] w-[72px] bg-green-950 dark:bg-[#1e3a1e] border-2 border-brand text-brand"
              }`}
            >
              <Power
                className={vendor.is_active ? "h-[18px] w-[18px] text-black" : "h-[30px] w-[30px] text-brand"}
                strokeWidth={2.5}
              />
            </button>

            {vendor.is_active ? (
              <p className="mt-3 text-[11px] font-normal text-[#555]">{s.vendor_tap_offline}</p>
            ) : (
              <>
                <p className="mt-3 text-[13px] font-medium text-brand">{s.vendor_tap_online}</p>
                <p className="mt-1 text-[11px] text-[#666]">{s.vendor_customers_waiting}</p>
              </>
            )}
            {isMobileCategory(vendor.category) && (
              <p className="mt-2 text-[11px] text-muted-foreground inline-flex items-center justify-center gap-1">
                <Truck className="h-3 w-3 text-secondary" />
                {s.vendor_mobile_gps}
              </p>
            )}

            <div className="mt-4 flex justify-center">
              <VerificationBadge vendor={vendor} showLabel />
            </div>
          </div>

          <VendorAnalytics vendorId={vendor.id} />

          <div ref={ordersRef}>
            <IncomingOrdersSection
              vendorId={vendor.id}
              serviceMode={vendor.service_mode ?? "help"}
              onUnreadCount={(n) => setUnreadCount(n)}
            />
          </div>

          <button
            type="button"
            onClick={() => setVerificationSheetOpen(true)}
            className="w-full rounded-2xl border border-border bg-card shadow-card px-4 py-3 flex items-center gap-3 text-left active:scale-[0.99] transition-transform"
          >
            <span
              className={cn(
                "h-2.5 w-2.5 rounded-full shrink-0",
                !!vendor.is_manual_verified && "bg-brand",
                !vendor.is_manual_verified &&
                  vendor.shop_photo_url != null &&
                  String(vendor.shop_photo_url).trim() !== "" &&
                  "bg-warning",
                (!vendor.is_manual_verified &&
                  (vendor.shop_photo_url == null || String(vendor.shop_photo_url).trim() === "")) &&
                  "bg-destructive",
              )}
            />
            <span className="flex-1 min-w-0 text-sm font-semibold text-foreground">
              {!!vendor.is_manual_verified
                ? s.vendor_verified_pro
                : vendor.shop_photo_url != null && String(vendor.shop_photo_url).trim() !== ""
                  ? s.vendor_pending_label
                  : s.vendor_complete_verification}
            </span>
            <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" aria-hidden />
          </button>

          <Sheet open={verificationSheetOpen} onOpenChange={setVerificationSheetOpen}>
            <SheetContent
              side="bottom"
              className="bg-background border-t border-border rounded-t-2xl max-h-[90vh] overflow-y-auto [&>button]:hidden"
            >
              <div className="flex items-center justify-between border-b border-border pb-3 mb-4 -mt-1">
                <span className="text-sm font-semibold text-foreground">{s.vendor_verification_shop}</span>
                <button
                  type="button"
                  onClick={() => setVerificationSheetOpen(false)}
                  className="text-sm font-semibold text-muted-foreground hover:text-foreground"
                >
                  {s.vendor_close}
                </button>
              </div>

              {/* Verification card */}
              <div className="rounded-2xl bg-card border border-border shadow-card p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-secondary" />
                  <h2 className="font-display font-bold">{s.vendor_verification_heading}</h2>
                </div>

                <Step
                  done={isValidPhone(vendor.phone ?? "")}
                  title={s.vendor_phone_on_file}
                  sub={vendor.phone || s.vendor_not_provided}
                />

                <div className="flex items-start justify-between gap-3">
                  <Step
                    done={vendor.upi_verified}
                    title={s.vendor_upi_bank_match}
                    sub={vendor.upi_id}
                  />
                  {!vendor.upi_verified && (
                    <button
                      onClick={verifyUpi}
                      disabled={verifyingUpi}
                      className="text-xs font-semibold rounded-lg bg-primary text-primary-foreground px-3 py-2 disabled:opacity-60 shrink-0"
                    >
                      {verifyingUpi ? s.vendor_checking : s.vendor_verify_upi_btn}
                    </button>
                  )}
                </div>

                <div className="flex items-start justify-between gap-3">
                  <Step
                    done={!!vendor.shop_photo_url}
                    title={s.vendor_photo_gps}
                    sub={
                      vendor.shop_photo_url
                        ? s.vendor_photo_captured
                        : s.vendor_photo_hint
                    }
                  />
                  <button
                    onClick={() => setCameraOpen(true)}
                    className="text-xs font-semibold rounded-lg bg-foreground text-background px-3 py-2 shrink-0 inline-flex items-center gap-1"
                  >
                    <Camera className="h-3.5 w-3.5" />
                    {vendor.shop_photo_url ? s.vendor_reshoot : s.vendor_capture}
                  </button>
                </div>

                {vendor.shop_photo_url && (
                  <img
                    src={vendor.shop_photo_url}
                    alt={s.vendor_captured_shop}
                    className="w-full rounded-xl border border-border"
                  />
                )}

                <div className="rounded-xl bg-muted/60 p-3 text-xs text-muted-foreground">
                  {s.vendor_badge_approval} ({vendor.is_manual_verified ? s.vendor_approved : s.vendor_approval_pending}).
                </div>
              </div>

              <VendorPostRegistrationGuidance vendor={vendor} />

              {/* Shop info */}
              <div className="rounded-2xl bg-muted/60 p-4 text-sm space-y-2 mt-4">
                <div>
                  <p className="font-semibold">{vendor.shop_name}</p>
                  <p className="text-muted-foreground">{vendor.name} · {getLabel(vendor.category)}</p>
                  <p className="text-muted-foreground text-xs">📞 {vendor.phone}</p>
                  <p className="text-muted-foreground text-xs">UPI: {vendor.upi_id}</p>
                  {vendor.latitude != null && vendor.longitude != null && (
                    <p className="text-muted-foreground text-xs">
                      📍 {vendor.latitude.toFixed(4)}, {vendor.longitude.toFixed(4)}
                    </p>
                  )}
                </div>
                <button
                  onClick={updateShopLocation}
                  disabled={updatingLocation}
                  className="w-full rounded-xl border-2 border-border py-2.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
                >
                  {updatingLocation ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <MapPin className="h-4 w-4" />
                  )}
                  {s.vendor_update_location}
                </button>
                {vendor.verification_status === "business_verified" && (
                  <p className="text-[11px] text-muted-foreground inline-flex items-start gap-1">
                    <AlertTriangle className="h-3 w-3 text-accent mt-0.5 shrink-0" />
                    {s.vendor_location_reset_warning}
                  </p>
                )}
              </div>

              <VendorNoteEditor
                vendorId={vendor.id}
                initialNote={vendor.vendor_note}
                onSaved={(newNote) =>
                  setVendor({ ...vendor, vendor_note: newNote || null })
                }
              />
            </SheetContent>
          </Sheet>
        </div>
      )}

      <AlertDialog open={offlineConfirmOpen} onOpenChange={setOfflineConfirmOpen}>
        <AlertDialogContent className="rounded-2xl border border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{s.vendor_offline_active_orders_title}</AlertDialogTitle>
            <AlertDialogDescription>
              {s.vendor_offline_active_orders_message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel className="mt-0">{s.vendor_stay_online}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void confirmGoOfflineAnyway()}
            >
              {s.vendor_go_offline_anyway}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <LiveCamera
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={handleShopPhoto}
      />
    </AppShell>
  );
};

const Field = ({
  label, value, onChange, placeholder, required, error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  error?: string;
}) => {
  const { s } = useLanguage();
  void s;

  return (
    <div>
      <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className={`mt-1 w-full bg-card border rounded-xl px-4 py-3.5 text-base focus:outline-none focus:ring-2 ${
          error ? "border-destructive focus:ring-destructive" : "border-border focus:ring-primary"
        }`}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
};

const Step = ({ done, title, sub }: { done: boolean; title: string; sub: string }) => {
  const { s } = useLanguage();
  void s;

  return (
    <div className="flex-1 flex items-start gap-3">
      <span
        className={`mt-0.5 h-5 w-5 rounded-full grid place-items-center shrink-0 ${
          done ? "bg-secondary text-secondary-foreground" : "bg-muted text-muted-foreground"
        }`}
      >
        {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground truncate">{sub}</p>
      </div>
    </div>
  );
};

export default VendorMode;
