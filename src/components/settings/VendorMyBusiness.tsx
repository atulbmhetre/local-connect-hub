import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { ServiceRadiusChips } from "@/components/ServiceRadiusChips";
import { LiveCamera, type CapturedShot } from "@/components/LiveCamera";
import { SettingsCard, SettingsSectionLabel } from "@/components/settings/SettingsSection";
import {
  supabase,
  type Vendor,
  type Category,
  type VerificationStatus,
  SHOP_PHOTOS_BUCKET,
  VENDOR_SELFIES_BUCKET,
  GPS_MATCH_TOLERANCE_M,
  isValidPhone,
  isValidUpi,
  distanceMeters,
  useCategoryLabel,
  invokeNotifyAdmin,
} from "@/lib/supabase";
import { patchVendorOwn } from "@/lib/vendorPatch";
import { checkAndNotifyAdminGreenReady } from "@/lib/vendorGreenReady";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import {
  type AvailabilityMode,
  type BaseTypeValue,
  type ReachChoiceValue,
  baseTypeToVendorType,
  looksLikeGibberish,
  reachChoiceFromFlags,
  reachFlagsFromChoice,
  vendorTypeToBaseType,
  MAX_REG_CATEGORIES,
  resolveRegistrationShopName,
} from "@/lib/vendorRegistration";
import {
  NetworkExhaustedError,
  throwOnSupabaseNetworkError,
  withNetworkRetry,
} from "@/lib/withNetworkRetry";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  dismissNetworkRetryingToast,
  showNetworkFailedToast,
  showNetworkRetryingToast,
} from "@/lib/networkToast";

type RegCategoryRow = Pick<Category, "id" | "label" | "emoji"> & {
  service_mode: string;
};

type Props = {
  vendor: Vendor;
  onVendorUpdated: (updated: Vendor) => void;
  userPhone?: string | null;
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

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
  error,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  error?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className={cn(
          "mt-1 w-full bg-card border rounded-xl px-4 py-3.5 text-base focus:outline-none focus:ring-2",
          error ? "border-destructive focus:ring-destructive" : "border-border focus:ring-primary",
        )}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function VerifyRow({
  label,
  hint,
  verified,
  verifiedLabel,
  actionLabel,
  onAction,
  actionDisabled,
  actionLoading,
  children,
}: {
  label: string;
  hint?: string;
  verified: boolean;
  verifiedLabel: string;
  actionLabel: string;
  onAction: () => void;
  actionDisabled?: boolean;
  actionLoading?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3.5 border-t border-surface-border space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          {hint && <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{hint}</p>}
        </div>
        {verified ? (
          <span className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-brand">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            {verifiedLabel}
          </span>
        ) : (
          <button
            type="button"
            onClick={onAction}
            disabled={actionDisabled || actionLoading}
            className="shrink-0 text-xs font-semibold rounded-lg bg-primary text-primary-foreground px-3 py-2 disabled:opacity-60"
          >
            {actionLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : actionLabel}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

export function VendorMyBusiness({ vendor, onVendorUpdated, userPhone }: Props) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const vendorPhone = (vendor.phone ?? userPhone ?? "").trim();

  const [ownerName, setOwnerName] = useState(vendor.name ?? "");
  const [shopName, setShopName] = useState(vendor.shop_name ?? "");
  const [baseType, setBaseType] = useState<BaseTypeValue>("");
  const [reachChoice, setReachChoice] = useState<ReachChoiceValue>("");
  const [availabilityModes, setAvailabilityModes] = useState<AvailabilityMode[]>([]);
  const [serviceRadiusKm, setServiceRadiusKm] = useState<number | null>(null);
  const [phone, setPhone] = useState(vendor.phone ?? "");
  const [upiId, setUpiId] = useState(vendor.upi_id ?? "");
  const [availableCategories, setAvailableCategories] = useState<RegCategoryRow[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<RegCategoryRow[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifyingUpi, setVerifyingUpi] = useState(false);
  const [updatingLocation, setUpdatingLocation] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [selfieCameraOpen, setSelfieCameraOpen] = useState(false);

  const loadSeqRef = useRef(0);
  const selectedCategoryIdsRef = useRef<string[]>([]);
  const savedCategoryIdsRef = useRef<string[]>([]);

  const hydrateFromVendor = useCallback((v: Vendor) => {
    setOwnerName(v.name ?? "");
    setShopName(v.shop_name ?? "");
    setBaseType(
      v.base_type ? (v.base_type as BaseTypeValue) : vendorTypeToBaseType(v.vendor_type),
    );
    setReachChoice(
      reachChoiceFromFlags(v.serves_at_vendor_place, v.serves_at_customer_place) ||
        (v.vendor_type === "visiting" ? "customer" : "vendor"),
    );
    setServiceRadiusKm(v.service_radius_km ?? null);
    setPhone(v.phone ?? "");
    setUpiId(v.upi_id ?? "");
  }, []);

  useEffect(() => {
    hydrateFromVendor(vendor);
  }, [vendor.id, hydrateFromVendor, vendor]);

  useEffect(() => {
    const loadSeq = ++loadSeqRef.current;
    setCategoriesLoading(true);
    void (async () => {
      const [availResult, vcResult, modesResult] = await Promise.all([
        supabase
          .from("categories")
          .select("id, label, emoji, service_mode")
          .eq("is_active", true)
          .order("sort_order", { ascending: true }),
        supabase
          .from("vendor_categories")
          .select("category_id, is_primary, categories(id, label, emoji, service_mode)")
          .eq("vendor_id", vendor.id)
          .eq("status", "approved")
          .order("is_primary", { ascending: false }),
        supabase
          .from("vendor_availability_modes")
          .select("mode")
          .eq("vendor_id", vendor.id),
      ]);

      if (loadSeq !== loadSeqRef.current) return;

      const available = (availResult.data ?? []) as RegCategoryRow[];
      setAvailableCategories(available);

      let selected: RegCategoryRow[] = [];
      if (!vcResult.error && vcResult.data?.length) {
        for (const row of vcResult.data) {
          const joined = row.categories;
          const cat = Array.isArray(joined) ? joined[0] : joined;
          if (!cat) continue;
          selected.push({
            id: cat.id,
            label: cat.label,
            emoji: cat.emoji,
            service_mode: cat.service_mode,
          });
        }
      }
      if (selected.length === 0 && vendor.category) {
        const legacy = available.find((c) => c.label === vendor.category);
        if (legacy) selected = [legacy];
      }

      const selectedIds = selected.map((c) => c.id);
      selectedCategoryIdsRef.current = selectedIds;
      savedCategoryIdsRef.current = selectedIds;
      setSelectedCategories(selected);
      setSelectedCategoryIds(selectedIds);

      const modes = (modesResult.data ?? [])
        .map((row) => row.mode as AvailabilityMode)
        .filter((m) => m === "help" || m === "delivery" || m === "appointment");
      setAvailabilityModes(
        modes.length > 0 ? modes : [(vendor.service_mode ?? "help") as AvailabilityMode],
      );
      setCategoriesLoading(false);
    })();
  }, [vendor.id, vendor.category, vendor.service_mode]);

  const toggleCategory = (categoryId: string) => {
    setSelectedCategoryIds((prev) => {
      const next = prev.includes(categoryId)
        ? prev.length <= 1
          ? prev
          : prev.filter((id) => id !== categoryId)
        : prev.length >= MAX_REG_CATEGORIES
          ? prev
          : [...prev, categoryId];
      selectedCategoryIdsRef.current = next;
      setSelectedCategories((prevSelected) =>
        next
          .map(
            (id) =>
              availableCategories.find((c) => c.id === id) ??
              prevSelected.find((c) => c.id === id),
          )
          .filter((c): c is RegCategoryRow => c != null),
      );
      return next;
    });
  };

  const needsRadius = reachChoice === "customer" || reachChoice === "both";
  const shopNameInvalid =
    shopName.trim().length > 0 &&
    (shopName.trim().length <= 1 || looksLikeGibberish(shopName));
  const shopFieldOk =
    baseType === "shop"
      ? shopName.trim().length > 1 && !looksLikeGibberish(shopName)
      : baseType === "home"
        ? !shopNameInvalid
        : baseType === "none";
  const radiusOk = !needsRadius || serviceRadiusKm != null;
  const ownerOk = ownerName.trim().length > 1 && !looksLikeGibberish(ownerName);

  const saveReady =
    ownerOk &&
    baseType !== "" &&
    shopFieldOk &&
    selectedCategoryIds.length > 0 &&
    phone.trim().length > 0 &&
    reachChoice !== "" &&
    radiusOk &&
    availabilityModes.length > 0;

  const saveProfile = async () => {
    if (!saveReady) return;
    const categoryIdsToSave = selectedCategoryIdsRef.current;
    const removedCategoryIds = savedCategoryIdsRef.current.filter(
      (id) => !categoryIdsToSave.includes(id),
    );
    if (removedCategoryIds.length > 0) {
      const removedNames = removedCategoryIds
        .map((id) => {
          const cat =
            availableCategories.find((c) => c.id === id) ??
            selectedCategories.find((c) => c.id === id);
          return cat ? getLabel(cat.label) : null;
        })
        .filter((n): n is string => Boolean(n))
        .join(", ");
      const ok = window.confirm(s.vendor_category_remove_confirm(removedNames));
      if (!ok) {
        const restoredIds = [...savedCategoryIdsRef.current];
        selectedCategoryIdsRef.current = restoredIds;
        setSelectedCategoryIds(restoredIds);
        setSelectedCategories(
          restoredIds
            .map((id) => availableCategories.find((c) => c.id === id))
            .filter((c): c is RegCategoryRow => c != null),
        );
        return;
      }
    }
    const primaryCategory =
      availableCategories.find((c) => c.id === categoryIdsToSave[0]) ??
      selectedCategories.find((c) => c.id === categoryIdsToSave[0]) ??
      null;
    const primaryLabel = primaryCategory?.label ?? "";
    const primaryServiceMode = (availabilityModes[0] ??
      primaryCategory?.service_mode ??
      vendor.service_mode ??
      "") as "help" | "delivery" | "appointment" | "booking";
    const reachFlags = reachChoice ? reachFlagsFromChoice(reachChoice) : null;
    const mappedVendorType = baseTypeToVendorType(baseType);
    if (!mappedVendorType || !reachFlags || !primaryLabel || !primaryServiceMode) return;

    const resolvedShopName = resolveRegistrationShopName(baseType, ownerName, shopName);
    const radiusKm =
      reachFlags.serves_at_customer_place && serviceRadiusKm != null
        ? serviceRadiusKm
        : vendor.service_radius_km;

    const upiChanged = upiId.trim() !== (vendor.upi_id ?? "").trim();
    const phoneChanged = phone.trim() !== (vendor.phone ?? "").trim();

    setSaving(true);
    let patchError: { message: string } | null = null;
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await patchVendorOwn(vendor.id, vendorPhone || phone.trim(), {
              name: ownerName.trim(),
              shop_name: resolvedShopName.trim(),
              category: primaryLabel,
              service_mode: primaryServiceMode,
              vendor_type: mappedVendorType,
              base_type: baseType,
              serves_at_vendor_place: reachFlags.serves_at_vendor_place,
              serves_at_customer_place: reachFlags.serves_at_customer_place,
              service_radius_km: radiusKm,
              phone: phone.trim(),
              upi_id: upiId.trim() || null,
              ...(upiChanged ? { upi_verified: false } : {}),
              ...(phoneChanged || upiChanged
                ? {
                    is_manual_verified: false,
                    verification_status: "identity_linked" as VerificationStatus,
                    shop_photo_url: upiChanged ? vendor.shop_photo_url : undefined,
                  }
                : {}),
            }),
          ),
        {
          onRetrying: () => showNetworkRetryingToast({ retrying: s.network_retrying }),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      patchError = error;
    } catch (err) {
      dismissNetworkRetryingToast();
      setSaving(false);
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void saveProfile(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
        return;
      }
      throw err;
    }

    if (patchError) {
      setSaving(false);
      toast.error(s.vendor_update_failed);
      return;
    }

    const categoryServiceModes = categoryIdsToSave.map((categoryId) => {
      const cat =
        availableCategories.find((c) => c.id === categoryId) ??
        selectedCategories.find((c) => c.id === categoryId);
      return cat?.service_mode ?? primaryServiceMode;
    });

    const { error: vcError } = await supabase.rpc("vendor_update_categories", {
      p_vendor_id: vendor.id,
      p_vendor_phone: phone.trim(),
      p_category_ids: categoryIdsToSave,
      p_category_service_modes: categoryServiceModes,
    });
    if (vcError) {
      setSaving(false);
      toast.error(s.vendor_categories_partial_save);
      return;
    }

    const { error: modesError } = await supabase.rpc("vendor_update_availability_modes", {
      p_vendor_id: vendor.id,
      p_vendor_phone: phone.trim(),
      p_modes: availabilityModes,
    });
    if (modesError) {
      setSaving(false);
      toast.error(s.vendor_update_failed);
      return;
    }

    const { error: syncError } = await supabase.rpc("vendor_sync_category_modes", {
      p_vendor_id: vendor.id,
      p_vendor_phone: phone.trim(),
      p_modes: availabilityModes,
    });
    setSaving(false);
    if (syncError) {
      toast.error(s.vendor_update_failed);
      return;
    }

    onVendorUpdated({
      ...vendor,
      name: ownerName.trim(),
      shop_name: resolvedShopName.trim(),
      category: primaryLabel,
      service_mode: primaryServiceMode,
      vendor_type: mappedVendorType,
      base_type: baseType,
      serves_at_vendor_place: reachFlags.serves_at_vendor_place,
      serves_at_customer_place: reachFlags.serves_at_customer_place,
      service_radius_km: radiusKm,
      phone: phone.trim(),
      upi_id: upiId.trim() || null,
      ...(upiChanged ? { upi_verified: false } : {}),
    });

    savedCategoryIdsRef.current = [...categoryIdsToSave];

    void invokeNotifyAdmin(
      "✏️ Vendor edited shop details",
      `${resolvedShopName.trim()} — ${primaryLabel} (${primaryServiceMode})`,
      { type: "vendor_edited", route: "settings", route_params: { vendor_id: vendor.id } },
    );
    toast.success(s.my_business_saved);
  };

  const verifyUpi = async () => {
    const trimmed = upiId.trim();
    if (!isValidUpi(trimmed)) {
      toast.error(s.vendor_upi_format_invalid, { description: s.vendor_upi_format_body });
      return;
    }
    if (trimmed !== (vendor.upi_id ?? "").trim()) {
      toast.error(s.my_business_save_before_verify);
      return;
    }
    setVerifyingUpi(true);
    await new Promise((r) => setTimeout(r, 900));
    const bank = trimmed.split("@")[1] ?? "bank";
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await patchVendorOwn(vendor.id, vendor.phone, { upi_verified: true }),
          ),
        {
          onRetrying: () => showNetworkRetryingToast({ retrying: s.network_retrying }),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (error) {
        toast.error(s.vendor_upi_check_failed, { description: error.message });
        return;
      }
      void checkAndNotifyAdminGreenReady(vendor.id);
      onVendorUpdated({ ...vendor, upi_verified: true });
      toast.success(`${s.vendor_upi_verified}${bank.toUpperCase()}`, {
        description: s.vendor_upi_bank_valid,
      });
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void verifyUpi(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      setVerifyingUpi(false);
    }
  };

  const handleShopPhoto = async (shot: CapturedShot) => {
    setCameraOpen(false);
    const hasShopLocation = vendor.latitude != null && vendor.longitude != null;
    let gpsMatchDistance = 0;
    if (hasShopLocation) {
      const meters = distanceMeters(
        { lat: vendor.latitude!, lng: vendor.longitude! },
        shot.coords,
      );
      if (meters > GPS_MATCH_TOLERANCE_M) {
        toast.error(s.vendor_mismatch_title, {
          description: `Photo was taken ${Math.round(meters)} m from your shop. Must be within ${GPS_MATCH_TOLERANCE_M} m.`,
        });
        return;
      }
      gpsMatchDistance = Math.round(meters);
    }

    const path = `${vendor.id}/${Date.now()}.jpg`;
    try {
      const { error: upErr } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.storage.from(SHOP_PHOTOS_BUCKET).upload(path, shot.blob, {
              contentType: "image/jpeg",
              upsert: true,
            }),
          ),
        {
          onRetrying: () => showNetworkRetryingToast({ retrying: s.network_retrying }),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (upErr) {
        toast.error(s.vendor_upload_failed, { description: upErr.message });
        return;
      }
      const { data: pub } = supabase.storage.from(SHOP_PHOTOS_BUCKET).getPublicUrl(path);
      const { error: updErr } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await patchVendorOwn(vendor.id, vendor.phone, {
              shop_photo_url: pub.publicUrl,
              verification_status: "business_verified",
              gps_match_distance: gpsMatchDistance,
              is_manual_verified: false,
              ...(hasShopLocation
                ? {}
                : { latitude: shot.coords.lat, longitude: shot.coords.lng }),
            }),
          ),
        {
          onRetrying: () => showNetworkRetryingToast({ retrying: s.network_retrying }),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (updErr) {
        toast.error(s.vendor_save_verification_failed, { description: updErr.message });
        return;
      }
      void checkAndNotifyAdminGreenReady(vendor.id);
      onVendorUpdated({
        ...vendor,
        shop_photo_url: pub.publicUrl,
        verification_status: "business_verified",
        gps_match_distance: gpsMatchDistance,
        is_manual_verified: false,
        ...(hasShopLocation
          ? {}
          : { latitude: shot.coords.lat, longitude: shot.coords.lng }),
      });
      toast.success(s.vendor_photo_verified, {
        description: vendor.is_manual_verified ? s.vendor_green_badge_live : s.vendor_awaiting_admin,
      });
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void handleShopPhoto(shot), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    }
  };

  const handleSelfiePhoto = async (shot: CapturedShot) => {
    setSelfieCameraOpen(false);
    const path = `${vendor.id}/selfie.jpg`;
    try {
      const { error: upErr } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.storage.from(VENDOR_SELFIES_BUCKET).upload(path, shot.blob, {
              contentType: "image/jpeg",
              upsert: true,
            }),
          ),
        {
          onRetrying: () => showNetworkRetryingToast({ retrying: s.network_retrying }),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (upErr) {
        toast.error(s.vendor_upload_failed, { description: upErr.message });
        return;
      }
      const { data: pub } = supabase.storage.from(VENDOR_SELFIES_BUCKET).getPublicUrl(path);
      const { error: updErr } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await patchVendorOwn(vendor.id, vendor.phone, { photo_selfie: pub.publicUrl }),
          ),
        {
          onRetrying: () => showNetworkRetryingToast({ retrying: s.network_retrying }),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (updErr) {
        toast.error(s.vendor_save_verification_failed, { description: updErr.message });
        return;
      }
      await supabase.rpc("submit_vendor_verification", {
        p_vendor_id: vendor.id,
        p_vendor_phone: vendor.phone,
        p_check_type: "photo_selfie",
        p_doc_url: pub.publicUrl,
      });
      onVendorUpdated({ ...vendor, photo_selfie: pub.publicUrl });
      toast.success(s.vendor_selfie_captured);
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void handleSelfiePhoto(shot), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    }
  };

  const updateShopLocation = async () => {
    if (
      vendor.verification_status === "business_verified" ||
      vendor.verification_status === "green_pending"
    ) {
      const ok = window.confirm(s.vendor_location_reset_confirm);
      if (!ok) return;
    }
    if (!("geolocation" in navigator)) {
      toast.error(s.vendor_geo_not_supported);
      return;
    }
    setUpdatingLocation(true);
    const coords = await new Promise<{ lat: number; lng: number } | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => {
          toast.error(s.vendor_location_failed);
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
      );
    });
    if (!coords) {
      setUpdatingLocation(false);
      return;
    }

    const downgraded =
      vendor.verification_status === "business_verified" ||
      vendor.verification_status === "green_pending";
    const patch: Partial<Vendor> = {
      latitude: coords.lat,
      longitude: coords.lng,
      ...(downgraded
        ? {
            verification_status: "identity_linked" as VerificationStatus,
            shop_photo_url: null,
            is_manual_verified: false,
          }
        : {}),
    };

    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(await patchVendorOwn(vendor.id, vendor.phone, patch)),
        {
          onRetrying: () => showNetworkRetryingToast({ retrying: s.network_retrying }),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (error) {
        toast.error(s.vendor_location_update_failed, { description: error.message });
        return;
      }
      onVendorUpdated({ ...vendor, ...patch });
      toast(downgraded ? s.vendor_reverification_required : s.vendor_location_updated, {
        description: downgraded ? s.vendor_reverification_body : s.vendor_location_updated_body,
      });
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void updateShopLocation(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      setUpdatingLocation(false);
    }
  };

  const hasShopPhoto =
    vendor.shop_photo_url != null && String(vendor.shop_photo_url).trim() !== "";
  const hasSelfie = vendor.photo_selfie != null && String(vendor.photo_selfie).trim() !== "";
  const hasLocation = vendor.latitude != null && vendor.longitude != null;

  return (
    <div data-testid="vendor-my-business" className="px-4 mb-6 space-y-4">
      <SettingsCard className="mx-0 border-surface-border space-y-4 pb-4">
        <div className="px-4 pt-4">
          <SettingsSectionLabel>{s.settings_myBusiness}</SettingsSectionLabel>
          <p className="mt-1 text-xs text-muted-foreground">{s.my_business_hint}</p>
        </div>

        <div className="px-4 space-y-4">
          <Field
            label={s.vendor_your_name}
            value={ownerName}
            onChange={setOwnerName}
            placeholder={s.vendor_name_placeholder}
            required
            error={ownerName.length > 0 && !ownerOk ? s.vendor_name_invalid : undefined}
          />

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.reg_where_work_from}
            </label>
            <div className="mt-2 grid grid-cols-1 gap-2">
              {(
                [
                  { value: "shop" as const, emoji: "🏪", title: s.reg_base_shop, desc: s.reg_base_shop_desc },
                  { value: "home" as const, emoji: "🏠", title: s.reg_base_home, desc: s.reg_base_home_desc },
                  { value: "none" as const, emoji: "🚫", title: s.reg_base_none, desc: s.reg_base_none_desc },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`my-business-base-${opt.value}`}
                  onClick={() => setBaseType(opt.value)}
                  className={cn(
                    "rounded-2xl border-2 p-3 text-left transition-colors active:scale-[0.98]",
                    "bg-surface border-surface-border",
                    baseType === opt.value && "border-primary bg-primary/15 ring-1 ring-primary/30",
                  )}
                >
                  <p className="text-base font-display font-bold text-foreground leading-tight">
                    {opt.emoji} {opt.title}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground leading-snug">{opt.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {baseType === "shop" && (
            <Field
              label={s.vendor_shop_name}
              value={shopName}
              onChange={setShopName}
              placeholder={s.vendor_shop_placeholder}
              required
              error={shopName.length > 0 && !shopFieldOk ? s.vendor_specify_hint : undefined}
            />
          )}
          {baseType === "home" && (
            <Field
              label={s.vendor_brand_name_optional}
              value={shopName}
              onChange={setShopName}
              placeholder={s.vendor_brand_placeholder}
              error={shopNameInvalid ? s.vendor_specify_hint : undefined}
            />
          )}

          <div>
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {s.vendor_categories_label}
              </label>
              <span className="text-xs text-muted-foreground">
                {s.vendor_categories_selected(selectedCategoryIds.length)}
              </span>
            </div>
            {categoriesLoading ? (
              <p className="mt-2 text-xs text-muted-foreground inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {s.vendor_understanding}
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2" data-testid="my-business-categories">
                {availableCategories.map((cat) => {
                  const selected = selectedCategoryIds.includes(cat.id);
                  const atMax = selectedCategoryIds.length >= MAX_REG_CATEGORIES;
                  const disabled = !selected && atMax;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      data-testid={`vendor-edit-category-${cat.id}`}
                      disabled={disabled}
                      onClick={() => toggleCategory(cat.id)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                        selected
                          ? "border-primary bg-primary/20 text-foreground ring-1 ring-primary/30"
                          : "border-border bg-card text-foreground",
                        disabled && "opacity-40 cursor-not-allowed",
                      )}
                    >
                      <span>
                        {cat.emoji} {getLabel(cat.label)}
                      </span>
                      <span className="text-[10px] font-normal text-muted-foreground">
                        {categoryServiceModeChipLabel(cat.service_mode, s)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.reg_edit_reach_label}
            </label>
            <p className="mt-1 text-xs text-muted-foreground">{s.my_business_reach_hint}</p>
            <div className="mt-2 space-y-2">
              {(
                [
                  { value: "customer" as const, label: s.reg_reach_customer, desc: s.reg_reach_customer_desc },
                  { value: "vendor" as const, label: s.reg_reach_vendor, desc: s.reg_reach_vendor_desc },
                  { value: "both" as const, label: s.reg_reach_both, desc: s.reg_reach_both_desc },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`my-business-reach-${opt.value}`}
                  onClick={() => setReachChoice(opt.value)}
                  className={cn(
                    "w-full rounded-xl border p-3 text-left",
                    reachChoice === opt.value
                      ? "border-primary bg-primary/15 ring-1 ring-primary/30"
                      : "border-border bg-card",
                  )}
                >
                  <p className="text-sm font-semibold text-foreground">{opt.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{opt.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {needsRadius && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {s.vendor_radius_label}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{s.vendor_radius_hint}</p>
              <div className="mt-3" data-testid="my-business-radius">
                <ServiceRadiusChips value={serviceRadiusKm} onChange={setServiceRadiusKm} />
              </div>
            </div>
          )}

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.reg_edit_availability_label}
            </label>
            <div className="mt-2 flex flex-wrap gap-2" data-testid="my-business-availability">
              {(
                [
                  { mode: "help" as const, label: s.reg_avail_help },
                  { mode: "delivery" as const, label: s.reg_avail_delivery },
                  { mode: "appointment" as const, label: s.reg_avail_appointment },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.mode}
                  type="button"
                  onClick={() =>
                    setAvailabilityModes((prev) =>
                      prev.includes(opt.mode)
                        ? prev.length <= 1
                          ? prev
                          : prev.filter((m) => m !== opt.mode)
                        : [...prev, opt.mode],
                    )
                  }
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-sm font-medium",
                    availabilityModes.includes(opt.mode)
                      ? "border-primary bg-primary/20"
                      : "border-border",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <Field
            label={s.vendor_phone_label}
            value={phone}
            onChange={setPhone}
            placeholder={s.vendor_phone_placeholder}
            required
            error={
              phone.length > 0 && !isValidPhone(phone) ? s.vendor_phone_invalid_body : undefined
            }
          />
          <Field
            label={s.vendor_upi_label}
            value={upiId}
            onChange={setUpiId}
            placeholder={s.vendor_upi_placeholder}
          />
        </div>

        <VerifyRow
          label={s.vendor_upi_bank_match}
          verified={vendor.upi_verified === true}
          verifiedLabel={s.my_business_verified}
          actionLabel={s.my_business_verify_now}
          onAction={() => void verifyUpi()}
          actionLoading={verifyingUpi}
          actionDisabled={!isValidUpi(upiId.trim())}
        />

        <VerifyRow
          label={s.vendor_verification_shop}
          hint={s.my_business_shop_photo_hint}
          verified={hasShopPhoto}
          verifiedLabel={s.my_business_verified}
          actionLabel={hasShopPhoto ? s.vendor_reshoot : s.my_business_verify_now}
          onAction={() => setCameraOpen(true)}
          actionDisabled={!hasLocation && baseType !== "none"}
        >
          {hasShopPhoto && (
            <img
              src={vendor.shop_photo_url!}
              alt={s.vendor_captured_shop}
              className="w-full rounded-xl border border-border"
            />
          )}
        </VerifyRow>

        <VerifyRow
          label={s.vendor_selfie_title}
          hint={s.vendor_selfie_subtitle}
          verified={hasSelfie}
          verifiedLabel={s.my_business_verified}
          actionLabel={hasSelfie ? s.vendor_selfie_reshoot : s.my_business_verify_now}
          onAction={() => setSelfieCameraOpen(true)}
          actionDisabled={!hasShopPhoto}
        >
          {hasSelfie && (
            <img
              src={vendor.photo_selfie!}
              alt={s.vendor_selfie_title}
              className="w-full max-w-xs rounded-xl border border-border"
            />
          )}
        </VerifyRow>

        <VerifyRow
          label={s.my_business_location_label}
          hint={
            hasLocation
              ? `📍 ${vendor.latitude!.toFixed(4)}, ${vendor.longitude!.toFixed(4)}`
              : s.vendor_location_missing_body
          }
          verified={hasLocation}
          verifiedLabel={s.my_business_verified}
          actionLabel={s.my_business_confirm_location}
          onAction={() => void updateShopLocation()}
          actionLoading={updatingLocation}
        />

        <div className="px-4 pb-2">
          <button
            type="button"
            data-testid="my-business-save"
            onClick={() => void saveProfile()}
            disabled={!saveReady || saving}
            className="w-full rounded-2xl bg-primary text-primary-foreground py-3.5 text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {s.menu_save}
          </button>
        </div>
      </SettingsCard>

      <LiveCamera open={cameraOpen} onClose={() => setCameraOpen(false)} onCapture={handleShopPhoto} />
      <LiveCamera
        open={selfieCameraOpen}
        onClose={() => setSelfieCameraOpen(false)}
        onCapture={handleSelfiePhoto}
        facing="front"
        requireLocation={false}
      />
    </div>
  );
}
