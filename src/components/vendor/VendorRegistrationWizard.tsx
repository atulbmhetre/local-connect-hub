import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Camera, CheckCircle2, ChevronLeft, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import { ServiceRadiusChips } from "@/components/ServiceRadiusChips";
import { CategoryAvailabilityModeSelector } from "@/components/vendor/CategoryAvailabilityModeSelector";
import { LiveCamera, type CapturedShot } from "@/components/LiveCamera";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";
import {
  getReferralCode,
  isReferralEnabled,
  referralCodeFromPhone,
} from "@/lib/referral";
import {
  supabase,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  isValidPhone,
  isValidUpi,
  useCategoryLabel,
  invokeNotifyAdmin,
  invokeRegisterVendor,
  invokeAttachPendingCategory,
  invokeSuggestCategory,
  GPS_MATCH_TOLERANCE_M,
  SHOP_PHOTOS_BUCKET,
  VENDOR_SELFIES_BUCKET,
  distanceMeters,
  type CategorySuggestionResult,
} from "@/lib/supabase";
import { patchVendorOwn } from "@/lib/vendorPatch";
import {
  withNetworkRetry,
  isNetworkFailure,
} from "@/lib/withNetworkRetry";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  dismissNetworkRetryingToast,
  showNetworkRetryingToast,
} from "@/lib/networkToast";
import {
  allCategoriesHaveModes,
  buildCategoryModesPayload,
  pickPrimaryAvailabilityMode,
  unionAvailabilityModes,
} from "@/lib/categoryAvailabilityModes";
import {
  type AvailabilityMode,
  type BaseTypeValue,
  type ReachChoiceValue,
  MAX_REG_CATEGORIES,
  baseTypeToVendorType,
  looksLikeGibberish,
  reachFlagsFromChoice,
  resolveRegistrationShopName,
  showRegistrationGuidanceToast,
} from "@/lib/vendorRegistration";
import type { ServiceRadiusKm } from "@/lib/serviceRadius";
import { decodeUpiPayeeIdFromImageFile } from "@/lib/upiQrDecode";

type RegCategoryRow = {
  id: string;
  label: string;
  emoji: string;
  service_mode: string;
};

type Props = {
  onRegistered: (vendorId: string, vendorPhone: string) => void;
  onDuplicatePhone: () => void;
  setParentError: (msg: string | null) => void;
};

function categoryServiceModeChipLabel(
  mode: string,
  s: {
    category_chip_mode_help: string;
    category_chip_mode_delivery: string;
    category_chip_mode_booking: string;
    category_chip_mode_appointment: string;
  },
): string {
  switch (mode) {
    case "help":
      return s.category_chip_mode_help;
    case "delivery":
      return s.category_chip_mode_delivery;
    case "booking":
      return s.category_chip_mode_booking;
    case "appointment":
      return s.category_chip_mode_appointment;
    default:
      return mode;
  }
}

function RegField({
  label,
  value,
  onChange,
  placeholder,
  required,
  error,
  type = "text",
  onBlur,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  error?: string;
  type?: string;
  onBlur?: () => void;
}) {
  return (
    <div>
      <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
        {required ? " *" : ""}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        className={cn(
          "mt-1 w-full bg-card border rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary",
          error ? "border-destructive" : "border-border",
        )}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function ChoiceCard({
  selected,
  onClick,
  emoji,
  title,
  desc,
}: {
  selected: boolean;
  onClick: () => void;
  emoji: string;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-2xl border-2 p-3 text-left transition-colors active:scale-[0.98] w-full",
        "bg-surface border-surface-border",
        selected && "border-primary bg-primary/15 ring-1 ring-primary/30",
      )}
    >
      <p className="text-base font-display font-bold text-foreground leading-tight">
        {emoji} {title}
      </p>
      <p className="mt-1 text-[10px] text-muted-foreground leading-snug">{desc}</p>
    </button>
  );
}

function isDuplicateVendorPhoneError(error: { code?: string; message?: string }): boolean {
  if (error.code === "23505") return true;
  const msg = (error.message ?? "").toLowerCase();
  return (
    (msg.includes("duplicate") || msg.includes("unique")) &&
    (msg.includes("phone") || msg.includes("vendors"))
  );
}

function isRateLimitedError(error: { code?: string; message?: string }): boolean {
  return (error.message ?? "").toLowerCase().includes("rate_limited");
}

export function VendorRegistrationWizard({
  onRegistered,
  onDuplicatePhone,
  setParentError,
}: Props) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();

  const [regPage, setRegPage] = useState<1 | 2>(1);
  const [loading, setLoading] = useState(false);

  const [baseType, setBaseType] = useState<BaseTypeValue>("");
  const [name, setName] = useState("");
  const [shopName, setShopName] = useState("");
  const [businessDescription, setBusinessDescription] = useState("");
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [regCategories, setRegCategories] = useState<RegCategoryRow[]>([]);
  const [regCategoriesLoading, setRegCategoriesLoading] = useState(true);
  const [extraRegCategories, setExtraRegCategories] = useState<RegCategoryRow[]>([]);
  const [categorySuggesting, setCategorySuggesting] = useState(false);
  const [categorySuggestion, setCategorySuggestion] = useState<CategorySuggestionResult | null>(
    null,
  );
  const [showManualCategories, setShowManualCategories] = useState(false);
  const [pendingNewCategoryCreate, setPendingNewCategoryCreate] = useState<{
    description: string;
    category_name: string;
    service_mode: string;
  } | null>(null);

  const [reachChoice, setReachChoice] = useState<ReachChoiceValue | "">("");
  const [serviceRadiusKm, setServiceRadiusKm] = useState<number | null>(null);
  const [categoryModesById, setCategoryModesById] = useState<
    Record<string, AvailabilityMode[]>
  >({});
  const [pendingCategoryModes, setPendingCategoryModes] = useState<AvailabilityMode[]>([]);
  const [cancelReasons, setCancelReasons] = useState(["", "", "", ""]);

  const [phone, setPhone] = useState("");
  const [upi, setUpi] = useState("");
  const [upiBlurred, setUpiBlurred] = useState(false);
  const [upiQrUrl, setUpiQrUrl] = useState("");
  const [upiQrPayeeId, setUpiQrPayeeId] = useState<string | null>(null);
  const [upiQrUploading, setUpiQrUploading] = useState(false);
  const upiQrInputRef = useRef<HTMLInputElement>(null);
  const [vendorNote, setVendorNote] = useState("");
  const [referralCodeInput, setReferralCodeInput] = useState("");
  const [referralEnabled, setReferralEnabled] = useState(false);

  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationInlineError, setLocationInlineError] = useState<string | null>(null);
  const [showLocationHelp, setShowLocationHelp] = useState(false);

  const [selfieCameraOpen, setSelfieCameraOpen] = useState(false);
  const [selfieBlob, setSelfieBlob] = useState<Blob | null>(null);
  const [selfieDataUrl, setSelfieDataUrl] = useState<string | null>(null);

  const [shopCameraOpen, setShopCameraOpen] = useState(false);
  const [shopPhotoBlob, setShopPhotoBlob] = useState<Blob | null>(null);
  const [shopPhotoDataUrl, setShopPhotoDataUrl] = useState<string | null>(null);
  const [shopPhotoCoords, setShopPhotoCoords] = useState<{ lat: number; lng: number } | null>(
    null,
  );
  const [shopPhotoGpsDistance, setShopPhotoGpsDistance] = useState(0);

  useEffect(() => {
    void isReferralEnabled().then(setReferralEnabled);
    const stored = getReferralCode();
    if (stored) setReferralCodeInput(stored);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRegCategoriesLoading(true);
    void supabase
      .from("categories")
      .select("id, label, emoji, service_mode")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("load registration categories", error);
          setRegCategories([]);
        } else {
          setRegCategories((data ?? []) as RegCategoryRow[]);
        }
        setRegCategoriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allRegCategories = useMemo(() => {
    const map = new Map<string, RegCategoryRow>();
    for (const c of [...regCategories, ...extraRegCategories]) {
      map.set(c.id, c);
    }
    return [...map.values()];
  }, [regCategories, extraRegCategories]);

  const primaryCategory =
    selectedCategoryIds.length > 0
      ? allRegCategories.find((c) => c.id === selectedCategoryIds[0]) ?? null
      : null;
  const effectiveCategory =
    primaryCategory?.label ?? pendingNewCategoryCreate?.category_name ?? "";

  const nameOk = name.trim().length > 1 && !looksLikeGibberish(name);
  const shopOk = shopName.trim().length > 1 && !looksLikeGibberish(shopName);
  const homeShopInvalid =
    baseType === "home" &&
    shopName.trim().length > 0 &&
    (shopName.trim().length <= 1 || looksLikeGibberish(shopName));
  const shopFieldOk =
    baseType === "shop" ? shopOk : baseType === "home" ? !homeShopInvalid : true;
  const categoryOk =
    (selectedCategoryIds.length > 0 && effectiveCategory.length > 1) ||
    pendingNewCategoryCreate != null;
  const modesOk = pendingNewCategoryCreate
    ? pendingCategoryModes.length > 0
    : allCategoriesHaveModes(selectedCategoryIds, categoryModesById);
  const gpsOk = coords != null;
  const selfieCaptured = selfieBlob != null;
  const shopPhotoCaptured = shopPhotoBlob != null;
  const reachFlags = reachChoice ? reachFlagsFromChoice(reachChoice) : null;
  const needsRadius = reachFlags?.serves_at_customer_place === true;
  const radiusOk = !needsRadius || serviceRadiusKm != null;

  const phoneOk = isValidPhone(phone);
  const upiFmtOk = isValidUpi(upi);

  const stepAReady =
    baseType !== "" && nameOk && phoneOk && upiFmtOk && gpsOk && selfieCaptured;
  const stepBReady =
    categoryOk &&
    shopFieldOk &&
    reachChoice !== "" &&
    radiusOk &&
    modesOk &&
    shopPhotoCaptured;

  const detectLocation = (opts?: { silent?: boolean }): Promise<{ lat: number; lng: number } | null> => {
    return new Promise((resolve) => {
      if (!("geolocation" in navigator)) {
        if (!opts?.silent) toast.error(s.vendor_geo_not_supported);
        setLocationInlineError(s.vendor_geo_not_supported);
        resolve(null);
        return;
      }
      setLocating(true);
      setLocationInlineError(null);
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const c = { lat: p.coords.latitude, lng: p.coords.longitude };
          setCoords(c);
          setLocating(false);
          setLocationInlineError(null);
          setShowLocationHelp(false);
          if (!opts?.silent) toast.success(s.vendor_location_captured);
          resolve(c);
        },
        (err) => {
          setLocating(false);
          const code = (err as GeolocationPositionError | undefined)?.code;
          let msg: string = s.vendor_location_failed;
          if (code === 1) msg = s.vendor_location_error_permission_denied;
          if (code === 2) msg = s.vendor_location_error_unavailable;
          if (code === 3) msg = s.vendor_location_error_timeout;
          setLocationInlineError(msg);
          setShowLocationHelp(true);
          if (!opts?.silent) toast.error(msg);
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
      );
    });
  };

  useEffect(() => {
    if (baseType !== "none") return;
    void detectLocation({ silent: true });
  }, [baseType]);

  const setCategoryModes = (categoryId: string, modes: AvailabilityMode[]) => {
    setCategoryModesById((prev) => ({ ...prev, [categoryId]: modes }));
  };

  const tryStepANext = () => {
    if (baseType === "") {
      showRegistrationGuidanceToast(s.reg_toast_missing_base_type);
      return;
    }
    if (!nameOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_name);
      return;
    }
    if (!phoneOk) {
      showRegistrationGuidanceToast(s.vendor_phone_invalid_body);
      return;
    }
    if (!upiFmtOk) {
      showRegistrationGuidanceToast(s.vendor_upi_id_format_invalid);
      return;
    }
    if (!gpsOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_gps);
      return;
    }
    if (!selfieCaptured) {
      showRegistrationGuidanceToast(s.vendor_selfie_capture);
      return;
    }
    setRegPage(2);
  };

  const selectCategoryFromSuggestion = (
    id: string,
    label: string,
    emoji: string | null | undefined,
    serviceModeValue: string,
  ) => {
    setExtraRegCategories((prev) => {
      if (prev.some((c) => c.id === id)) return prev;
      return [
        ...prev,
        { id, label, emoji: emoji ?? "✨", service_mode: serviceModeValue },
      ];
    });
    setSelectedCategoryIds((prev) => {
      if (prev.includes(id)) return prev;
      if (prev.length >= MAX_REG_CATEGORIES) return prev;
      return [...prev, id];
    });
    setCategorySuggestion(null);
    setPendingNewCategoryCreate(null);
    setPendingCategoryModes([]);
    setShowManualCategories(false);
  };

  const handleFindCategory = async () => {
    const desc = businessDescription.trim();
    if (desc.length < 3) {
      toast.error(s.vendor_specify_hint);
      return;
    }
    setCategorySuggesting(true);
    setCategorySuggestion(null);
    setPendingNewCategoryCreate(null);
    try {
      const result = await withNetworkRetry(
        async () => {
          const r = await invokeSuggestCategory({ description: desc });
          if (!r.success && r.error && isNetworkFailure({ message: r.error })) {
            throw new Error(r.error);
          }
          return r;
        },
        {
          onRetrying: () => showNetworkRetryingToast({ retrying: s.network_retrying }),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      setCategorySuggesting(false);
      if (!result.success) {
        setShowManualCategories(true);
        toast.error(result.error ?? s.vendor_understanding);
        return;
      }
      setCategorySuggestion(result);
      if (result.outcome === "new_suggested" || result.outcome === "medium_new") {
        setPendingNewCategoryCreate({
          description: desc,
          category_name: result.category_name ?? desc,
          service_mode: result.service_mode ?? "help",
        });
        setSelectedCategoryIds([]);
        setPendingCategoryModes([]);
      }
    } catch {
      dismissNetworkRetryingToast();
      setCategorySuggesting(false);
    }
  };

  const confirmNewCategorySuggestion = () => {
    if (!categorySuggestion?.category_name) return;
    setPendingNewCategoryCreate({
      description: businessDescription.trim(),
      category_name: categorySuggestion.category_name,
      service_mode: categorySuggestion.service_mode ?? "help",
    });
    setSelectedCategoryIds([]);
    setPendingCategoryModes([]);
    setCategorySuggestion(null);
    toast.success(s.category_suggest_new(categorySuggestion.category_name));
  };

  const toggleRegCategory = (categoryId: string) => {
    setPendingNewCategoryCreate(null);
    setPendingCategoryModes([]);
    setSelectedCategoryIds((prev) => {
      if (prev.includes(categoryId)) {
        setCategoryModesById((m) => {
          const next = { ...m };
          delete next[categoryId];
          return next;
        });
        return prev.filter((id) => id !== categoryId);
      }
      if (prev.length >= MAX_REG_CATEGORIES) return prev;
      return [...prev, categoryId];
    });
  };

  const handleUpiQrFile = async (file: File) => {
    setUpiQrUploading(true);
    setUpiQrPayeeId(null);
    const path = `upi-qr/${Date.now()}_${file.name}`;
    const { error: upErr } = await supabase.storage.from("vendor-docs").upload(path, file, {
      contentType: file.type || "image/jpeg",
      upsert: true,
    });
    if (upErr) {
      toast.error("QR upload failed");
      setUpiQrUploading(false);
      return;
    }
    const { data: pub } = supabase.storage.from("vendor-docs").getPublicUrl(path);
    setUpiQrUrl(pub.publicUrl);
    const payeeId = await decodeUpiPayeeIdFromImageFile(file);
    setUpiQrPayeeId(payeeId);
    setUpiQrUploading(false);
  };

  const handleSelfieCapture = (shot: CapturedShot) => {
    setSelfieCameraOpen(false);
    setSelfieBlob(shot.blob);
    setSelfieDataUrl(shot.dataUrl);
    toast.success(s.vendor_selfie_captured);
  };

  const handleShopPhotoCapture = (shot: CapturedShot) => {
    setShopCameraOpen(false);
    if (coords) {
      const meters = distanceMeters(coords, shot.coords);
      if (meters > GPS_MATCH_TOLERANCE_M) {
        toast.error(s.vendor_mismatch_title, {
          description: s.vendor_mismatch_distance(Math.round(meters), GPS_MATCH_TOLERANCE_M),
        });
        return;
      }
      setShopPhotoGpsDistance(Math.round(meters));
    } else {
      setShopPhotoGpsDistance(0);
    }
    setShopPhotoBlob(shot.blob);
    setShopPhotoDataUrl(shot.dataUrl);
    setShopPhotoCoords(shot.coords);
    toast.success(s.vendor_photo_verified);
  };

  const register = async (e: FormEvent) => {
    e.preventDefault();
    if (!stepAReady || !stepBReady || !reachFlags || !selfieBlob || !shopPhotoBlob) return;

    if (baseType === "shop" && !shopOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_shop_name);
      return;
    }
    if (!categoryOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_categories);
      return;
    }
    if (!radiusOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_radius);
      return;
    }
    if (!modesOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_availability);
      return;
    }

    setLoading(true);
    setParentError(null);

    const vendorType = baseTypeToVendorType(baseType);
    if (!vendorType) {
      setLoading(false);
      return;
    }

    const resolvedShopName = resolveRegistrationShopName(baseType, name, shopName);
    // Pending-only flow needs a temporary category row; attach_pending replaces it after create.
    const categoryIdsForRpc =
      selectedCategoryIds.length > 0
        ? selectedCategoryIds
        : pendingNewCategoryCreate && regCategories[0]
          ? [regCategories[0].id]
          : [];
    if (categoryIdsForRpc.length === 0) {
      setLoading(false);
      showRegistrationGuidanceToast(s.reg_toast_missing_categories);
      return;
    }

    const modesByIdForRpc = pendingNewCategoryCreate
      ? { [categoryIdsForRpc[0]]: pendingCategoryModes }
      : buildCategoryModesPayload(selectedCategoryIds, categoryModesById);

    const categoryServiceModes = categoryIdsForRpc.map((id) => {
      const cat = allRegCategories.find((c) => c.id === id);
      const modes = modesByIdForRpc[id] ?? [];
      return pickPrimaryAvailabilityMode(modes, cat?.service_mode);
    });

    const primaryServiceMode = pickPrimaryAvailabilityMode(
      modesByIdForRpc[categoryIdsForRpc[0]],
      allRegCategories.find((c) => c.id === categoryIdsForRpc[0])?.service_mode,
    );
    const availabilityModesUnion = unionAvailabilityModes(modesByIdForRpc);

    const registerResult = await invokeRegisterVendor({
      name: name.trim(),
      shop_name: resolvedShopName,
      category: effectiveCategory,
      phone: phone.trim(),
      upi_id: upi.trim(),
      upi_qr_url: upiQrUrl || null,
      upi_qr_payee_id: upiQrPayeeId,
      service_mode: primaryServiceMode,
      vendor_type: vendorType,
      vendor_note: vendorNote.trim() || null,
      latitude: coords!.lat,
      longitude: coords!.lng,
      referral_code: referralCodeFromPhone(phone.trim()),
      profile_status: "complete",
      category_ids: categoryIdsForRpc,
      category_service_modes: categoryServiceModes,
      category_modes: modesByIdForRpc,
      base_type: baseType,
      serves_at_vendor_place: reachFlags.serves_at_vendor_place,
      serves_at_customer_place: reachFlags.serves_at_customer_place,
      service_radius_km: serviceRadiusKm ?? 15,
      availability_modes: availabilityModesUnion,
    });

    if (registerResult.ok === false) {
      setLoading(false);
      if (isDuplicateVendorPhoneError({ code: registerResult.code, message: registerResult.error })) {
        onDuplicatePhone();
        return;
      }
      if (isRateLimitedError({ code: registerResult.code, message: registerResult.error })) {
        toast.error(s.vendor_registration_rate_limited);
        setParentError(null);
        return;
      }
      setParentError(registerResult.error);
      return;
    }

    const newVendorId = registerResult.vendorId;
    let resolvedPrimaryServiceMode = primaryServiceMode;
    let resolvedCategoryLabel = effectiveCategory;
    let resolvedCategoryId =
      selectedCategoryIds.length > 0 ? selectedCategoryIds[0] : null;

    if (pendingNewCategoryCreate) {
      const created = await invokeSuggestCategory({
        description: pendingNewCategoryCreate.description,
        vendor_id: newVendorId,
        create_pending: true,
      });
      if (created.success && created.category_id) {
        resolvedPrimaryServiceMode = pickPrimaryAvailabilityMode(
          pendingCategoryModes,
          created.service_mode ?? pendingNewCategoryCreate.service_mode,
        );
        resolvedCategoryLabel =
          created.category_name ?? pendingNewCategoryCreate.category_name;
        resolvedCategoryId = created.category_id;

        const attachResult = await invokeAttachPendingCategory({
          vendorId: newVendorId,
          vendorPhone: phone.trim(),
          categoryId: created.category_id,
          serviceMode: resolvedPrimaryServiceMode,
          modes: pendingCategoryModes,
        });
        if (attachResult.ok === false) {
          console.error("attach_pending_category failed", attachResult.error);
        } else {
          await patchVendorOwn(newVendorId, phone.trim(), {
            category: resolvedCategoryLabel,
            service_mode: resolvedPrimaryServiceMode,
          });
        }
      }
    }

    try {
      const selfiePath = `${newVendorId}/selfie.jpg`;
      const { error: selfieUpErr } = await supabase.storage
        .from(VENDOR_SELFIES_BUCKET)
        .upload(selfiePath, selfieBlob, { contentType: "image/jpeg", upsert: true });
      if (!selfieUpErr) {
        const { data: selfiePub } = supabase.storage
          .from(VENDOR_SELFIES_BUCKET)
          .getPublicUrl(selfiePath);
        await patchVendorOwn(newVendorId, phone.trim(), {
          photo_selfie: selfiePub.publicUrl,
        });
      } else {
        console.error("selfie upload failed", selfieUpErr);
      }
    } catch (err) {
      console.error("selfie upload failed", err);
    }

    if (resolvedCategoryId && shopPhotoBlob) {
      try {
        const shopPath = `${newVendorId}/${resolvedCategoryId}/${Date.now()}.jpg`;
        const { error: shopUpErr } = await supabase.storage
          .from(SHOP_PHOTOS_BUCKET)
          .upload(shopPath, shopPhotoBlob, { contentType: "image/jpeg", upsert: true });
        if (!shopUpErr) {
          const { data: shopPub } = supabase.storage
            .from(SHOP_PHOTOS_BUCKET)
            .getPublicUrl(shopPath);
          const hasAccountCoords = coords != null;
          await supabase.rpc("vendor_submit_category_shop_photo", {
            p_vendor_id: newVendorId,
            p_vendor_phone: phone.trim(),
            p_category_id: resolvedCategoryId,
            p_shop_photo_url: shopPub.publicUrl,
            p_gps_match_distance: shopPhotoGpsDistance,
            p_set_account_lat: hasAccountCoords ? null : shopPhotoCoords?.lat ?? null,
            p_set_account_lng: hasAccountCoords ? null : shopPhotoCoords?.lng ?? null,
          });
        } else {
          console.error("shop photo upload failed", shopUpErr);
        }
      } catch (err) {
        console.error("shop photo upload failed", err);
      }
    }

    const filledReasons = cancelReasons.map((r) => r.trim());
    if (resolvedCategoryId && filledReasons.some((r) => r.length > 0)) {
      const { error: reasonsErr } = await supabase.rpc(
        "vendor_upsert_category_cancel_reasons",
        {
          p_vendor_id: newVendorId,
          p_vendor_phone: phone.trim(),
          p_category_id: resolvedCategoryId,
          p_reasons: filledReasons,
        },
      );
      if (reasonsErr) {
        console.error("cancel reasons upsert failed", reasonsErr);
      }
    }

    if (resolvedCategoryId) {
      const noteTrim = vendorNote.trim();
      if (noteTrim.length > 0) {
        const patch: Record<string, unknown> = {
          serves_at_vendor_place: reachFlags.serves_at_vendor_place,
          serves_at_customer_place: reachFlags.serves_at_customer_place,
          service_radius_km: serviceRadiusKm,
          vendor_note: noteTrim,
          // shop_name is the single brand source; brand_name is synced server-side.
        };
        const { error: profileErr } = await supabase.rpc("vendor_update_category_profile", {
          p_vendor_id: newVendorId,
          p_vendor_phone: phone.trim(),
          p_category_id: resolvedCategoryId,
          p_patch: patch,
        });
        if (profileErr) {
          console.error("category profile update failed", profileErr);
        }
      }
    }

    void invokeNotifyAdmin(
      s.vendor_admin_notify_title,
      `${name.trim()} — ${resolvedCategoryLabel} (${resolvedPrimaryServiceMode})`,
      {
        type: "new_vendor",
        route: "vendor",
        route_params: { vendor_id: newVendorId },
      },
    );

    if (referralCodeInput.trim()) {
      try {
        const referralResp = await fetch(`${SUPABASE_URL}/functions/v1/process-vendor-referral`, {
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
        const referralBody = (await referralResp.json()) as {
          success?: boolean;
          reason?: string;
        };
        if (referralBody.reason === "already_referred") {
          toast.error(s.referral_already_used);
        } else if (referralResp.ok && referralBody.success) {
          toast.success(s.referral_code_applied);
        } else {
          toast.error(s.referral_code_invalid);
        }
      } catch {
        toast.error(s.referral_code_invalid);
      }
    }

    setLoading(false);
    toast.success(s.vendor_welcome_title, { description: s.vendor_welcome_body });
    onRegistered(newVendorId, phone.trim());
  };

  const upiFormatError =
    upiBlurred && upi.trim().length > 0 && !upiFmtOk ? s.vendor_upi_id_format_invalid : undefined;

  return (
    <form onSubmit={register} className="space-y-4 animate-fade-up">
      <p className="text-xs text-center text-muted-foreground uppercase tracking-wider">
        {s.reg_wizard_step(regPage, 2)}
      </p>
      <p className="text-sm text-center font-semibold text-foreground">
        {regPage === 1 ? s.reg_step_account : s.reg_step_business}
      </p>

      {regPage === 1 && (
        <>
          <RegField
            label={s.vendor_your_name}
            value={name}
            onChange={setName}
            placeholder={s.vendor_name_placeholder}
            required
          />

          <RegField
            label={s.vendor_phone_label}
            value={phone}
            onChange={setPhone}
            placeholder={s.vendor_phone_placeholder}
            required
          />
          <RegField
            label={s.vendor_upi_label}
            value={upi}
            onChange={setUpi}
            onBlur={() => setUpiBlurred(true)}
            placeholder={s.vendor_upi_placeholder}
            required
            error={upiFormatError}
          />
          <div>
            <label className="text-xs text-muted-foreground">{s.vendor_upi_qr_label}</label>
            <input
              ref={upiQrInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpiQrFile(f);
              }}
            />
            <button
              type="button"
              disabled={upiQrUploading}
              onClick={() => upiQrInputRef.current?.click()}
              className="mt-1 w-full rounded-xl border border-border py-2.5 text-sm"
            >
              {upiQrUploading ? "Uploading..." : s.vendor_upi_qr_hint}
            </button>
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.reg_where_work_from} *
            </label>
            <div className="mt-2 grid grid-cols-1 gap-2">
              <ChoiceCard
                selected={baseType === "shop"}
                onClick={() => setBaseType("shop")}
                emoji="🏪"
                title={s.reg_base_shop}
                desc={s.reg_base_shop_desc}
              />
              <ChoiceCard
                selected={baseType === "home"}
                onClick={() => setBaseType("home")}
                emoji="🏠"
                title={s.reg_base_home}
                desc={s.reg_base_home_desc}
              />
              <ChoiceCard
                selected={baseType === "none"}
                onClick={() => setBaseType("none")}
                emoji="🚫"
                title={s.reg_base_none}
                desc={s.reg_base_none_desc}
              />
            </div>
          </div>

          {baseType !== "" && baseType !== "none" && (
            <>
              <p className="text-[11px] text-muted-foreground text-center px-2">
                {baseType === "shop" ? s.reg_gps_public_hint : s.reg_gps_private_hint}
              </p>
              <button
                type="button"
                onClick={() => void detectLocation()}
                className={cn(
                  "w-full rounded-xl border-2 py-3.5 flex items-center justify-center gap-2 font-semibold",
                  coords ? "border-secondary text-secondary bg-secondary/5" : "border-border",
                )}
              >
                {locating ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
                {coords
                  ? `${s.vendor_location_set} (${coords.lat.toFixed(3)}, ${coords.lng.toFixed(3)})`
                  : s.vendor_capture_location}
              </button>
              {locationInlineError && (
                <p className="text-xs text-destructive text-center">{locationInlineError}</p>
              )}
              <button
                type="button"
                onClick={() => setShowLocationHelp((v) => !v)}
                className="text-xs text-muted-foreground underline w-full"
              >
                {s.vendor_location_help_title}
              </button>
              {showLocationHelp && (
                <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
                  <p>1. {s.vendor_location_help_step1}</p>
                  <p>2. {s.vendor_location_help_step2}</p>
                  <p>3. {s.vendor_location_help_step3}</p>
                </div>
              )}
            </>
          )}
          {baseType === "none" && (
            <p className="text-[11px] text-muted-foreground text-center px-2">
              {locating ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {s.vendor_visiting_location_hint}
                </span>
              ) : coords ? (
                s.reg_gps_silent_hint
              ) : (
                s.vendor_visiting_location_hint
              )}
            </p>
          )}

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.vendor_selfie_title} *
            </label>
            <p className="mt-1 text-xs text-muted-foreground">{s.vendor_selfie_subtitle}</p>
            <button
              type="button"
              data-testid="reg-selfie-capture"
              onClick={() => setSelfieCameraOpen(true)}
              className={cn(
                "mt-2 w-full rounded-xl border-2 py-3.5 flex items-center justify-center gap-2 font-semibold",
                selfieCaptured
                  ? "border-secondary text-secondary bg-secondary/5"
                  : "border-border",
              )}
            >
              <Camera className="h-4 w-4" />
              {selfieCaptured ? s.vendor_selfie_reshoot : s.vendor_selfie_capture}
            </button>
            {selfieDataUrl && (
              <img
                src={selfieDataUrl}
                alt={s.vendor_selfie_title}
                className="mt-2 w-full max-w-xs mx-auto rounded-xl border border-border"
              />
            )}
          </div>

          {referralEnabled && (
            <RegField
              label={s.vendor_referralCodeLabel}
              value={referralCodeInput}
              onChange={(v) => setReferralCodeInput(v.toUpperCase().trim())}
              placeholder={s.vendor_referralCodePlaceholder}
            />
          )}

          <button
            type="button"
            onClick={tryStepANext}
            className={cn(
              "w-full rounded-2xl bg-primary text-primary-foreground py-4 font-semibold",
              !stepAReady && "opacity-50",
            )}
          >
            {s.reg_wizard_next}
          </button>
        </>
      )}

      {regPage === 2 && (
        <>
          <p className="text-xs text-muted-foreground text-center">{s.reg_account_done_hint}</p>

          <div>
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {s.vendor_categories_label} *
              </label>
              {selectedCategoryIds.length > 0 && (
                <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5 text-brand" />
                  {selectedCategoryIds
                    .map((id) => getLabel(allRegCategories.find((c) => c.id === id)?.label ?? ""))
                    .filter(Boolean)
                    .join(", ")}
                </span>
              )}
              {pendingNewCategoryCreate && selectedCategoryIds.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  {pendingNewCategoryCreate.category_name}
                </span>
              )}
            </div>
            <Textarea
              value={businessDescription}
              onChange={(e) => setBusinessDescription(e.target.value)}
              placeholder={s.category_describe_placeholder}
              className="mt-2 min-h-[72px] resize-none"
            />
            <button
              type="button"
              onClick={() => void handleFindCategory()}
              disabled={categorySuggesting || businessDescription.trim().length < 3}
              className="mt-2 w-full rounded-xl bg-brand px-3 py-2.5 text-sm font-semibold text-brand-foreground disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {categorySuggesting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {s.category_finding}
                </>
              ) : (
                s.category_findButton
              )}
            </button>
            {categorySuggestion?.outcome === "high_existing" && categorySuggestion.category_id && (
              <div className="mt-3 rounded-2xl border border-brand/40 bg-brand/10 p-3 space-y-2">
                <p className="text-sm font-semibold">
                  {s.category_suggestion(categorySuggestion.category_name ?? "")}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    selectCategoryFromSuggestion(
                      categorySuggestion.category_id!,
                      categorySuggestion.category_name ?? "",
                      categorySuggestion.emoji,
                      categorySuggestion.service_mode ?? "help",
                    )
                  }
                  className="w-full rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-brand-foreground"
                >
                  {s.category_confirm}
                </button>
              </div>
            )}
            {(categorySuggestion?.outcome === "new_suggested" ||
              categorySuggestion?.outcome === "medium_new") && (
              <div className="mt-3 rounded-2xl border border-border bg-muted/40 p-3">
                <button
                  type="button"
                  onClick={confirmNewCategorySuggestion}
                  className="w-full rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-brand-foreground"
                >
                  {s.category_confirm}
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => setShowManualCategories((v) => !v)}
              className="mt-3 text-xs font-medium text-muted-foreground underline"
            >
              {s.category_browseManual}
            </button>
            {showManualCategories && (
              <div className="mt-2 flex flex-wrap gap-2">
                {regCategoriesLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  allRegCategories.map((cat) => {
                    const selected = selectedCategoryIds.includes(cat.id);
                    const atMax =
                      !selected && selectedCategoryIds.length >= MAX_REG_CATEGORIES;
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        disabled={atMax}
                        onClick={() => toggleRegCategory(cat.id)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium",
                          selected
                            ? "border-primary bg-primary/20 ring-1 ring-primary/30"
                            : "border-border bg-card",
                          atMax && "opacity-40 cursor-not-allowed",
                        )}
                      >
                        {cat.emoji} {getLabel(cat.label)}
                        <span className="text-[10px] text-muted-foreground">
                          {categoryServiceModeChipLabel(cat.service_mode, s)}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {baseType === "shop" ? (
            <RegField
              label={s.vendor_shop_name}
              value={shopName}
              onChange={setShopName}
              placeholder={s.vendor_shop_placeholder}
              required
              error={shopName.length > 0 && !shopOk ? s.vendor_specify_hint : undefined}
            />
          ) : (
            <RegField
              label={s.my_business_category_brand}
              value={shopName}
              onChange={setShopName}
              placeholder={s.vendor_brand_placeholder}
              error={homeShopInvalid ? s.vendor_specify_hint : undefined}
            />
          )}

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.reg_where_reach_you} *
            </label>
            <div className="mt-2 grid grid-cols-1 gap-2">
              <ChoiceCard
                selected={reachChoice === "customer"}
                onClick={() => setReachChoice("customer")}
                emoji="👤"
                title={s.reg_reach_customer}
                desc={s.reg_reach_customer_desc}
              />
              <ChoiceCard
                selected={reachChoice === "vendor"}
                onClick={() => setReachChoice("vendor")}
                emoji="🚗"
                title={s.reg_reach_vendor}
                desc={s.reg_reach_vendor_desc}
              />
              <ChoiceCard
                selected={reachChoice === "both"}
                onClick={() => setReachChoice("both")}
                emoji="🔁"
                title={s.reg_reach_both}
                desc={s.reg_reach_both_desc}
              />
            </div>
          </div>

          {needsRadius && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {s.vendor_radius_label} *
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{s.vendor_radius_hint}</p>
              <div className="mt-3">
                <ServiceRadiusChips
                  value={serviceRadiusKm}
                  onChange={(km: ServiceRadiusKm) => setServiceRadiusKm(km)}
                />
              </div>
            </div>
          )}

          {(pendingNewCategoryCreate && selectedCategoryIds.length === 0) ||
          selectedCategoryIds.length > 0 ? (
            pendingNewCategoryCreate && selectedCategoryIds.length === 0 ? (
              <CategoryAvailabilityModeSelector
                variant="cards"
                label={s.reg_when_available}
                required
                testIdPrefix="reg-avail"
                value={pendingCategoryModes}
                onChange={setPendingCategoryModes}
              />
            ) : selectedCategoryIds.length === 1 ? (
              <CategoryAvailabilityModeSelector
                variant="cards"
                label={s.reg_when_available}
                required
                testIdPrefix="reg-avail"
                value={categoryModesById[selectedCategoryIds[0]] ?? []}
                onChange={(modes) => setCategoryModes(selectedCategoryIds[0], modes)}
              />
            ) : (
              <div className="space-y-3">
                {selectedCategoryIds.map((catId) => {
                  const cat = allRegCategories.find((c) => c.id === catId);
                  if (!cat) return null;
                  return (
                    <div
                      key={catId}
                      className="rounded-2xl border border-surface-border bg-muted/20 p-3"
                    >
                      <p className="text-sm font-semibold text-foreground mb-2">
                        {cat.emoji} {getLabel(cat.label)}
                      </p>
                      <CategoryAvailabilityModeSelector
                        variant="cards"
                        label={s.reg_category_when_available}
                        required
                        testIdPrefix={`reg-avail-${cat.id}`}
                        value={categoryModesById[catId] ?? []}
                        onChange={(modes) => setCategoryModes(catId, modes)}
                      />
                    </div>
                  );
                })}
              </div>
            )
          ) : null}

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.cancelReasons}
            </label>
            <p className="mt-1 text-xs text-muted-foreground">{s.cancelReasonsSubtitle}</p>
            <div className="mt-2 space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <input
                  key={i}
                  type="text"
                  value={cancelReasons[i]}
                  onChange={(e) => {
                    const next = [...cancelReasons];
                    next[i] = e.target.value.slice(0, 60);
                    setCancelReasons(next);
                  }}
                  maxLength={60}
                  placeholder={`${s.rejectionReasonField} ${i + 1}`}
                  className="w-full bg-card border border-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.vendor_note_label}
            </label>
            <textarea
              value={vendorNote}
              onChange={(e) => setVendorNote(e.target.value.slice(0, 100))}
              rows={2}
              placeholder={s.vendor_note_placeholder}
              className="mt-1 w-full bg-card border border-border rounded-xl px-4 py-3 text-sm resize-none"
            />
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.business_photo_verify} *
            </label>
            <p className="mt-1 text-xs text-muted-foreground">{s.business_photo_verify_hint}</p>
            <button
              type="button"
              data-testid="reg-shop-photo-capture"
              onClick={() => setShopCameraOpen(true)}
              className={cn(
                "mt-2 w-full rounded-xl border-2 py-3.5 flex items-center justify-center gap-2 font-semibold",
                shopPhotoCaptured
                  ? "border-secondary text-secondary bg-secondary/5"
                  : "border-border",
              )}
            >
              <Camera className="h-4 w-4" />
              {shopPhotoCaptured ? s.vendor_reshoot : s.my_business_verify_now}
            </button>
            {shopPhotoDataUrl && (
              <img
                src={shopPhotoDataUrl}
                alt={s.vendor_captured_shop}
                className="mt-2 w-full rounded-xl border border-border"
              />
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setRegPage(1)}
              className="flex-1 rounded-2xl border border-border py-4 font-semibold inline-flex items-center justify-center gap-1"
            >
              <ChevronLeft className="h-4 w-4" />
              {s.reg_wizard_back}
            </button>
            <button
              type="submit"
              disabled={!stepBReady || loading}
              className="flex-[2] rounded-2xl bg-primary text-primary-foreground py-4 font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
              {s.vendor_register_btn}
            </button>
          </div>
        </>
      )}

      <LiveCamera
        open={selfieCameraOpen}
        onClose={() => setSelfieCameraOpen(false)}
        onCapture={handleSelfieCapture}
        facing="front"
        requireLocation={false}
      />
      <LiveCamera
        open={shopCameraOpen}
        onClose={() => setShopCameraOpen(false)}
        onCapture={handleShopPhotoCapture}
      />
    </form>
  );
}
