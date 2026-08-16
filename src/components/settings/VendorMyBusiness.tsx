import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { ServiceRadiusChips } from "@/components/ServiceRadiusChips";
import { LiveCamera, type CapturedShot } from "@/components/LiveCamera";
import { BusinessVerificationBadge } from "@/components/VerificationBadge";
import { SettingsCard, SettingsSectionLabel } from "@/components/settings/SettingsSection";
import {
  supabase,
  type Vendor,
  type Category,
  type VerificationStatus,
  SHOP_PHOTOS_BUCKET,
  VENDOR_SELFIES_BUCKET,
  isValidPhone,
  isValidUpi,
  useCategoryLabel,
  invokeNotifyAdmin,
} from "@/lib/supabase";
import {
  GPS_MATCH_FAILS_BEFORE_SOFT_REVIEW,
  evaluateGpsMatch,
  logGpsMatchFailure,
  readGeolocationAccuracy,
} from "@/lib/gpsMatch";
import { patchVendorOwn } from "@/lib/vendorPatch";
import {
  checkAndNotifyAdminGreenReady,
  checkAndNotifyAdminCategoryGreenReady,
} from "@/lib/vendorGreenReady";
import { useLanguage } from "@/lib/language";
import { captureError } from "@/lib/sentry";
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
import {
  inheritCategorySettingsFromAccount,
} from "@/lib/categoryScopedVendor";
import { CategoryAvailabilityModeSelector } from "@/components/vendor/CategoryAvailabilityModeSelector";
import {
  allCategoriesHaveModes,
  buildCategoryModesPayload,
  normalizeAvailabilityModes,
  pickPrimaryAvailabilityMode,
  resolveCatalogServiceMode,
} from "@/lib/categoryAvailabilityModes";
import { BusinessSetupSheet } from "@/components/vendor/BusinessSetupSheet";
import { DeliveryFulfillmentSettings } from "@/components/vendor/DeliveryFulfillmentSettings";
import { VendorMyBusinessOperations } from "@/components/settings/VendorMyBusinessOperations";
import {
  DEFAULT_DELIVERY_FULFILLMENT,
  DEFAULT_DELIVERY_PAYMENT_TIMING,
  deliveryPaymentTimingForFulfillment,
  normalizeDeliveryFulfillmentMethod,
  normalizeDeliveryPaymentTiming,
  type DeliveryFulfillmentMethod,
  type DeliveryPaymentTiming,
} from "@/lib/deliveryFulfillment";

type RegCategoryRow = Pick<Category, "id" | "label" | "emoji"> & {
  service_mode: string;
  shop_photo_url?: string | null;
  gps_match_distance?: number | null;
  verification_status?: string | null;
  is_manual_verified?: boolean | null;
  vendor_note?: string | null;
};

type CategoryEditSettings = {
  reachChoice: ReachChoiceValue;
  service_radius_km: number | null;
  vendor_note: string;
  shop_photo_url: string | null;
  gps_match_distance: number | null;
  verification_status: string | null;
  is_manual_verified: boolean;
  availability_modes: AvailabilityMode[];
  latitude: number | null;
  longitude: number | null;
  location_accuracy: number | null;
  delivery_fulfillment_method: DeliveryFulfillmentMethod;
  delivery_payment_timing: DeliveryPaymentTiming;
};

type Props = {
  vendor: Vendor;
  onVendorUpdated: (updated: Vendor) => void;
  userPhone?: string | null;
};

function settingsFromAccount(account: {
  shop_name?: string | null;
  serves_at_vendor_place?: boolean | null;
  serves_at_customer_place?: boolean | null;
  service_radius_km?: number | null;
}): CategoryEditSettings {
  const inherited = inheritCategorySettingsFromAccount(account);
  return {
    reachChoice:
      reachChoiceFromFlags(
        inherited.serves_at_vendor_place,
        inherited.serves_at_customer_place,
      ) || "customer",
    service_radius_km: inherited.service_radius_km,
    vendor_note: "",
    shop_photo_url: null,
    gps_match_distance: null,
    verification_status: null,
    is_manual_verified: false,
    availability_modes: [],
    latitude: null,
    longitude: null,
    location_accuracy: null,
    delivery_fulfillment_method: DEFAULT_DELIVERY_FULFILLMENT,
    delivery_payment_timing: DEFAULT_DELIVERY_PAYMENT_TIMING,
  };
}

function settingsFromCategoryRow(
  row: {
    serves_at_vendor_place?: boolean | null;
    serves_at_customer_place?: boolean | null;
    service_radius_km?: number | null;
    vendor_note?: string | null;
    shop_photo_url?: string | null;
    gps_match_distance?: number | null;
    verification_status?: string | null;
    is_manual_verified?: boolean | null;
    latitude?: number | null;
    longitude?: number | null;
    location_accuracy?: number | null;
    delivery_fulfillment_method?: string | null;
    delivery_payment_timing?: string | null;
  },
  accountFallback: CategoryEditSettings,
): CategoryEditSettings {
  const reach =
    reachChoiceFromFlags(row.serves_at_vendor_place, row.serves_at_customer_place) ||
    accountFallback.reachChoice;
  return {
    reachChoice: reach,
    service_radius_km:
      row.service_radius_km != null && Number.isFinite(Number(row.service_radius_km))
        ? Number(row.service_radius_km)
        : accountFallback.service_radius_km,
    vendor_note: String(row.vendor_note ?? "").trim(),
    shop_photo_url: row.shop_photo_url ?? null,
    gps_match_distance:
      row.gps_match_distance != null ? Number(row.gps_match_distance) : null,
    verification_status: row.verification_status ?? null,
    is_manual_verified: row.is_manual_verified === true,
    availability_modes: [],
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    location_accuracy:
      row.location_accuracy != null ? Number(row.location_accuracy) : null,
    delivery_fulfillment_method: normalizeDeliveryFulfillmentMethod(
      row.delivery_fulfillment_method,
    ),
    delivery_payment_timing: deliveryPaymentTimingForFulfillment(
      normalizeDeliveryFulfillmentMethod(row.delivery_fulfillment_method),
      normalizeDeliveryPaymentTiming(row.delivery_payment_timing),
    ),
  };
}

function categoryHasDeliveryMode(modes: AvailabilityMode[]): boolean {
  return modes.includes("delivery");
}

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
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  error?: string;
  type?: string;
  testId?: string;
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
        data-testid={testId}
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
  const [serviceRadiusKm, setServiceRadiusKm] = useState<number | null>(null);
  const [phone, setPhone] = useState(vendor.phone ?? "");
  const [upiId, setUpiId] = useState(vendor.upi_id ?? "");
  const [availableCategories, setAvailableCategories] = useState<RegCategoryRow[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<RegCategoryRow[]>([]);
  const [categorySettingsById, setCategorySettingsById] = useState<
    Record<string, CategoryEditSettings>
  >({});
  const [photoCategoryId, setPhotoCategoryId] = useState<string | null>(null);
  const [addBusinessOpen, setAddBusinessOpen] = useState(false);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingLockRef = useRef(false);
  const [verifyingUpi, setVerifyingUpi] = useState(false);
  const [updatingLocation, setUpdatingLocation] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [selfieCameraOpen, setSelfieCameraOpen] = useState(false);
  const [gpsMatchFailCount, setGpsMatchFailCount] = useState(0);
  const [lastFailedShopShot, setLastFailedShopShot] = useState<CapturedShot | null>(null);

  const loadSeqRef = useRef(0);
  const selectedCategoryIdsRef = useRef<string[]>([]);
  const savedCategoryIdsRef = useRef<string[]>([]);
  const [categoriesReloadKey, setCategoriesReloadKey] = useState(0);

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
      const [availResult, vcResult] = await Promise.all([
        supabase
          .from("categories")
          .select("id, label, emoji, service_mode")
          .eq("is_active", true)
          .order("sort_order", { ascending: true }),
        supabase
          .from("vendor_categories")
          .select(
            "id, category_id, is_primary, brand_name, serves_at_vendor_place, serves_at_customer_place, service_radius_km, vendor_note, shop_photo_url, gps_match_distance, verification_status, is_manual_verified, latitude, longitude, location_accuracy, delivery_fulfillment_method, delivery_payment_timing, categories(id, label, emoji, service_mode)",
          )
          .eq("vendor_id", vendor.id)
          .eq("status", "approved")
          .order("is_primary", { ascending: false }),
      ]);

      if (loadSeq !== loadSeqRef.current) return;

      if (availResult.error) {
        captureError(availResult.error, {
          scope: "vendorMyBusiness.loadCategories",
          vendorId: vendor.id,
        });
      }
      if (vcResult.error) {
        captureError(vcResult.error, {
          scope: "vendorMyBusiness.loadVendorCategories",
          vendorId: vendor.id,
        });
      }

      const available = (availResult.data ?? []) as RegCategoryRow[];
      setAvailableCategories(available);

      let selected: RegCategoryRow[] = [];
      const accountDefaults = settingsFromAccount({
        shop_name: vendor.shop_name,
        serves_at_vendor_place: vendor.serves_at_vendor_place,
        serves_at_customer_place: vendor.serves_at_customer_place,
        service_radius_km: vendor.service_radius_km,
      });
      const nextSettings: Record<string, CategoryEditSettings> = {};
      const vcIdToCategoryId: Record<string, string> = {};
      if (!vcResult.error && vcResult.data?.length) {
        for (const row of vcResult.data) {
          const joined = row.categories;
          const cat = Array.isArray(joined) ? joined[0] : joined;
          if (!cat) continue;
          vcIdToCategoryId[row.id] = cat.id;
          selected.push({
            id: cat.id,
            label: cat.label,
            emoji: cat.emoji,
            service_mode: cat.service_mode,
            shop_photo_url: row.shop_photo_url,
            gps_match_distance: row.gps_match_distance,
            verification_status: row.verification_status,
            is_manual_verified: row.is_manual_verified,
            vendor_note: row.vendor_note,
          });
          nextSettings[cat.id] = settingsFromCategoryRow(row, accountDefaults);
        }
      }
      if (selected.length === 0 && vendor.category) {
        const legacy = available.find((c) => c.label === vendor.category);
        if (legacy) {
          selected = [legacy];
          nextSettings[legacy.id] = {
            ...accountDefaults,
            availability_modes: normalizeAvailabilityModes([
              vendor.service_mode ?? legacy.service_mode ?? "help",
            ]),
          };
        }
      }

      const vcIds = Object.keys(vcIdToCategoryId);
      if (vcIds.length > 0) {
        const modesResult = await supabase
          .from("vendor_category_modes")
          .select("mode, vendor_category_id")
          .in("vendor_category_id", vcIds);
        if (loadSeq !== loadSeqRef.current) return;
        const modesByCategoryId: Record<string, AvailabilityMode[]> = {};
        for (const modeRow of modesResult.data ?? []) {
          const catId = vcIdToCategoryId[modeRow.vendor_category_id];
          if (!catId) continue;
          if (!modesByCategoryId[catId]) modesByCategoryId[catId] = [];
          const mode = String(modeRow.mode ?? "").trim().toLowerCase();
          if (mode === "help" || mode === "delivery" || mode === "appointment") {
            modesByCategoryId[catId].push(mode);
          }
        }
        for (const catId of Object.keys(modesByCategoryId)) {
          if (nextSettings[catId]) {
            nextSettings[catId] = {
              ...nextSettings[catId],
              availability_modes: normalizeAvailabilityModes(modesByCategoryId[catId]),
            };
          }
        }
      }

      const selectedIds = selected.map((c) => c.id);
      selectedCategoryIdsRef.current = selectedIds;
      savedCategoryIdsRef.current = selectedIds;
      setSelectedCategories(selected);
      setSelectedCategoryIds(selectedIds);
      setCategorySettingsById(nextSettings);
      setPhotoCategoryId((prev) =>
        prev && selectedIds.includes(prev) ? prev : selectedIds[0] ?? null,
      );

      setCategoriesLoading(false);
    })();
  }, [
    vendor.id,
    vendor.category,
    vendor.service_mode,
    vendor.shop_name,
    vendor.serves_at_vendor_place,
    vendor.serves_at_customer_place,
    vendor.service_radius_km,
    categoriesReloadKey,
  ]);

  const isMultiCategory = selectedCategoryIds.length > 1;

  const accountDefaultsForInherit = (): CategoryEditSettings =>
    settingsFromAccount({
      shop_name: shopName.trim() || vendor.shop_name,
      serves_at_vendor_place: reachFlagsFromChoice(reachChoice)?.serves_at_vendor_place,
      serves_at_customer_place: reachFlagsFromChoice(reachChoice)?.serves_at_customer_place,
      service_radius_km: serviceRadiusKm,
    });

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
      setCategorySettingsById((prevSettings) => {
        const nextSettings = { ...prevSettings };
        for (const id of next) {
          if (!nextSettings[id]) {
            const catalogMode =
              availableCategories.find((c) => c.id === id)?.service_mode ??
              selectedCategories.find((c) => c.id === id)?.service_mode ??
              null;
            nextSettings[id] = {
              ...accountDefaultsForInherit(),
              availability_modes: normalizeAvailabilityModes(
                catalogMode ? [catalogMode] : ["help"],
              ),
            };
          }
        }
        for (const id of Object.keys(nextSettings)) {
          if (!next.includes(id)) delete nextSettings[id];
        }
        return nextSettings;
      });
      return next;
    });
  };

  const updateCategorySettings = (
    categoryId: string,
    patch: Partial<CategoryEditSettings>,
  ) => {
    setCategorySettingsById((prev) => ({
      ...prev,
      [categoryId]: {
        ...(prev[categoryId] ?? accountDefaultsForInherit()),
        ...patch,
      },
    }));
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

  const multiCategorySettingsOk = selectedCategoryIds.every((id) => {
    const cfg = categorySettingsById[id] ?? accountDefaultsForInherit();
    if (!cfg.reachChoice) return false;
    const needsCatRadius = cfg.reachChoice === "customer" || cfg.reachChoice === "both";
    if (needsCatRadius && cfg.service_radius_km == null) return false;
    return true;
  });

  const modesByCategoryId = Object.fromEntries(
    selectedCategoryIds.map((id) => [id, categorySettingsById[id]?.availability_modes]),
  );
  const allCategoryModesOk = allCategoriesHaveModes(selectedCategoryIds, modesByCategoryId);

  const saveReady =
    ownerOk &&
    baseType !== "" &&
    shopFieldOk &&
    selectedCategoryIds.length > 0 &&
    phone.trim().length > 0 &&
    (isMultiCategory ? multiCategorySettingsOk : reachChoice !== "" && radiusOk) &&
    allCategoryModesOk;

  const saveProfile = async () => {
    if (!saveReady || savingLockRef.current) return;
    // Sync lock before React re-render so rapid multi-tap cannot re-enter.
    savingLockRef.current = true;
    setSaving(true);

    const releaseSaveLock = () => {
      savingLockRef.current = false;
      setSaving(false);
    };

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
        setCategorySettingsById((prev) => {
          const next: Record<string, CategoryEditSettings> = {};
          for (const id of restoredIds) {
            next[id] = prev[id] ?? accountDefaultsForInherit();
          }
          return next;
        });
        releaseSaveLock();
        return;
      }
    }
    const primaryCategory =
      availableCategories.find((c) => c.id === categoryIdsToSave[0]) ??
      selectedCategories.find((c) => c.id === categoryIdsToSave[0]) ??
      null;
    const primaryLabel = primaryCategory?.label ?? "";
    const primaryCatModes =
      categorySettingsById[categoryIdsToSave[0]]?.availability_modes ?? [];
    const primaryServiceMode = pickPrimaryAvailabilityMode(
      primaryCatModes,
      primaryCategory?.service_mode ?? vendor.service_mode,
    );

    const multi = categoryIdsToSave.length > 1;
    const primaryCatSettings =
      categorySettingsById[categoryIdsToSave[0]] ?? accountDefaultsForInherit();
    const effectiveReachChoice = multi ? primaryCatSettings.reachChoice : reachChoice;
    const effectiveRadiusKm = multi ? primaryCatSettings.service_radius_km : serviceRadiusKm;
    const reachFlags = effectiveReachChoice
      ? reachFlagsFromChoice(effectiveReachChoice)
      : null;
    const mappedVendorType = baseTypeToVendorType(baseType);
    if (!mappedVendorType || !reachFlags || !primaryLabel || !primaryServiceMode) {
      releaseSaveLock();
      return;
    }

    const resolvedShopName = resolveRegistrationShopName(baseType, ownerName, shopName);
    const radiusKm =
      reachFlags.serves_at_customer_place && effectiveRadiusKm != null
        ? effectiveRadiusKm
        : vendor.service_radius_km;

    const brandNames = categoryIdsToSave.map(() => resolvedShopName.trim());
    const servesVendorPlace = categoryIdsToSave.map((id) => {
      if (!multi) return reachFlags.serves_at_vendor_place;
      const cfg = categorySettingsById[id] ?? accountDefaultsForInherit();
      return reachFlagsFromChoice(cfg.reachChoice)?.serves_at_vendor_place === true;
    });
    const servesCustomerPlace = categoryIdsToSave.map((id) => {
      if (!multi) return reachFlags.serves_at_customer_place;
      const cfg = categorySettingsById[id] ?? accountDefaultsForInherit();
      return reachFlagsFromChoice(cfg.reachChoice)?.serves_at_customer_place === true;
    });
    const radii = categoryIdsToSave.map((id, i) => {
      if (!servesCustomerPlace[i]) return null;
      if (!multi) return serviceRadiusKm;
      const cfg = categorySettingsById[id] ?? accountDefaultsForInherit();
      return cfg.service_radius_km;
    });
    const deliveryFulfillmentMethods = categoryIdsToSave.map((id) => {
      const cfg = categorySettingsById[id] ?? accountDefaultsForInherit();
      return cfg.delivery_fulfillment_method;
    });
    const deliveryPaymentTimings = categoryIdsToSave.map((id) => {
      const cfg = categorySettingsById[id] ?? accountDefaultsForInherit();
      return deliveryPaymentTimingForFulfillment(
        cfg.delivery_fulfillment_method,
        cfg.delivery_payment_timing,
      );
    });

    const upiChanged = upiId.trim() !== (vendor.upi_id ?? "").trim();
    const phoneChanged = phone.trim() !== (vendor.phone ?? "").trim();

    const categoryServiceModes = categoryIdsToSave.map((categoryId) => {
      const cat =
        availableCategories.find((c) => c.id === categoryId) ??
        selectedCategories.find((c) => c.id === categoryId);
      const modes = categorySettingsById[categoryId]?.availability_modes ?? [];
      return pickPrimaryAvailabilityMode(modes, cat?.service_mode);
    });
    const categoryModesPayload = buildCategoryModesPayload(
      categoryIdsToSave,
      Object.fromEntries(
        categoryIdsToSave.map((id) => [id, categorySettingsById[id]?.availability_modes]),
      ),
    );

    const patch: Record<string, unknown> = {
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
      ...(phoneChanged || upiChanged
        ? {
            is_manual_verified: false,
            shop_photo_url: upiChanged ? vendor.shop_photo_url : undefined,
          }
        : {}),
    };

    let saveError: { message: string } | null = null;
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("vendor_update_profile_and_categories", {
              p_vendor_id: vendor.id,
              p_vendor_phone: vendorPhone || phone.trim(),
              p_patch: patch,
              p_category_ids: categoryIdsToSave,
              p_category_service_modes: categoryServiceModes,
              p_category_modes: categoryModesPayload,
              p_brand_names: brandNames,
              p_serves_at_vendor_place: servesVendorPlace,
              p_serves_at_customer_place: servesCustomerPlace,
              p_service_radius_km: radii,
              p_delivery_fulfillment_methods: deliveryFulfillmentMethods,
              p_delivery_payment_timings: deliveryPaymentTimings,
            }),
          ),
        {
          onRetrying: () => showNetworkRetryingToast({ retrying: s.network_retrying }),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      saveError = error;
    } catch (err) {
      dismissNetworkRetryingToast();
      releaseSaveLock();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void saveProfile(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
        return;
      }
      throw err;
    }

    if (saveError) {
      releaseSaveLock();
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
      ...(phoneChanged || upiChanged
        ? {
            is_manual_verified: false,
            verification_status: "identity_linked" as VerificationStatus,
          }
        : {}),
    });

    savedCategoryIdsRef.current = [...categoryIdsToSave];

    void invokeNotifyAdmin(
      "✏️ Vendor edited shop details",
      `${resolvedShopName.trim()} — ${primaryLabel} (${primaryServiceMode})`,
      { type: "vendor_edited", route: "settings", route_params: { vendor_id: vendor.id } },
    );
    toast.success(s.my_business_saved);
    releaseSaveLock();
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
    const bank = trimmed.split("@")[1] ?? "bank";
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("vendor_verify_upi", {
              p_vendor_id: vendor.id,
              p_vendor_phone: vendor.phone,
              p_upi_id: trimmed,
            }),
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
      void checkAndNotifyAdminGreenReady(vendor.id, {
        shopName: vendor.shop_name,
        vendorPhone: vendorPhone || phone.trim(),
      });
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

  const handleShopPhoto = async (
    shot: CapturedShot,
    opts?: { pendingLocationReview?: boolean },
  ) => {
    setCameraOpen(false);
    const targetCategoryId = photoCategoryId ?? selectedCategoryIds[0] ?? null;
    if (!targetCategoryId) {
      toast.error(s.vendor_categories_required);
      return;
    }
    const catSettings = categorySettingsById[targetCategoryId];
    const bizLat = catSettings?.latitude ?? null;
    const bizLng = catSettings?.longitude ?? null;
    const hasBusinessPin = bizLat != null && bizLng != null;
    const accountEmpty = vendor.latitude == null || vendor.longitude == null;
    let gpsMatchDistance = 0;
    let locationAccuracy: number | null = null;
    let photoAccuracy: number | null = shot.coords.accuracy;
    let pendingLocationReview = opts?.pendingLocationReview === true;

    if (hasBusinessPin) {
      const match = evaluateGpsMatch(
        {
          lat: bizLat!,
          lng: bizLng!,
          accuracy: catSettings?.location_accuracy ?? vendor.location_accuracy,
        },
        shot.coords,
      );
      locationAccuracy = match.locationAccuracy;
      photoAccuracy = match.photoAccuracy;
      if (!match.ok && !pendingLocationReview) {
        setGpsMatchFailCount((n) => n + 1);
        setLastFailedShopShot(shot);
        void logGpsMatchFailure({
          distanceMeters: match.distanceMeters,
          locationAccuracy: match.locationAccuracy,
          photoAccuracy: match.photoAccuracy,
          effectiveTolerance: match.effectiveTolerance,
          source: "my_business",
          vendorId: vendor.id,
        });
        toast.error(s.vendor_mismatch_title, {
          description: s.vendor_mismatch_distance(
            Math.round(match.distanceMeters),
            Math.round(match.effectiveTolerance),
          ),
        });
        return;
      }
      gpsMatchDistance = Math.round(match.distanceMeters);
      if (!match.ok) pendingLocationReview = true;
    }

    const path = `${vendor.id}/${targetCategoryId}/${Date.now()}.jpg`;
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
            await supabase.rpc("vendor_submit_category_shop_photo", {
              p_vendor_id: vendor.id,
              p_vendor_phone: vendorPhone || phone.trim(),
              p_category_id: targetCategoryId,
              p_shop_photo_url: pub.publicUrl,
              p_gps_match_distance: gpsMatchDistance,
              p_set_account_lat: accountEmpty ? shot.coords.lat : null,
              p_set_account_lng: accountEmpty ? shot.coords.lng : null,
              p_pending_location_review: pendingLocationReview,
              p_location_accuracy: locationAccuracy,
              p_photo_accuracy: photoAccuracy,
              p_set_account_location_accuracy: accountEmpty
                ? shot.coords.accuracy
                : null,
              p_business_lat: hasBusinessPin ? bizLat : shot.coords.lat,
              p_business_lng: hasBusinessPin ? bizLng : shot.coords.lng,
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
      setLastFailedShopShot(null);
      setGpsMatchFailCount(0);
      if (!pendingLocationReview) {
        void checkAndNotifyAdminCategoryGreenReady(vendor.id, targetCategoryId, {
          shopName: vendor.shop_name,
          vendorPhone: vendorPhone || phone.trim(),
        });
      }
      setCategorySettingsById((prev) => ({
        ...prev,
        [targetCategoryId]: {
          ...(prev[targetCategoryId] ?? accountDefaultsForInherit()),
          shop_photo_url: pub.publicUrl,
          gps_match_distance: gpsMatchDistance,
          verification_status: pendingLocationReview
            ? "pending_location_review"
            : "business_verified",
          is_manual_verified: false,
          latitude: hasBusinessPin ? bizLat : shot.coords.lat,
          longitude: hasBusinessPin ? bizLng : shot.coords.lng,
          location_accuracy: locationAccuracy,
        },
      }));
      if (accountEmpty) {
        onVendorUpdated({
          ...vendor,
          latitude: shot.coords.lat,
          longitude: shot.coords.lng,
          location_accuracy: shot.coords.accuracy,
        });
      }
      toast.success(
        pendingLocationReview ? s.vendor_gps_pending_review_toast : s.vendor_photo_verified,
        {
          description: pendingLocationReview ? undefined : s.vendor_awaiting_admin,
        },
      );
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void handleShopPhoto(shot, opts), {
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
      const { error: verifErr } = await supabase.rpc("submit_vendor_verification", {
        p_vendor_id: vendor.id,
        p_vendor_phone: vendor.phone,
        p_check_type: "photo_selfie",
        p_doc_url: pub.publicUrl,
      });
      if (verifErr) {
        captureError(verifErr, {
          scope: "vendorMyBusiness.submitSelfieVerification",
          vendorId: vendor.id,
        });
      }
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
    const anyVerifiedBiz = selectedCategoryIds.some((id) => {
      const cfg = categorySettingsById[id];
      const status = cfg?.verification_status;
      return (
        cfg?.is_manual_verified === true ||
        status === "business_verified" ||
        status === "green_pending" ||
        (cfg?.shop_photo_url != null && String(cfg.shop_photo_url).trim() !== "")
      );
    });
    if (anyVerifiedBiz) {
      const ok = window.confirm(s.vendor_location_reset_confirm);
      if (!ok) return;
    }
    if (!("geolocation" in navigator)) {
      toast.error(s.vendor_geo_not_supported);
      return;
    }
    setUpdatingLocation(true);
    const coords = await new Promise<{
      lat: number;
      lng: number;
      accuracy: number | null;
    } | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) =>
          resolve({
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            accuracy: readGeolocationAccuracy(p.coords),
          }),
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

    const downgraded = anyVerifiedBiz;
    // Location coordinates only; the verification downgrade (account +
    // categories) happens server-side in vendor_clear_category_photo_verifications
    // (verification_status is field_not_allowed in the generic patch).
    const patch: Partial<Vendor> = {
      latitude: coords.lat,
      longitude: coords.lng,
      location_accuracy: coords.accuracy,
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
      if (downgraded) {
        const { error: clearErr } = await supabase.rpc(
          "vendor_clear_category_photo_verifications",
          {
            p_vendor_id: vendor.id,
            p_vendor_phone: vendor.phone,
          },
        );
        if (clearErr) {
          toast.error(s.vendor_location_update_failed, { description: clearErr.message });
          return;
        }
        setCategorySettingsById((prev) => {
          const next = { ...prev };
          for (const id of selectedCategoryIds) {
            next[id] = {
              ...(next[id] ?? accountDefaultsForInherit()),
              shop_photo_url: null,
              gps_match_distance: null,
              verification_status: "identity_linked",
              is_manual_verified: false,
            };
          }
          return next;
        });
      }
      onVendorUpdated({
        ...vendor,
        ...patch,
        ...(downgraded
          ? {
              verification_status: "identity_linked" as VerificationStatus,
              shop_photo_url: null,
              is_manual_verified: false,
            }
          : {}),
      });
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

  const activePhotoCategoryId = photoCategoryId ?? selectedCategoryIds[0] ?? null;
  const activePhotoSettings = activePhotoCategoryId
    ? categorySettingsById[activePhotoCategoryId]
    : null;
  const hasShopPhoto =
    activePhotoSettings?.shop_photo_url != null &&
    String(activePhotoSettings.shop_photo_url).trim() !== "";
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
              testId="my-business-shop-name"
            />
          )}
          {baseType === "home" && !isMultiCategory && (
            <Field
              label={s.vendor_shop_name}
              value={shopName}
              onChange={setShopName}
              placeholder={s.vendor_shop_placeholder}
              error={shopNameInvalid ? s.vendor_specify_hint : undefined}
              testId="my-business-shop-name"
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
              <div className="mt-2 space-y-3" data-testid="my-business-categories">
                <div>
                  <p className="text-[11px] font-semibold text-foreground mb-1.5">
                    {s.vendor_categories_yours}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {selectedCategories.map((cat) => (
                      <button
                        key={cat.id}
                        type="button"
                        data-testid={`vendor-edit-category-${cat.id}`}
                        data-selected="true"
                        onClick={() => toggleCategory(cat.id)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors",
                          "border-primary bg-primary/20 text-foreground ring-1 ring-primary/30",
                        )}
                      >
                        <span>
                          {cat.emoji} {getLabel(cat.label)}
                        </span>
                        <span className="text-[10px] font-normal text-muted-foreground">
                          {categoryServiceModeChipLabel(cat.service_mode, s)}
                        </span>
                      </button>
                    ))}
                    {selectedCategories.length === 0 && (
                      <p className="text-xs text-muted-foreground">{s.vendor_categories_pick}</p>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">
                    {s.vendor_categories_available}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {availableCategories
                      .filter((cat) => !selectedCategoryIds.includes(cat.id))
                      .map((cat) => {
                        const atMax = selectedCategoryIds.length >= MAX_REG_CATEGORIES;
                        return (
                          <button
                            key={cat.id}
                            type="button"
                            data-testid={`vendor-edit-category-${cat.id}`}
                            data-selected="false"
                            disabled={atMax}
                            onClick={() => toggleCategory(cat.id)}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1.5 text-sm font-medium transition-colors",
                              "border-muted-foreground/40 bg-muted/30 text-muted-foreground",
                              atMax && "opacity-40 cursor-not-allowed",
                            )}
                          >
                            <span>
                              + {cat.emoji} {getLabel(cat.label)}
                            </span>
                            <span className="text-[10px] font-normal opacity-80">
                              {categoryServiceModeChipLabel(cat.service_mode, s)}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {isMultiCategory &&
            selectedCategories.map((cat) => {
              const cfg = categorySettingsById[cat.id] ?? accountDefaultsForInherit();
              const catNeedsRadius = cfg.reachChoice === "customer" || cfg.reachChoice === "both";
              return (
                <div
                  key={`cat-settings-${cat.id}`}
                  data-testid={`my-business-category-settings-${cat.id}`}
                  className="rounded-2xl border border-surface-border bg-muted/20 p-3 space-y-3"
                >
                  <p className="text-sm font-semibold text-foreground">
                    {cat.emoji} {getLabel(cat.label)}
                  </p>
                  <div>
                    <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {s.my_business_category_reach}
                    </label>
                    <div className="mt-2 space-y-2">
                      {(
                        [
                          {
                            value: "customer" as const,
                            label: s.reg_reach_customer,
                            desc: s.reg_reach_customer_desc,
                          },
                          {
                            value: "vendor" as const,
                            label: s.reg_reach_vendor,
                            desc: s.reg_reach_vendor_desc,
                          },
                          {
                            value: "both" as const,
                            label: s.reg_reach_both,
                            desc: s.reg_reach_both_desc,
                          },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          data-testid={`my-business-cat-reach-${cat.id}-${opt.value}`}
                          onClick={() =>
                            updateCategorySettings(cat.id, { reachChoice: opt.value })
                          }
                          className={cn(
                            "w-full rounded-xl border p-3 text-left",
                            cfg.reachChoice === opt.value
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
                  {catNeedsRadius && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {s.my_business_category_radius}
                      </p>
                      <div className="mt-3" data-testid={`my-business-cat-radius-${cat.id}`}>
                        <ServiceRadiusChips
                          value={cfg.service_radius_km}
                          onChange={(km) =>
                            updateCategorySettings(cat.id, { service_radius_km: km })
                          }
                        />
                      </div>
                    </div>
                  )}
                  <CategoryAvailabilityModeSelector
                    variant="pills"
                    label={s.my_business_category_availability}
                    required
                    testIdPrefix={`my-business-cat-avail-${cat.id}`}
                    catalogServiceMode={resolveCatalogServiceMode(cat.service_mode)}
                    value={cfg.availability_modes}
                    onChange={(modes) =>
                      updateCategorySettings(cat.id, { availability_modes: modes })
                    }
                  />
                  {categoryHasDeliveryMode(cfg.availability_modes) && (
                    <DeliveryFulfillmentSettings
                      testIdPrefix={`my-business-cat-delivery-${cat.id}`}
                      fulfillment={cfg.delivery_fulfillment_method}
                      paymentTiming={cfg.delivery_payment_timing}
                      onFulfillmentChange={(method) =>
                        updateCategorySettings(cat.id, {
                          delivery_fulfillment_method: method,
                          delivery_payment_timing: deliveryPaymentTimingForFulfillment(
                            method,
                            cfg.delivery_payment_timing,
                          ),
                        })
                      }
                      onPaymentTimingChange={(timing) =>
                        updateCategorySettings(cat.id, {
                          delivery_payment_timing: timing,
                        })
                      }
                    />
                  )}
                </div>
              );
            })}

          {!isMultiCategory && (
            <>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {s.reg_edit_reach_label}
                </label>
                <p className="mt-1 text-xs text-muted-foreground">{s.my_business_reach_hint}</p>
                <div className="mt-2 space-y-2">
                  {(
                    [
                      {
                        value: "customer" as const,
                        label: s.reg_reach_customer,
                        desc: s.reg_reach_customer_desc,
                      },
                      {
                        value: "vendor" as const,
                        label: s.reg_reach_vendor,
                        desc: s.reg_reach_vendor_desc,
                      },
                      {
                        value: "both" as const,
                        label: s.reg_reach_both,
                        desc: s.reg_reach_both_desc,
                      },
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
            </>
          )}

          {!isMultiCategory && selectedCategoryIds[0] && (
            <CategoryAvailabilityModeSelector
              variant="pills"
              label={s.my_business_category_availability}
              required
              testIdPrefix="my-business-avail"
              catalogServiceMode={resolveCatalogServiceMode(
                selectedCategories.find((c) => c.id === selectedCategoryIds[0])?.service_mode,
              )}
              value={
                categorySettingsById[selectedCategoryIds[0]]?.availability_modes ?? []
              }
              onChange={(modes) =>
                updateCategorySettings(selectedCategoryIds[0], {
                  availability_modes: modes,
                })
              }
            />
          )}

          {!isMultiCategory &&
            selectedCategoryIds[0] &&
            categoryHasDeliveryMode(
              categorySettingsById[selectedCategoryIds[0]]?.availability_modes ?? [],
            ) && (
              <DeliveryFulfillmentSettings
                testIdPrefix="my-business-delivery"
                fulfillment={
                  categorySettingsById[selectedCategoryIds[0]]?.delivery_fulfillment_method ??
                  DEFAULT_DELIVERY_FULFILLMENT
                }
                paymentTiming={
                  categorySettingsById[selectedCategoryIds[0]]?.delivery_payment_timing ??
                  DEFAULT_DELIVERY_PAYMENT_TIMING
                }
                onFulfillmentChange={(method) =>
                  updateCategorySettings(selectedCategoryIds[0], {
                    delivery_fulfillment_method: method,
                    delivery_payment_timing: deliveryPaymentTimingForFulfillment(
                      method,
                      categorySettingsById[selectedCategoryIds[0]]?.delivery_payment_timing ??
                        DEFAULT_DELIVERY_PAYMENT_TIMING,
                    ),
                  })
                }
                onPaymentTimingChange={(timing) =>
                  updateCategorySettings(selectedCategoryIds[0], {
                    delivery_payment_timing: timing,
                  })
                }
              />
            )}

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
          label={s.business_photo_verify}
          hint={s.business_photo_verify_hint}
          verified={hasShopPhoto}
          verifiedLabel={s.my_business_verified}
          actionLabel={hasShopPhoto ? s.vendor_reshoot : s.my_business_verify_now}
          onAction={() => {
            if (!activePhotoCategoryId) {
              toast.error(s.vendor_categories_required);
              return;
            }
            setCameraOpen(true);
          }}
          actionDisabled={!hasLocation && baseType !== "none"}
        >
          {gpsMatchFailCount >= GPS_MATCH_FAILS_BEFORE_SOFT_REVIEW && lastFailedShopShot && (
              <button
                type="button"
                data-testid="my-business-gps-submit-for-review"
                onClick={() =>
                  void handleShopPhoto(lastFailedShopShot, { pendingLocationReview: true })
                }
                className="w-full rounded-xl border border-amber-500/50 bg-amber-500/10 py-2.5 text-xs font-semibold text-amber-800"
              >
                {s.vendor_gps_submit_for_review}
              </button>
            )}
          {selectedCategories.length > 1 && (
            <div className="flex flex-wrap gap-2 mb-2" data-testid="my-business-photo-category-picker">
              {selectedCategories.map((cat) => {
                const cfg = categorySettingsById[cat.id];
                const has = cfg?.shop_photo_url != null && String(cfg.shop_photo_url).trim() !== "";
                const selected = cat.id === activePhotoCategoryId;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    data-testid={`my-business-photo-cat-${cat.id}`}
                    onClick={() => setPhotoCategoryId(cat.id)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-semibold",
                      selected
                        ? "border-primary bg-primary/20"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {cat.emoji} {getLabel(cat.label)}
                    {has ? " ✓" : ""}
                  </button>
                );
              })}
            </div>
          )}
          {activePhotoCategoryId && (
            <div className="mb-2" data-testid={`my-business-trust-${activePhotoCategoryId}`}>
              <BusinessVerificationBadge
                account={vendor}
                business={{
                  is_manual_verified: activePhotoSettings?.is_manual_verified ?? false,
                  shop_photo_url: activePhotoSettings?.shop_photo_url ?? null,
                  verification_status: activePhotoSettings?.verification_status ?? null,
                }}
                showLabel
              />
            </div>
          )}
          {hasShopPhoto && activePhotoSettings?.shop_photo_url && (
            <img
              src={activePhotoSettings.shop_photo_url}
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
          actionDisabled={!hasLocation && baseType !== "none"}
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

        <div className="px-4 pb-2 space-y-3">
          <button
            type="button"
            data-testid="my-business-add-business"
            onClick={() => setAddBusinessOpen(true)}
            disabled={selectedCategoryIds.length >= MAX_REG_CATEGORIES}
            className="w-full rounded-2xl border border-dashed border-primary/50 bg-primary/5 py-3.5 text-sm font-semibold text-primary disabled:opacity-50"
          >
            {s.my_business_add_business}
          </button>
          <p className="text-xs text-muted-foreground text-center">
            {s.my_business_add_business_hint}
          </p>
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

      <VendorMyBusinessOperations
        vendor={vendor}
        userPhone={userPhone}
        approvedCategories={selectedCategories.map((cat) => ({
          id: cat.id,
          label: cat.label,
          emoji: cat.emoji,
          service_mode: cat.service_mode,
        }))}
        activeCategoryId={activePhotoCategoryId}
        onActiveCategoryIdChange={setPhotoCategoryId}
        categorySettingsById={categorySettingsById}
        onCategoryNoteSaved={(categoryId, note) =>
          updateCategorySettings(categoryId, { vendor_note: note })
        }
      />

      <BusinessSetupSheet
        open={addBusinessOpen}
        onOpenChange={setAddBusinessOpen}
        vendor={vendor}
        existingCategoryIds={selectedCategoryIds}
        existingSettings={categorySettingsById}
        onAdded={() => setCategoriesReloadKey((k) => k + 1)}
      />

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
