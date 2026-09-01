import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Camera, CheckCircle2, ChevronLeft, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import { ServiceRadiusChips } from "@/components/ServiceRadiusChips";
import { CategoryAvailabilityModeSelector } from "@/components/vendor/CategoryAvailabilityModeSelector";
import { LiveCamera, type CapturedShot } from "@/components/LiveCamera";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";
import { getReferralCode,
  isReferralEnabled,
  referralCodeFromPhone,
} from "@/lib/referral";
import { OTP_ENABLED } from "@/lib/phoneOtpEnabled";
import { PhoneOtpVerification } from "@/components/PhoneOtpVerification";
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
  SHOP_PHOTOS_BUCKET,
  VENDOR_SELFIES_BUCKET,
  distanceMeters,
  type CategorySuggestionResult,
  type RegisterVendorResult,
} from "@/lib/supabase";
import {
  GPS_MATCH_FAILS_BEFORE_SOFT_REVIEW,
  evaluateGpsMatch,
  logGpsMatchFailure,
  readGeolocationAccuracy,
  type GpsPoint,
} from "@/lib/gpsMatch";
import { patchVendorOwn } from "@/lib/vendorPatch";
import {
  withNetworkRetry,
  withTimedRetry,
  applyAbortSignal,
  isNetworkFailure,
  isNetworkTimeout,
  NetworkExhaustedError,
  throwOnSupabaseNetworkError,
} from "@/lib/withNetworkRetry";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  dismissNetworkRetryingToast,
  showNetworkRetryingToast,
  showNetworkFailedToast,
} from "@/lib/networkToast";
import { captureError } from "@/lib/sentry";
import { triggerProactiveCategoryAliasesForCategories } from "@/lib/proactiveCategoryAliases";
import { triggerCategoryModeConfidenceCheck } from "@/lib/categoryModeConfidence";
import { safeRandomUUID } from "@/lib/safeRandomUUID";
import {
  allCategoriesHaveModes,
  buildCategoryModesPayload,
  ensureCatalogBaseModes,
  initialModesForCatalog,
  normalizeAvailabilityModes,
  pickPrimaryAvailabilityMode,
  resolveCatalogServiceMode,
  unionAvailabilityModes,
} from "@/lib/categoryAvailabilityModes";
import {
  type AvailabilityMode,
  type BaseTypeValue,
  type ReachChoiceValue,
  baseTypeToVendorType,
  looksLikeGibberish,
  reachFlagsFromChoice,
  resolveRegistrationShopName,
  showRegistrationGuidanceToast,
} from "@/lib/vendorRegistration";
import type { ServiceRadiusKm } from "@/lib/serviceRadius";
import { decodeUpiPayeeIdFromImageFile } from "@/lib/upiQrDecode";
import {
  licenseFieldHasValue,
  wizardLicenseFields,
  type LicenseType,
} from "@/lib/vendorLicenses";

type RegCategoryRow = {
  id: string;
  label: string;
  emoji: string;
  service_mode: string;
  license_type?: string | null;
  license_review_status?: string | null;
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

function licenseTypeLabel(
  type: string,
  s: {
    reg_license_type_fssai: string;
    reg_license_type_drug_license: string;
    reg_license_type_medical_registration: string;
    reg_license_type_shop_establishment: string;
    reg_license_type_trade_license: string;
  },
  displayName?: string,
): string {
  if (displayName?.trim()) return displayName.trim();
  switch (type as LicenseType) {
    case "fssai":
      return s.reg_license_type_fssai;
    case "drug_license":
      return s.reg_license_type_drug_license;
    case "medical_registration":
      return s.reg_license_type_medical_registration;
    case "shop_establishment":
      return s.reg_license_type_shop_establishment;
    case "trade_license":
      return s.reg_license_type_trade_license;
    default:
      return type;
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
      <p className="mt-1 text-xs text-muted-foreground leading-snug">{desc}</p>
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

  const [regPage, setRegPage] = useState<1 | 2 | 3>(1);
  const [loading, setLoading] = useState(false);
  const [licenseDrafts, setLicenseDrafts] = useState<
    Record<string, { number: string; file: File | null; preview: string | null }>
  >({});
  const licensePhotoInputRef = useRef<HTMLInputElement>(null);
  const licensePhotoTargetRef = useRef<string | null>(null);

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
  const [stepAOtpOpen, setStepAOtpOpen] = useState(false);
  const [otpVerifiedPhone, setOtpVerifiedPhone] = useState<string | null>(null);
  const [upi, setUpi] = useState("");
  const [upiBlurred, setUpiBlurred] = useState(false);
  const [upiQrUrl, setUpiQrUrl] = useState("");
  const [upiQrPayeeId, setUpiQrPayeeId] = useState<string | null>(null);
  const [upiQrUploading, setUpiQrUploading] = useState(false);
  const upiQrInputRef = useRef<HTMLInputElement>(null);
  const [vendorNote, setVendorNote] = useState("");
  const [referralCodeInput, setReferralCodeInput] = useState("");
  const [referralEnabled, setReferralEnabled] = useState(false);

  const [coords, setCoords] = useState<GpsPoint | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationInlineError, setLocationInlineError] = useState<string | null>(null);
  const [showLocationHelp, setShowLocationHelp] = useState(false);

  const [selfieCameraOpen, setSelfieCameraOpen] = useState(false);
  const [selfieBlob, setSelfieBlob] = useState<Blob | null>(null);
  const [selfieDataUrl, setSelfieDataUrl] = useState<string | null>(null);

  const [shopCameraOpen, setShopCameraOpen] = useState(false);
  const [shopPhotoBlob, setShopPhotoBlob] = useState<Blob | null>(null);
  const [shopPhotoDataUrl, setShopPhotoDataUrl] = useState<string | null>(null);
  const [shopPhotoCoords, setShopPhotoCoords] = useState<GpsPoint | null>(null);
  const [shopPhotoGpsDistance, setShopPhotoGpsDistance] = useState(0);
  const [shopPhotoLocationAccuracy, setShopPhotoLocationAccuracy] = useState<number | null>(
    null,
  );
  const [shopPhotoAccuracy, setShopPhotoAccuracy] = useState<number | null>(null);
  const [shopPhotoPendingLocationReview, setShopPhotoPendingLocationReview] = useState(false);
  const [gpsMatchFailCount, setGpsMatchFailCount] = useState(0);
  const [lastFailedShopShot, setLastFailedShopShot] = useState<CapturedShot | null>(null);
  const gpsSessionKeyRef = useRef(`reg-${safeRandomUUID()}`);

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
      .select("id, label, emoji, service_mode, license_type, license_review_status")
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
    for (const c of [...extraRegCategories, ...regCategories]) {
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

  const licenseSourceCategories = useMemo(() => {
    const selected = selectedCategoryIds
      .map((id) => allRegCategories.find((c) => c.id === id))
      .filter((c): c is RegCategoryRow => c != null);
    if (selected.length > 0) return selected;
    if (pendingNewCategoryCreate) {
      return [
        {
          id: "pending",
          label: pendingNewCategoryCreate.category_name,
          emoji: "",
          service_mode: pendingNewCategoryCreate.service_mode,
        },
      ];
    }
    return [];
  }, [selectedCategoryIds, allRegCategories, pendingNewCategoryCreate]);

  const licenseFields = useMemo(
    () => wizardLicenseFields(licenseSourceCategories),
    [licenseSourceCategories],
  );
  const needsLicenseStep = licenseFields.length > 0;
  const wizardTotalSteps = needsLicenseStep ? 3 : 2;

  useEffect(() => {
    if (!needsLicenseStep && regPage === 3) setRegPage(2);
  }, [needsLicenseStep, regPage]);

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

  const stepAReady = nameOk && phoneOk && selfieCaptured;
  const stepBReady =
    categoryOk &&
    shopFieldOk &&
    baseType !== "" &&
    upiFmtOk &&
    gpsOk &&
    reachChoice !== "" &&
    radiusOk &&
    modesOk &&
    shopPhotoCaptured;

  const detectLocation = (opts?: { silent?: boolean }): Promise<GpsPoint | null> => {
    return new Promise((resolve) => {
      const e2eGeo =
        typeof window !== "undefined"
          ? (
              window as unknown as {
                __E2E_MOCK_GEO__?: { lat: number; lng: number; accuracy?: number | null };
              }
            ).__E2E_MOCK_GEO__
          : undefined;
      if (e2eGeo && Number.isFinite(e2eGeo.lat) && Number.isFinite(e2eGeo.lng)) {
        const c: GpsPoint = {
          lat: e2eGeo.lat,
          lng: e2eGeo.lng,
          accuracy:
            e2eGeo.accuracy != null && Number.isFinite(e2eGeo.accuracy)
              ? e2eGeo.accuracy
              : null,
        };
        setCoords(c);
        setLocationInlineError(null);
        setShowLocationHelp(false);
        if (!opts?.silent) toast.success(s.vendor_location_captured);
        resolve(c);
        return;
      }
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
          const c: GpsPoint = {
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            accuracy: readGeolocationAccuracy(p.coords),
          };
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
    const cat = allRegCategories.find((c) => c.id === categoryId);
    const catalog = resolveCatalogServiceMode(cat?.service_mode);
    setCategoryModesById((prev) => ({
      ...prev,
      [categoryId]: ensureCatalogBaseModes(modes, catalog),
    }));
  };

  const tryStepANext = () => {
    if (!nameOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_name);
      return;
    }
    if (!phoneOk) {
      showRegistrationGuidanceToast(s.vendor_phone_invalid_body);
      return;
    }
    if (!selfieCaptured) {
      showRegistrationGuidanceToast(s.vendor_selfie_capture);
      return;
    }
    const trimmedPhone = phone.trim();
    if (OTP_ENABLED && otpVerifiedPhone !== trimmedPhone) {
      setStepAOtpOpen(true);
      return;
    }
    setRegPage(2);
  };

  const tryStepBNext = () => {
    if (!categoryOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_categories);
      return;
    }
    if (baseType === "") {
      showRegistrationGuidanceToast(s.reg_toast_missing_base_type);
      return;
    }
    if (!gpsOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_gps);
      return;
    }
    if (!upiFmtOk) {
      showRegistrationGuidanceToast(s.vendor_upi_id_format_invalid);
      return;
    }
    if (reachChoice === "") {
      showRegistrationGuidanceToast(s.reg_toast_missing_reach);
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
    if (!shopPhotoCaptured) {
      showRegistrationGuidanceToast(s.business_photo_verify);
      return;
    }
    setRegPage(3);
  };

  const updateLicenseDraft = (
    fieldKey: string,
    patch: Partial<{ number: string; file: File | null; preview: string | null }>,
  ) => {
    setLicenseDrafts((prev) => ({
      ...prev,
      [fieldKey]: {
        number: prev[fieldKey]?.number ?? "",
        file: prev[fieldKey]?.file ?? null,
        preview: prev[fieldKey]?.preview ?? null,
        ...patch,
      },
    }));
  };

  const handleLicensePhotoPicked = (file: File | undefined) => {
    const key = licensePhotoTargetRef.current;
    licensePhotoTargetRef.current = null;
    if (!key || !file) return;
    const preview = URL.createObjectURL(file);
    updateLicenseDraft(key, { file, preview });
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
    setSelectedCategoryIds([id]);
    setCategoryModesById({
      [id]: initialModesForCatalog(resolveCatalogServiceMode(serviceModeValue)),
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
    } catch (err) {
      dismissNetworkRetryingToast();
      setCategorySuggesting(false);
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void handleFindCategory(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        toast.error(s.network_failed);
      }
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
    setPendingCategoryModes(
      initialModesForCatalog(
        resolveCatalogServiceMode(categorySuggestion.service_mode ?? "help"),
      ),
    );
    setCategorySuggestion(null);
    toast.success(s.category_suggest_new(categorySuggestion.category_name));
  };

  const toggleRegCategory = (categoryId: string) => {
    setPendingNewCategoryCreate(null);
    setPendingCategoryModes([]);
    setSelectedCategoryIds((prev) => {
      if (prev.includes(categoryId)) {
        setCategoryModesById({});
        return [];
      }
      const cat = allRegCategories.find((c) => c.id === categoryId);
      setCategoryModesById(
        cat
          ? {
              [categoryId]: initialModesForCatalog(
                resolveCatalogServiceMode(cat.service_mode),
              ),
            }
          : {},
      );
      return [categoryId];
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
      toast.error(s.vendor_qr_upload_failed);
      setUpiQrUploading(false);
      return;
    }
    const { data: pub } = supabase.storage.from("vendor-docs").getPublicUrl(path);
    setUpiQrUrl(pub.publicUrl);
    const payeeId = await decodeUpiPayeeIdFromImageFile(file);
    setUpiQrPayeeId(payeeId);
    if (payeeId) {
      setUpi(payeeId);
    } else {
      toast.error(s.vendor_qr_decode_failed);
    }
    setUpiQrUploading(false);
  };

  const handleSelfieCapture = (shot: CapturedShot) => {
    setSelfieCameraOpen(false);
    setSelfieBlob(shot.blob);
    setSelfieDataUrl(shot.dataUrl);
    toast.success(s.vendor_selfie_captured);
  };

  const acceptShopPhoto = (
    shot: CapturedShot,
    opts: {
      distance: number;
      locationAccuracy: number | null;
      photoAccuracy: number | null;
      pendingLocationReview: boolean;
    },
  ) => {
    setShopPhotoGpsDistance(Math.round(opts.distance));
    setShopPhotoLocationAccuracy(opts.locationAccuracy);
    setShopPhotoAccuracy(opts.photoAccuracy);
    setShopPhotoPendingLocationReview(opts.pendingLocationReview);
    setShopPhotoBlob(shot.blob);
    setShopPhotoDataUrl(shot.dataUrl);
    setShopPhotoCoords(shot.coords);
    setLastFailedShopShot(null);
    if (opts.pendingLocationReview) {
      toast.success(s.vendor_gps_pending_review_toast);
    } else {
      toast.success(s.vendor_photo_verified);
    }
  };

  const handleShopPhotoCapture = (shot: CapturedShot) => {
    setShopCameraOpen(false);
    if (coords) {
      const match = evaluateGpsMatch(coords, shot.coords);
      if (!match.ok) {
        const nextFails = gpsMatchFailCount + 1;
        setGpsMatchFailCount(nextFails);
        setLastFailedShopShot(shot);
        void logGpsMatchFailure({
          distanceMeters: match.distanceMeters,
          locationAccuracy: match.locationAccuracy,
          photoAccuracy: match.photoAccuracy,
          effectiveTolerance: match.effectiveTolerance,
          source: "registration",
          sessionKey: gpsSessionKeyRef.current,
        });
        toast.error(s.vendor_mismatch_title, {
          description: s.vendor_mismatch_distance(
            Math.round(match.distanceMeters),
            Math.round(match.effectiveTolerance),
          ),
        });
        return;
      }
      acceptShopPhoto(shot, {
        distance: match.distanceMeters,
        locationAccuracy: match.locationAccuracy,
        photoAccuracy: match.photoAccuracy,
        pendingLocationReview: false,
      });
      return;
    }
    acceptShopPhoto(shot, {
      distance: 0,
      locationAccuracy: null,
      photoAccuracy: shot.coords.accuracy,
      pendingLocationReview: false,
    });
  };

  const submitShopPhotoForLocationReview = () => {
    if (!lastFailedShopShot || !coords) return;
    const match = evaluateGpsMatch(coords, lastFailedShopShot.coords);
    acceptShopPhoto(lastFailedShopShot, {
      distance: match.distanceMeters,
      locationAccuracy: match.locationAccuracy,
      photoAccuracy: match.photoAccuracy,
      pendingLocationReview: true,
    });
  };

  const register = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!categoryOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_categories);
      return;
    }
    if (baseType === "shop" && !shopOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_shop_name);
      return;
    }
    if (baseType === "") {
      showRegistrationGuidanceToast(s.reg_toast_missing_base_type);
      return;
    }
    if (!gpsOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_gps);
      return;
    }
    if (!upiFmtOk) {
      showRegistrationGuidanceToast(s.vendor_upi_id_format_invalid);
      return;
    }
    if (reachChoice === "") {
      showRegistrationGuidanceToast(s.reg_toast_missing_reach);
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
    if (!stepAReady || !stepBReady || !reachFlags || !selfieBlob || !shopPhotoBlob) return;

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

    let registerResult: RegisterVendorResult;
    try {
      registerResult = await withNetworkRetry(
        async () => {
          const r = await invokeRegisterVendor({
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
          if (r.ok === false && isNetworkFailure({ message: r.error })) {
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
    } catch (err) {
      dismissNetworkRetryingToast();
      setLoading(false);
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void register(e), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
        return;
      }
      throw err;
    }

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
    let selfiePhotoFailed = false;
    let shopPhotoFailed = false;

    if (pendingNewCategoryCreate) {
      try {
        const created = await withTimedRetry(
          async (signal) => {
            const result = await invokeSuggestCategory({
              description: pendingNewCategoryCreate.description,
              vendor_id: newVendorId,
              create_pending: true,
            });
            if (!result.success && isNetworkFailure({ message: result.error ?? "" })) {
              throw new Error(result.error ?? "suggest_category_network");
            }
            if (signal.aborted) throw new Error("aborted");
            return result;
          },
          {
            onRetrying: () => showNetworkRetryingToast({ retrying: s.network_retrying }),
            shouldRetry: () => getNavigatorOnline(),
          },
        );
        dismissNetworkRetryingToast();
        if (created.success && created.category_id) {
          resolvedPrimaryServiceMode = pickPrimaryAvailabilityMode(
            pendingCategoryModes,
            created.service_mode ?? pendingNewCategoryCreate.service_mode,
          );
          resolvedCategoryLabel =
            created.category_name ?? pendingNewCategoryCreate.category_name;
          resolvedCategoryId = created.category_id;

          try {
            const attachResult = await withTimedRetry(
              async (signal) => {
                const r = await invokeAttachPendingCategory({
                  vendorId: newVendorId,
                  vendorPhone: phone.trim(),
                  categoryId: created.category_id!,
                  serviceMode: resolvedPrimaryServiceMode,
                  modes: pendingCategoryModes,
                });
                if (r.ok === false && isNetworkFailure({ message: r.error })) {
                  throw new Error(r.error);
                }
                if (signal.aborted) throw new Error("aborted");
                return r;
              },
              { shouldRetry: () => getNavigatorOnline() },
            );
            if (attachResult.ok === false) {
              captureError(new Error(attachResult.error), {
                scope: "vendorRegistrationWizard.attachPendingCategory",
                vendorId: newVendorId,
              });
              toast.warning(s.reg_soft_fail_category);
            } else {
              try {
                const { error: attachPatchErr } = await withTimedRetry(async (signal) => {
                  const r = await patchVendorOwn(newVendorId, phone.trim(), {
                    category: resolvedCategoryLabel,
                    service_mode: resolvedPrimaryServiceMode,
                  });
                  if (signal.aborted) throw new Error("aborted");
                  return throwOnSupabaseNetworkError(r);
                });
                if (attachPatchErr) {
                  captureError(attachPatchErr, {
                    scope: "vendorRegistrationWizard.attachPendingCategoryPatch",
                    vendorId: newVendorId,
                  });
                }
              } catch (patchErr) {
                captureError(patchErr, {
                  scope: "vendorRegistrationWizard.attachPendingCategoryPatch",
                  vendorId: newVendorId,
                });
              }
            }
          } catch (attachErr) {
            captureError(attachErr, {
              scope: "vendorRegistrationWizard.attachPendingCategory",
              vendorId: newVendorId,
            });
            toast.warning(
              isNetworkTimeout(attachErr) ? s.network_timeout : s.reg_soft_fail_category,
            );
          }
        } else {
          shopPhotoFailed = true;
          captureError(new Error("pending_category_create_failed"), {
            scope: "vendorRegistrationWizard.pendingCategoryCreate",
            vendorId: newVendorId,
          });
          toast.warning(s.reg_soft_fail_category);
        }
      } catch (pendingErr) {
        dismissNetworkRetryingToast();
        shopPhotoFailed = true;
        captureError(pendingErr, {
          scope: "vendorRegistrationWizard.pendingCategoryCreate",
          vendorId: newVendorId,
        });
        toast.warning(
          isNetworkTimeout(pendingErr) || pendingErr instanceof NetworkExhaustedError
            ? s.network_timeout
            : s.reg_soft_fail_category,
        );
      }
    }

    try {
      const selfiePath = `${newVendorId}/selfie.jpg`;
      const { error: selfieUpErr } = await withTimedRetry(async (signal) => {
        const r = await supabase.storage
          .from(VENDOR_SELFIES_BUCKET)
          .upload(selfiePath, selfieBlob, { contentType: "image/jpeg", upsert: true });
        if (signal.aborted) throw new Error("aborted");
        if (r.error && isNetworkFailure(r.error)) throw r.error;
        return r;
      });
      if (!selfieUpErr) {
        const { data: selfiePub } = supabase.storage
          .from(VENDOR_SELFIES_BUCKET)
          .getPublicUrl(selfiePath);
        const { error: selfiePatchErr } = await withTimedRetry(async (signal) => {
          const r = await patchVendorOwn(newVendorId, phone.trim(), {
            photo_selfie: selfiePub.publicUrl,
          });
          if (signal.aborted) throw new Error("aborted");
          return throwOnSupabaseNetworkError(r);
        });
        if (selfiePatchErr) {
          selfiePhotoFailed = true;
          captureError(selfiePatchErr, {
            scope: "vendorRegistrationWizard.selfiePatch",
            vendorId: newVendorId,
          });
        } else {
          const { error: verifErr } = await withTimedRetry(async (signal) =>
            throwOnSupabaseNetworkError(
              await applyAbortSignal(
                supabase.rpc("submit_vendor_verification", {
                  p_vendor_id: newVendorId,
                  p_vendor_phone: phone.trim(),
                  p_check_type: "photo_selfie",
                  p_doc_url: selfiePub.publicUrl,
                }),
                signal,
              ),
            ),
          );
          if (verifErr) {
            captureError(verifErr, {
              scope: "vendorRegistrationWizard.submitSelfieVerification",
              vendorId: newVendorId,
            });
          }
        }
      } else {
        selfiePhotoFailed = true;
        captureError(selfieUpErr, {
          scope: "vendorRegistrationWizard.selfieUpload",
          vendorId: newVendorId,
        });
      }
    } catch (err) {
      selfiePhotoFailed = true;
      captureError(err, {
        scope: "vendorRegistrationWizard.selfieUpload",
        vendorId: newVendorId,
      });
      if (isNetworkTimeout(err) || err instanceof NetworkExhaustedError) {
        toast.warning(s.network_timeout);
      }
    }

    if (resolvedCategoryId && shopPhotoBlob) {
      try {
        const shopPath = `${newVendorId}/${resolvedCategoryId}/${Date.now()}.jpg`;
        const { error: shopUpErr } = await withTimedRetry(async (signal) => {
          const r = await supabase.storage
            .from(SHOP_PHOTOS_BUCKET)
            .upload(shopPath, shopPhotoBlob, { contentType: "image/jpeg", upsert: true });
          if (signal.aborted) throw new Error("aborted");
          if (r.error && isNetworkFailure(r.error)) throw r.error;
          return r;
        });
        if (!shopUpErr) {
          const { data: shopPub } = supabase.storage
            .from(SHOP_PHOTOS_BUCKET)
            .getPublicUrl(shopPath);
          const hasAccountCoords = coords != null;
          const bizLat = shopPhotoCoords?.lat ?? coords?.lat ?? null;
          const bizLng = shopPhotoCoords?.lng ?? coords?.lng ?? null;
          const { error: shopSubmitErr } = await withTimedRetry(async (signal) =>
            throwOnSupabaseNetworkError(
              await applyAbortSignal(
                supabase.rpc("vendor_submit_category_shop_photo", {
                  p_vendor_id: newVendorId,
                  p_vendor_phone: phone.trim(),
                  p_category_id: resolvedCategoryId,
                  p_shop_photo_url: shopPub.publicUrl,
                  p_gps_match_distance: shopPhotoGpsDistance,
                  p_set_account_lat: hasAccountCoords ? null : shopPhotoCoords?.lat ?? null,
                  p_set_account_lng: hasAccountCoords ? null : shopPhotoCoords?.lng ?? null,
                  p_pending_location_review: shopPhotoPendingLocationReview,
                  p_location_accuracy: shopPhotoLocationAccuracy,
                  p_photo_accuracy: shopPhotoAccuracy,
                  p_set_account_location_accuracy: hasAccountCoords
                    ? coords?.accuracy ?? null
                    : shopPhotoCoords?.accuracy ?? null,
                  p_business_lat: bizLat,
                  p_business_lng: bizLng,
                }),
                signal,
              ),
            ),
          );
          if (shopSubmitErr) {
            shopPhotoFailed = true;
            captureError(shopSubmitErr, {
              scope: "vendorRegistrationWizard.submitShopPhoto",
              vendorId: newVendorId,
            });
          } else if (hasAccountCoords && coords?.accuracy != null) {
            const { error: accErr } = await withTimedRetry(async (signal) => {
              const r = await patchVendorOwn(newVendorId, phone.trim(), {
                location_accuracy: coords.accuracy,
              });
              if (signal.aborted) throw new Error("aborted");
              return throwOnSupabaseNetworkError(r);
            });
            if (accErr) {
              captureError(accErr, {
                scope: "vendorRegistrationWizard.locationAccuracy",
                vendorId: newVendorId,
              });
            }
          }
        } else {
          shopPhotoFailed = true;
          captureError(shopUpErr, {
            scope: "vendorRegistrationWizard.shopPhotoUpload",
            vendorId: newVendorId,
          });
        }
      } catch (err) {
        shopPhotoFailed = true;
        captureError(err, {
          scope: "vendorRegistrationWizard.shopPhotoUpload",
          vendorId: newVendorId,
        });
        if (isNetworkTimeout(err) || err instanceof NetworkExhaustedError) {
          toast.warning(s.network_timeout);
        }
      }
    } else if (!resolvedCategoryId) {
      shopPhotoFailed = true;
    }

    const filledReasons = cancelReasons.map((r) => r.trim());
    if (resolvedCategoryId && filledReasons.some((r) => r.length > 0)) {
      try {
        const { error: reasonsErr } = await withTimedRetry(async (signal) =>
          throwOnSupabaseNetworkError(
            await applyAbortSignal(
              supabase.rpc("vendor_upsert_category_cancel_reasons", {
                p_vendor_id: newVendorId,
                p_vendor_phone: phone.trim(),
                p_category_id: resolvedCategoryId,
                p_reasons: filledReasons,
              }),
              signal,
            ),
          ),
        );
        if (reasonsErr) {
          captureError(reasonsErr, {
            scope: "vendorRegistrationWizard.cancelReasons",
            vendorId: newVendorId,
          });
          toast.warning(s.reg_soft_fail_cancel_reasons);
        }
      } catch (err) {
        captureError(err, {
          scope: "vendorRegistrationWizard.cancelReasons",
          vendorId: newVendorId,
        });
        toast.warning(
          isNetworkTimeout(err) || err instanceof NetworkExhaustedError
            ? s.network_timeout
            : s.reg_soft_fail_cancel_reasons,
        );
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
        };
        try {
          const { error: profileErr } = await withTimedRetry(async (signal) =>
            throwOnSupabaseNetworkError(
              await applyAbortSignal(
                supabase.rpc("vendor_update_category_profile", {
                  p_vendor_id: newVendorId,
                  p_vendor_phone: phone.trim(),
                  p_category_id: resolvedCategoryId,
                  p_patch: patch,
                }),
                signal,
              ),
            ),
          );
          if (profileErr) {
            captureError(profileErr, {
              scope: "vendorRegistrationWizard.categoryProfile",
              vendorId: newVendorId,
            });
            toast.warning(s.reg_soft_fail_profile);
          }
        } catch (err) {
          captureError(err, {
            scope: "vendorRegistrationWizard.categoryProfile",
            vendorId: newVendorId,
          });
          toast.warning(
            isNetworkTimeout(err) || err instanceof NetworkExhaustedError
              ? s.network_timeout
              : s.reg_soft_fail_profile,
          );
        }
      }
    }

    try {
      const filledLicenses: Array<{
        category_id: string;
        license_type: string;
        license_number: string | null;
        photo_url: string | null;
      }> = [];
      for (const field of licenseFields) {
        const draft = licenseDrafts[field.fieldKey];
        const number = String(draft?.number ?? "").trim();
        const catId =
          field.categoryId === "pending" ? resolvedCategoryId : field.categoryId;
        if (!catId) continue;
        let photoUrl: string | null = null;
        if (draft?.file) {
          const path = `license-docs/${newVendorId}/${catId}/${field.licenseType}_${Date.now()}.jpg`;
          const { error: upErr } = await supabase.storage.from("vendor-docs").upload(
            path,
            draft.file,
            { contentType: draft.file.type || "image/jpeg", upsert: true },
          );
          if (upErr) {
            captureError(upErr, {
              scope: "vendorRegistrationWizard.licensePhotoUpload",
              vendorId: newVendorId,
            });
          } else {
            photoUrl = supabase.storage.from("vendor-docs").getPublicUrl(path).data.publicUrl;
          }
        }
        if (
          licenseFieldHasValue({ license_number: number, photo_url: photoUrl })
        ) {
          filledLicenses.push({
            category_id: catId,
            license_type: field.licenseType,
            license_number: number || null,
            photo_url: photoUrl,
          });
        }
      }
      if (filledLicenses.length > 0) {
        const { error: licErr } = await supabase.rpc("vendor_upsert_licenses", {
          p_vendor_id: newVendorId,
          p_vendor_phone: phone.trim(),
          p_licenses: filledLicenses,
        });
        if (licErr) {
          captureError(licErr, {
            scope: "vendorRegistrationWizard.upsertLicenses",
            vendorId: newVendorId,
          });
        }
      }
    } catch (licCatch) {
      captureError(licCatch, {
        scope: "vendorRegistrationWizard.upsertLicenses",
        vendorId: newVendorId,
      });
    }

    void invokeNotifyAdmin(
      s.vendor_admin_notify_title,
      `${name.trim()} — ${resolvedCategoryLabel} (${resolvedPrimaryServiceMode})`,
      {
        type: "new_vendor",
        route: "settings",
        route_params: { vendor_id: newVendorId },
      },
    );

    if (referralCodeInput.trim()) {
      try {
        const referralBody = await withTimedRetry(async (signal) => {
          const referralResp = await fetch(
            `${SUPABASE_URL}/functions/v1/process-vendor-referral`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
              },
              body: JSON.stringify({
                new_vendor_id: newVendorId,
                referral_code: referralCodeInput.trim(),
              }),
              signal,
            },
          );
          const body = (await referralResp.json()) as {
            success?: boolean;
            reason?: string;
          };
          return { ok: referralResp.ok, body };
        });
        if (referralBody.body.reason === "already_referred") {
          toast.error(s.referral_already_used);
        } else if (referralBody.ok && referralBody.body.success) {
          toast.success(s.referral_code_applied);
        } else {
          toast.error(s.referral_code_invalid);
        }
      } catch (err) {
        toast.error(
          isNetworkTimeout(err) || err instanceof NetworkExhaustedError
            ? s.network_timeout
            : s.referral_code_invalid,
        );
      }
    }

    setLoading(false);
    toast.success(s.vendor_welcome_title, { description: s.vendor_welcome_body });
    if (selfiePhotoFailed || shopPhotoFailed) {
      toast.warning(s.vendor_photos_required_title, {
        description: s.vendor_photos_required_body,
      });
    }
    triggerProactiveCategoryAliasesForCategories(newVendorId, categoryIdsForRpc);
    triggerCategoryModeConfidenceCheck(categoryIdsForRpc);
    onRegistered(newVendorId, phone.trim());
  };

  const upiFormatError =
    upiBlurred && upi.trim().length > 0 && !upiFmtOk ? s.vendor_upi_id_format_invalid : undefined;

  return (
    <form
      onSubmit={register}
      className="space-y-4 animate-fade-up"
      data-testid="vendor-registration-wizard"
    >
      <p className="text-xs text-center text-muted-foreground uppercase tracking-wider">
        {s.reg_wizard_step(regPage, wizardTotalSteps)}
      </p>
      <p className="text-sm text-center font-semibold text-foreground">
        {regPage === 1
          ? s.reg_step_account
          : regPage === 2
            ? s.reg_step_business
            : s.reg_step_licenses}
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
            onChange={(v) => {
              setPhone(v);
              if (v.trim() !== otpVerifiedPhone) setOtpVerifiedPhone(null);
            }}
            placeholder={s.vendor_phone_placeholder}
            required
          />

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
                "mt-2 w-full rounded-xl border-2 h-12 flex items-center justify-center gap-2 font-semibold",
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
              "w-full rounded-2xl bg-primary text-primary-foreground h-12 font-semibold",
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
                <button
                  type="button"
                  onClick={() => setShowManualCategories(true)}
                  className="text-xs text-muted-foreground inline-flex items-center gap-1"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 text-brand" />
                  {getLabel(
                    allRegCategories.find((c) => c.id === selectedCategoryIds[0])?.label ?? "",
                  )}
                  <span className="underline">{s.category_chooseDifferently}</span>
                </button>
              )}
              {pendingNewCategoryCreate && selectedCategoryIds.length === 0 && (
                <button
                  type="button"
                  onClick={() => setShowManualCategories(true)}
                  className="text-xs text-muted-foreground inline-flex items-center gap-1"
                >
                  {pendingNewCategoryCreate.category_name}
                  <span className="underline">{s.category_chooseDifferently}</span>
                </button>
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
              className="mt-2 w-full rounded-xl bg-brand px-3 h-10 text-sm font-semibold text-brand-foreground disabled:opacity-50 inline-flex items-center justify-center gap-2"
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
              <div className="mt-3 rounded-2xl border border-border bg-muted/40 p-3 space-y-2">
                <p className="text-sm font-semibold">{s.vendor_we_think}</p>
                <p className="text-sm">
                  {s.category_didYouMean(categorySuggestion.category_name ?? "")}
                </p>
                <button
                  type="button"
                  onClick={confirmNewCategorySuggestion}
                  className="w-full rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-brand-foreground"
                >
                  {s.category_confirm}
                </button>
              </div>
            )}
            {categorySuggestion != null &&
              categorySuggestion.outcome !== "high_existing" &&
              categorySuggestion.outcome !== "new_suggested" &&
              categorySuggestion.outcome !== "medium_new" && (
                <div className="mt-3 rounded-2xl border border-border bg-muted/40 p-3 space-y-2">
                  <p className="text-sm">{s.category_noMatchFound}</p>
                  <button
                    type="button"
                    data-testid="reg-browse-all-categories-nomatch"
                    onClick={() => setShowManualCategories(true)}
                    className="w-full rounded-xl border border-border px-3 py-2 text-xs font-semibold"
                  >
                    {s.category_browseManual}
                  </button>
                </div>
              )}
            {selectedCategoryIds.length === 0 && !pendingNewCategoryCreate && (
              <button
                type="button"
                data-testid="reg-browse-all-categories"
                onClick={() => setShowManualCategories((v) => !v)}
                className="mt-3 text-xs font-medium text-muted-foreground underline"
              >
                {s.category_browseManual}
              </button>
            )}
            {showManualCategories && (
              <div className="mt-2 flex flex-wrap gap-2">
                {regCategoriesLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  allRegCategories.map((cat) => {
                    const selected = selectedCategoryIds.includes(cat.id);
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => toggleRegCategory(cat.id)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium",
                          selected
                            ? "border-primary bg-primary/20 ring-1 ring-primary/30"
                            : "border-border bg-card",
                        )}
                      >
                        {cat.emoji} {getLabel(cat.label)}
                        <span className="text-xs text-muted-foreground">
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
              <p className="text-xs text-muted-foreground text-center px-2">
                {baseType === "shop" ? s.reg_gps_public_hint : s.reg_gps_private_hint}
              </p>
              <button
                type="button"
                onClick={() => void detectLocation()}
                className={cn(
                  "w-full rounded-xl border-2 h-12 flex items-center justify-center gap-2 font-semibold",
                  coords ? "border-secondary text-secondary bg-secondary/5" : "border-border",
                )}
              >
                {locating ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
                {coords
                  ? `${s.vendor_location_set} (${coords.lat.toFixed(3)}, ${coords.lng.toFixed(3)})`
                  : baseType === "home"
                    ? s.vendor_capture_location_home
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
            <p className="text-xs text-muted-foreground text-center px-2">
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
              className="mt-1 w-full rounded-xl border border-border h-10 text-sm"
            >
              {upiQrUploading ? s.vendor_uploading : s.vendor_upi_qr_hint}
            </button>
          </div>

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
                label={s.reg_how_take_requests}
                required
                testIdPrefix="reg-avail"
                catalogServiceMode={resolveCatalogServiceMode(
                  pendingNewCategoryCreate.service_mode,
                )}
                value={pendingCategoryModes}
                onChange={(modes) => setPendingCategoryModes(normalizeAvailabilityModes(modes))}
              />
            ) : (
              <CategoryAvailabilityModeSelector
                variant="cards"
                label={s.reg_how_take_requests}
                required
                testIdPrefix="reg-avail"
                catalogServiceMode={resolveCatalogServiceMode(
                  allRegCategories.find((c) => c.id === selectedCategoryIds[0])?.service_mode,
                )}
                value={categoryModesById[selectedCategoryIds[0]] ?? []}
                onChange={(modes) => setCategoryModes(selectedCategoryIds[0], modes)}
              />
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
              onClick={() => {
                if (!gpsOk) {
                  showRegistrationGuidanceToast(s.reg_toast_missing_gps);
                  return;
                }
                setShopCameraOpen(true);
              }}
              className={cn(
                "mt-2 w-full rounded-xl border-2 h-12 flex items-center justify-center gap-2 font-semibold",
                shopPhotoCaptured
                  ? "border-secondary text-secondary bg-secondary/5"
                  : "border-border",
              )}
            >
              <Camera className="h-4 w-4" />
              {shopPhotoCaptured ? s.vendor_reshoot : s.my_business_verify_now}
            </button>
            {gpsMatchFailCount >= GPS_MATCH_FAILS_BEFORE_SOFT_REVIEW &&
              lastFailedShopShot &&
              !shopPhotoCaptured && (
                <button
                  type="button"
                  data-testid="reg-gps-submit-for-review"
                  onClick={submitShopPhotoForLocationReview}
                  className="mt-2 w-full rounded-xl border border-amber-500/50 bg-amber-500/10 h-10 text-sm font-semibold text-amber-800"
                >
                  {s.vendor_gps_submit_for_review}
                </button>
              )}
            {shopPhotoPendingLocationReview && shopPhotoCaptured && (
              <p
                data-testid="reg-gps-pending-review-note"
                className="mt-2 text-xs text-amber-700"
              >
                {s.vendor_gps_pending_review_note}
              </p>
            )}
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
              className="flex-1 rounded-2xl border border-border h-10 font-semibold inline-flex items-center justify-center gap-1"
            >
              <ChevronLeft className="h-4 w-4" />
              {s.reg_wizard_back}
            </button>
            {needsLicenseStep ? (
              <button
                type="button"
                data-testid="reg-business-next"
                disabled={!stepBReady || loading}
                onClick={tryStepBNext}
                className="flex-[2] rounded-2xl bg-primary text-primary-foreground h-12 font-semibold disabled:opacity-50"
              >
                {s.reg_wizard_next}
              </button>
            ) : (
              <button
                type="submit"
                disabled={!stepBReady || loading}
                className="flex-[2] rounded-2xl bg-primary text-primary-foreground h-12 font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
                {s.vendor_register_btn}
              </button>
            )}
          </div>
        </>
      )}

      {regPage === 3 && (
        <>
          <p
            className="text-xs text-muted-foreground leading-relaxed text-center"
            data-testid="reg-license-disclaimer"
          >
            {s.reg_license_disclaimer}
          </p>
          {licenseFields.map((field) => {
            const draft = licenseDrafts[field.fieldKey];
            return (
              <div
                key={field.fieldKey}
                data-testid={`reg-license-field-${field.licenseType}`}
                className="rounded-2xl border border-border p-3 space-y-2"
              >
                <p className="text-sm font-semibold text-foreground">
                  {getLabel(field.categoryLabel)} · {licenseTypeLabel(field.licenseType, s, field.displayName)}
                </p>
                <RegField
                  label={s.reg_license_number}
                  value={draft?.number ?? ""}
                  onChange={(v) => updateLicenseDraft(field.fieldKey, { number: v })}
                  placeholder={s.reg_license_number}
                />
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {s.reg_license_photo}
                  </label>
                  <button
                    type="button"
                    data-testid={`reg-license-photo-${field.licenseType}`}
                    onClick={() => {
                      licensePhotoTargetRef.current = field.fieldKey;
                      licensePhotoInputRef.current?.click();
                    }}
                    className="mt-2 w-full rounded-xl border border-border h-10 text-sm font-semibold"
                  >
                    {draft?.preview ? s.reg_license_photo_replace : s.reg_license_photo_upload}
                  </button>
                  {draft?.preview && (
                    <img
                      src={draft.preview}
                      alt=""
                      className="mt-2 w-full max-h-40 object-contain rounded-xl border border-border"
                    />
                  )}
                </div>
              </div>
            );
          })}
          <input
            ref={licensePhotoInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              handleLicensePhotoPicked(file);
            }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setRegPage(2)}
              className="flex-1 rounded-2xl border border-border h-10 font-semibold inline-flex items-center justify-center gap-1"
            >
              <ChevronLeft className="h-4 w-4" />
              {s.reg_wizard_back}
            </button>
            <button
              type="submit"
              data-testid="reg-license-skip"
              disabled={loading}
              className="flex-1 rounded-2xl border border-border h-10 font-semibold disabled:opacity-50"
            >
              {s.reg_license_skip}
            </button>
            <button
              type="submit"
              data-testid="reg-license-submit"
              disabled={loading}
              className="flex-[2] rounded-2xl bg-primary text-primary-foreground h-12 font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
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

      {stepAOtpOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background px-6 py-10">
          <PhoneOtpVerification
            phone={phone.trim()}
            onVerified={() => {
              setOtpVerifiedPhone(phone.trim());
              setStepAOtpOpen(false);
              setRegPage(2);
            }}
          />
        </div>
      )}
    </form>
  );
}
