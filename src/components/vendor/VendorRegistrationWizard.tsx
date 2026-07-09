import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, ChevronLeft, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import { ServiceRadiusChips } from "@/components/ServiceRadiusChips";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";
import {
  getReferralCode,
  isReferralEnabled,
  referralCodeFromPhone,
} from "@/lib/referral";
import { formatVendorDeletionDate } from "@/lib/vendorDeletion";
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
  type CategorySuggestionResult,
} from "@/lib/supabase";
import { patchVendorOwn } from "@/lib/vendorPatch";
import {
  withNetworkRetry,
  throwOnSupabaseNetworkError,
  isNetworkFailure,
} from "@/lib/withNetworkRetry";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  dismissNetworkRetryingToast,
  showNetworkRetryingToast,
} from "@/lib/networkToast";
import {
  type AvailabilityMode,
  type BaseTypeValue,
  type ReachChoiceValue,
  baseTypeToVendorType,
  looksLikeGibberish,
  MAX_REG_CATEGORIES,
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
  onRegistered: (vendorId: string) => void;
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

  const [regPage, setRegPage] = useState<1 | 2 | 3>(1);
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

  const [reachChoice, setReachChoice] = useState<ReachChoiceValue>("");
  const [serviceRadiusKm, setServiceRadiusKm] = useState<number | null>(null);
  const [availabilityModes, setAvailabilityModes] = useState<AvailabilityMode[]>([]);

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
  const gpsOk = coords != null;
  const reachFlags = reachChoice ? reachFlagsFromChoice(reachChoice) : null;
  const needsRadius = reachFlags?.serves_at_customer_place === true;
  const radiusOk = !needsRadius || serviceRadiusKm != null;

  const page1Ready =
    baseType !== "" && nameOk && shopFieldOk && categoryOk && gpsOk;
  const page2Ready =
    reachChoice !== "" && radiusOk && availabilityModes.length > 0;
  const phoneOk = isValidPhone(phone);
  const upiFmtOk = isValidUpi(upi);
  const page3Ready = phoneOk && upiFmtOk;

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

  const toggleAvailability = (mode: AvailabilityMode) => {
    setAvailabilityModes((prev) =>
      prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode],
    );
  };

  const tryPage1Next = () => {
    if (baseType === "") {
      showRegistrationGuidanceToast(s.reg_toast_missing_base_type);
      return;
    }
    if (!nameOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_name);
      return;
    }
    if (baseType === "shop" && !shopOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_shop_name);
      return;
    }
    if (!categoryOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_categories);
      return;
    }
    if (!gpsOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_gps);
      return;
    }
    setRegPage(2);
  };

  const tryPage2Next = () => {
    if (reachChoice === "") {
      showRegistrationGuidanceToast(s.reg_toast_missing_reach);
      return;
    }
    if (!radiusOk) {
      showRegistrationGuidanceToast(s.reg_toast_missing_radius);
      return;
    }
    if (availabilityModes.length === 0) {
      showRegistrationGuidanceToast(s.reg_toast_missing_availability);
      return;
    }
    setRegPage(3);
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
    setCategorySuggestion(null);
    setPendingNewCategoryCreate(null);
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
    setCategorySuggestion(null);
    toast.success(s.category_suggest_new(categorySuggestion.category_name));
  };

  const toggleRegCategory = (categoryId: string) => {
    setPendingNewCategoryCreate(null);
    setSelectedCategoryIds((prev) => {
      if (prev.includes(categoryId)) return prev.filter((id) => id !== categoryId);
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

  const register = async (e: FormEvent) => {
    e.preventDefault();
    if (!page3Ready || !page2Ready || !page1Ready || !reachFlags) return;

    setLoading(true);
    setParentError(null);

    const primaryServiceMode = availabilityModes[0];
    const vendorType = baseTypeToVendorType(baseType);
    if (!vendorType) {
      setLoading(false);
      return;
    }

    const categoryIdsForRpc = [...selectedCategoryIds];
    const categoryServiceModes = categoryIdsForRpc.map(() => primaryServiceMode);

    const registerResult = await invokeRegisterVendor({
      name: name.trim(),
      shop_name: resolveRegistrationShopName(baseType, name, shopName),
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
      base_type: baseType,
      serves_at_vendor_place: reachFlags.serves_at_vendor_place,
      serves_at_customer_place: reachFlags.serves_at_customer_place,
      service_radius_km: serviceRadiusKm ?? 15,
      availability_modes: availabilityModes,
    });

    if (registerResult.ok === false) {
      setLoading(false);
      if (isDuplicateVendorPhoneError({ code: registerResult.code, message: registerResult.error })) {
        onDuplicatePhone();
        setLoading(false);
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

    if (pendingNewCategoryCreate) {
      const created = await invokeSuggestCategory({
        description: pendingNewCategoryCreate.description,
        vendor_id: newVendorId,
        create_pending: true,
      });
      if (created.success && created.category_id) {
        resolvedPrimaryServiceMode = (created.service_mode ??
          pendingNewCategoryCreate.service_mode) as AvailabilityMode;
        resolvedCategoryLabel =
          created.category_name ?? pendingNewCategoryCreate.category_name;

        const attachResult = await invokeAttachPendingCategory({
          vendorId: newVendorId,
          categoryId: created.category_id,
          serviceMode: resolvedPrimaryServiceMode,
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
    onRegistered(newVendorId);
  };

  const upiFormatError =
    upiBlurred && upi.trim().length > 0 && !upiFmtOk ? s.vendor_upi_id_format_invalid : undefined;

  return (
    <form onSubmit={register} className="space-y-4 animate-fade-up">
      <p className="text-xs text-center text-muted-foreground uppercase tracking-wider">
        {s.reg_wizard_step(regPage, 3)}
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

          <div>
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {s.vendor_categories_label} *
              </label>
              <span className="text-xs text-muted-foreground">
                {s.vendor_categories_selected(selectedCategoryIds.length)}
              </span>
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
                <p className="text-sm font-semibold">{s.category_suggestion(categorySuggestion.category_name ?? "")}</p>
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
                    const atMax = selectedCategoryIds.length >= MAX_REG_CATEGORIES;
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        disabled={!selected && atMax}
                        onClick={() => toggleRegCategory(cat.id)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium",
                          selected
                            ? "border-primary bg-primary/20 ring-1 ring-primary/30"
                            : "border-border bg-card",
                          !selected && atMax && "opacity-40",
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

          {baseType === "shop" && (
            <RegField
              label={s.vendor_shop_name}
              value={shopName}
              onChange={setShopName}
              placeholder={s.vendor_shop_placeholder}
              required
              error={shopName.length > 0 && !shopOk ? s.vendor_specify_hint : undefined}
            />
          )}
          {baseType === "home" && (
            <RegField
              label={s.vendor_brand_name_optional}
              value={shopName}
              onChange={setShopName}
              placeholder={s.vendor_brand_placeholder}
              error={homeShopInvalid ? s.vendor_specify_hint : undefined}
            />
          )}

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

          <button
            type="button"
            onClick={tryPage1Next}
            className={cn(
              "w-full rounded-2xl bg-primary text-primary-foreground py-4 font-semibold",
              !page1Ready && "opacity-50",
            )}
          >
            {s.reg_wizard_next}
          </button>
        </>
      )}

      {regPage === 2 && (
        <>
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

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.reg_when_available} *
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              {(
                [
                  { mode: "help" as const, emoji: "⚡", title: s.reg_avail_help, desc: s.reg_avail_help_desc },
                  { mode: "delivery" as const, emoji: "🛒", title: s.reg_avail_delivery, desc: s.reg_avail_delivery_desc },
                  { mode: "appointment" as const, emoji: "📅", title: s.reg_avail_appointment, desc: s.reg_avail_appointment_desc },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.mode}
                  type="button"
                  onClick={() => toggleAvailability(opt.mode)}
                  className={cn(
                    "rounded-2xl border-2 p-3 text-left min-w-[140px] flex-1",
                    availabilityModes.includes(opt.mode)
                      ? "border-primary bg-primary/15 ring-1 ring-primary/30"
                      : "border-surface-border bg-surface",
                  )}
                >
                  <p className="font-semibold text-sm">
                    {opt.emoji} {opt.title}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{opt.desc}</p>
                </button>
              ))}
            </div>
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
              type="button"
              onClick={tryPage2Next}
              className={cn(
                "flex-[2] rounded-2xl bg-primary text-primary-foreground py-4 font-semibold",
                !page2Ready && "opacity-50",
              )}
            >
              {s.reg_wizard_next}
            </button>
          </div>
        </>
      )}

      {regPage === 3 && (
        <>
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
          {referralEnabled && (
            <RegField
              label={s.vendor_referralCodeLabel}
              value={referralCodeInput}
              onChange={(v) => setReferralCodeInput(v.toUpperCase().trim())}
              placeholder={s.vendor_referralCodePlaceholder}
            />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setRegPage(2)}
              className="flex-1 rounded-2xl border border-border py-4 font-semibold inline-flex items-center justify-center gap-1"
            >
              <ChevronLeft className="h-4 w-4" />
              {s.reg_wizard_back}
            </button>
            <button
              type="submit"
              disabled={!page3Ready || loading}
              className="flex-[2] rounded-2xl bg-primary text-primary-foreground py-4 font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
              {s.vendor_register_btn}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
