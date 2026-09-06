import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ServiceRadiusChips } from "@/components/ServiceRadiusChips";
import { LiveCamera, type CapturedShot } from "@/components/LiveCamera";
import { BusinessVerificationBadge } from "@/components/VerificationBadge";
import { SettingsCard } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
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
} from "@/lib/supabase";
import { decodeUpiPayeeIdFromImageFile } from "@/lib/upiQrDecode";
import {
  GPS_MATCH_FAILS_BEFORE_SOFT_REVIEW,
  evaluateGpsMatch,
  logGpsMatchFailure,
  readGeolocationAccuracy,
} from "@/lib/gpsMatch";
import { patchVendorOwn } from "@/lib/vendorPatch";
import {
  checkAndNotifyAdminCategoryGreenReady,
} from "@/lib/vendorGreenReady";
import { useLanguage } from "@/lib/language";
import { captureError } from "@/lib/sentry";
import { cn } from "@/lib/utils";
import {
  type AvailabilityMode,
  type BaseTypeValue,
  type ReachChoiceValue,
  looksLikeGibberish,
  reachChoiceFromFlags,
  reachFlagsFromChoice,
  vendorTypeToBaseType,
  VENDOR_BUSINESS_SOFT_CAP,
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
import { triggerCategoryModeConfidenceCheck } from "@/lib/categoryModeConfidence";
import { parseInspectionFeeInput } from "@/lib/visitFee";
import { parseMinDeliveryOrderInput } from "@/lib/deliveryMinOrder";
import { getUserPhone } from "@/lib/userIdentity";
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
  brand_name?: string | null;
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
  is_paused: boolean;
  inspection_fee: string;
  min_delivery_order_amount: string;
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
  upi_id: string;
  upi_qr_url: string | null;
  upi_qr_payee_id: string | null;
  base_type: BaseTypeValue;
  review_status: "approved" | "pending_review" | "rejected";
  review_reason: string | null;
};

function rowBaseType(value: unknown): BaseTypeValue {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "visiting") return "none";
  if (v === "shop" || v === "home" || v === "none") return v;
  return "";
}

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
    is_paused: false,
    inspection_fee: "",
    min_delivery_order_amount: "",
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
    upi_id: "",
    upi_qr_url: null,
    upi_qr_payee_id: null,
    base_type: "",
    review_status: "approved",
    review_reason: null,
  };
}

function settingsFromCategoryRow(
  row: {
    serves_at_vendor_place?: boolean | null;
    serves_at_customer_place?: boolean | null;
    service_radius_km?: number | null;
    vendor_note?: string | null;
    is_paused?: boolean | null;
    inspection_fee?: number | string | null;
    min_delivery_order_amount?: number | string | null;
    shop_photo_url?: string | null;
    gps_match_distance?: number | null;
    verification_status?: string | null;
    is_manual_verified?: boolean | null;
    latitude?: number | null;
    longitude?: number | null;
    location_accuracy?: number | null;
    delivery_fulfillment_method?: string | null;
    delivery_payment_timing?: string | null;
    upi_id?: string | null;
    upi_qr_url?: string | null;
    upi_qr_payee_id?: string | null;
    base_type?: string | null;
    status?: string | null;
    review_reason?: string | null;
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
    is_paused: row.is_paused === true,
    inspection_fee:
      row.inspection_fee != null && Number(row.inspection_fee) > 0
        ? String(Math.round(Number(row.inspection_fee)))
        : "",
    min_delivery_order_amount:
      row.min_delivery_order_amount != null && Number(row.min_delivery_order_amount) > 0
        ? String(Math.round(Number(row.min_delivery_order_amount)))
        : "",
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
    upi_id: String(row.upi_id ?? "").trim(),
    upi_qr_url: String(row.upi_qr_url ?? "").trim() || null,
    upi_qr_payee_id: String(row.upi_qr_payee_id ?? "").trim() || null,
    base_type: rowBaseType(row.base_type),
    review_status:
      row.status === "pending_review" || row.status === "rejected"
        ? row.status
        : "approved",
    review_reason: String(row.review_reason ?? "").trim() || null,
  };
}

function categoryHasDeliveryMode(modes: AvailabilityMode[]): boolean {
  return modes.includes("delivery");
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
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        data-testid={testId}
        className={cn(
          "mt-1 bg-card",
          error ? "border-destructive focus-visible:ring-destructive" : "border-border",
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
    <div className="px-4 py-3 border-t border-surface-border space-y-2">
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
  const [reachChoice, setReachChoice] = useState<ReachChoiceValue>("");
  const [serviceRadiusKm, setServiceRadiusKm] = useState<number | null>(null);
  const [phone, setPhone] = useState(vendor.phone ?? "");
  const [availableCategories, setAvailableCategories] = useState<RegCategoryRow[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<RegCategoryRow[]>([]);
  const [categorySettingsById, setCategorySettingsById] = useState<
    Record<string, CategoryEditSettings>
  >({});
  const [pricedMenuCategoryIds, setPricedMenuCategoryIds] = useState<Set<string>>(new Set());
  const [shopPhotoCategoryId, setShopPhotoCategoryId] = useState<string | null>(null);
  const [expandedCategoryIds, setExpandedCategoryIds] = useState<Set<string>>(new Set());
  const [identityExpanded, setIdentityExpanded] = useState(false);
  const [addBusinessOpen, setAddBusinessOpen] = useState(false);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [categoriesLoadFailed, setCategoriesLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingLockRef = useRef(false);
  const [updatingLocationFor, setUpdatingLocationFor] = useState<string | null>(null);
  const [upiQrUploadingFor, setUpiQrUploadingFor] = useState<string | null>(null);
  const upiQrInputRef = useRef<HTMLInputElement>(null);
  const [upiQrTargetId, setUpiQrTargetId] = useState<string | null>(null);
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
    setReachChoice(
      reachChoiceFromFlags(v.serves_at_vendor_place, v.serves_at_customer_place) ||
        (v.vendor_type === "visiting" ? "customer" : "vendor"),
    );
    setServiceRadiusKm(v.service_radius_km ?? null);
    setPhone(v.phone ?? "");
  }, []);

  useEffect(() => {
    hydrateFromVendor(vendor);
  }, [vendor.id, hydrateFromVendor, vendor]);

  useEffect(() => {
    const loadSeq = ++loadSeqRef.current;
    setCategoriesLoading(true);
    setCategoriesLoadFailed(false);
    void (async () => {
      const [availResult, vcResult, menuResult] = await Promise.all([
        supabase
          .from("categories")
          .select("id, label, emoji, service_mode")
          .eq("is_active", true)
          .order("sort_order", { ascending: true }),
        supabase
          .from("vendor_categories")
          .select(
            "id, category_id, is_primary, brand_name, serves_at_vendor_place, serves_at_customer_place, service_radius_km, vendor_note, is_paused, inspection_fee, min_delivery_order_amount, shop_photo_url, gps_match_distance, verification_status, is_manual_verified, latitude, longitude, location_accuracy, delivery_fulfillment_method, delivery_payment_timing, upi_id, upi_qr_url, upi_qr_payee_id, base_type, status, review_reason, categories(id, label, emoji, service_mode)",
          )
          .eq("vendor_id", vendor.id)
          .in("status", ["approved", "pending_review", "rejected"])
          .order("is_primary", { ascending: false }),
        supabase
          .from("vendor_menu_items")
          .select("category_id, price")
          .eq("vendor_id", vendor.id),
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
      if (menuResult.error) {
        captureError(menuResult.error, {
          scope: "vendorMyBusiness.loadMenuItems",
          vendorId: vendor.id,
        });
      }

      if (availResult.error || vcResult.error) {
        setCategoriesLoadFailed(true);
        setCategoriesLoading(false);
        return;
      }

      const priced = new Set<string>();
      for (const row of menuResult.data ?? []) {
        const catId = (row as { category_id?: string | null }).category_id;
        const price = Number((row as { price?: number | null }).price);
        if (catId && Number.isFinite(price) && price > 0) priced.add(catId);
      }
      setPricedMenuCategoryIds(priced);

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
            brand_name: row.brand_name,
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
      setExpandedCategoryIds(new Set());
      setShopPhotoCategoryId((prev) =>
        prev && selectedIds.includes(prev) ? prev : selectedIds[0] ?? null,
      );

      setCategoriesLoadFailed(false);
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

  const toggleAccordion = (categoryId: string) => {
    setExpandedCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  };

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
        : prev.length >= 50
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

  const patchCategoryProfile = async (
    categoryId: string,
    patch: Record<string, unknown>,
  ) => {
    const vendorPhone = (userPhone ?? vendor.phone ?? getUserPhone() ?? "").trim();
    if (!vendorPhone) {
      throw new Error("identity_required");
    }
    const { error } = await withNetworkRetry(
      async () =>
        throwOnSupabaseNetworkError(
          await supabase.rpc("vendor_update_category_profile", {
            p_vendor_id: vendor.id,
            p_vendor_phone: vendorPhone,
            p_category_id: categoryId,
            p_patch: patch,
          }),
        ),
      {
        onRetrying: () => {
          showNetworkRetryingToast({ retrying: s.network_retrying });
        },
        shouldRetry: () => getNavigatorOnline(),
      },
    );
    dismissNetworkRetryingToast();
    if (error) throw error;
  };

  const savePause = async (categoryId: string, paused: boolean) => {
    const previous = categorySettingsById[categoryId]?.is_paused === true;
    updateCategorySettings(categoryId, { is_paused: paused });
    try {
      await patchCategoryProfile(categoryId, { is_paused: paused });
      toast.success(paused ? s.vendor_pause_saved : s.vendor_unpause_saved);
    } catch (err) {
      updateCategorySettings(categoryId, { is_paused: previous });
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void savePause(categoryId, paused), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
        return;
      }
      toast.error(s.vendor_pause_save_failed);
    }
  };

  const saveInspectionFee = async (categoryId: string) => {
    const raw = categorySettingsById[categoryId]?.inspection_fee ?? "";
    const parsed = parseInspectionFeeInput(raw);
    try {
      await patchCategoryProfile(categoryId, { inspection_fee: parsed });
      updateCategorySettings(categoryId, {
        inspection_fee: parsed != null ? String(parsed) : "",
      });
      toast.success(s.vendor_inspection_fee_saved);
    } catch (err) {
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void saveInspectionFee(categoryId), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
        return;
      }
      toast.error(s.vendor_inspection_fee_save_failed);
    }
  };

  const saveMinDeliveryOrder = async (categoryId: string) => {
    const raw = categorySettingsById[categoryId]?.min_delivery_order_amount ?? "";
    const parsed = parseMinDeliveryOrderInput(raw);
    try {
      await patchCategoryProfile(categoryId, { min_delivery_order_amount: parsed });
      updateCategorySettings(categoryId, {
        min_delivery_order_amount: parsed != null ? String(parsed) : "",
      });
      toast.success(s.vendor_min_delivery_saved);
    } catch (err) {
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void saveMinDeliveryOrder(categoryId), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
        return;
      }
      toast.error(s.vendor_min_delivery_save_failed);
    }
  };

  const shopNameInvalid =
    shopName.trim().length > 0 &&
    (shopName.trim().length <= 1 || looksLikeGibberish(shopName));
  const primaryShopBaseType =
    (selectedCategoryIds[0]
      ? categorySettingsById[selectedCategoryIds[0]]?.base_type
      : "") ?? "";
  const shopFieldOk =
    primaryShopBaseType === "shop"
      ? shopName.trim().length > 1 && !looksLikeGibberish(shopName)
      : primaryShopBaseType === "home"
        ? !shopNameInvalid
        : true;
  const ownerOk = ownerName.trim().length > 1 && !looksLikeGibberish(ownerName);

  const multiCategorySettingsOk = selectedCategoryIds.every((id) => {
    const cfg = categorySettingsById[id] ?? accountDefaultsForInherit();
    if (!cfg.reachChoice) return false;
    const needsCatRadius = cfg.reachChoice === "customer" || cfg.reachChoice === "both";
    if (needsCatRadius && cfg.service_radius_km == null) return false;
    const upi = (cfg.upi_id ?? "").trim();
    if (upi && !isValidUpi(upi)) return false;
    return true;
  });

  const modesByCategoryId = Object.fromEntries(
    selectedCategoryIds.map((id) => [id, categorySettingsById[id]?.availability_modes]),
  );
  const allCategoryModesOk = allCategoriesHaveModes(selectedCategoryIds, modesByCategoryId);

  const saveReady =
    ownerOk &&
    shopFieldOk &&
    selectedCategoryIds.length > 0 &&
    phone.trim().length > 0 &&
    multiCategorySettingsOk &&
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

    const primaryCatSettings =
      categorySettingsById[categoryIdsToSave[0]] ?? accountDefaultsForInherit();
    const effectiveReachChoice = primaryCatSettings.reachChoice;
    const effectiveRadiusKm = primaryCatSettings.service_radius_km;
    const reachFlags = effectiveReachChoice
      ? reachFlagsFromChoice(effectiveReachChoice)
      : null;
    if (!reachFlags || !primaryLabel || !primaryServiceMode) {
      releaseSaveLock();
      return;
    }

    // Empty base_type (pre-Phase-2 rows) must not coerce to "none" or we overwrite
    // an existing shop brand with the owner name and break Radar card matching.
    const nameBaseType: BaseTypeValue =
      primaryCatSettings.base_type === ""
        ? shopName.trim()
          ? "shop"
          : "none"
        : primaryCatSettings.base_type;
    const resolvedShopName = resolveRegistrationShopName(
      nameBaseType,
      ownerName,
      shopName,
    );
    const radiusKm =
      reachFlags.serves_at_customer_place && effectiveRadiusKm != null
        ? effectiveRadiusKm
        : vendor.service_radius_km;

    const brandNames = categoryIdsToSave.map(() => resolvedShopName.trim());
    const servesVendorPlace = categoryIdsToSave.map((id) => {
      const cfg = categorySettingsById[id] ?? accountDefaultsForInherit();
      return reachFlagsFromChoice(cfg.reachChoice)?.serves_at_vendor_place === true;
    });
    const servesCustomerPlace = categoryIdsToSave.map((id) => {
      const cfg = categorySettingsById[id] ?? accountDefaultsForInherit();
      return reachFlagsFromChoice(cfg.reachChoice)?.serves_at_customer_place === true;
    });
    const radii = categoryIdsToSave.map((id, i) => {
      if (!servesCustomerPlace[i]) return null;
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

    const upiIds = categoryIdsToSave.map(
      (id) => (categorySettingsById[id]?.upi_id ?? "").trim(),
    );
    const upiQrUrls = categoryIdsToSave.map(
      (id) => categorySettingsById[id]?.upi_qr_url ?? null,
    );
    const upiQrPayeeIds = categoryIdsToSave.map(
      (id) => categorySettingsById[id]?.upi_qr_payee_id ?? null,
    );
    const baseTypes = categoryIdsToSave.map(
      (id) => categorySettingsById[id]?.base_type || null,
    );
    const latitudes = categoryIdsToSave.map(
      (id) => categorySettingsById[id]?.latitude ?? null,
    );
    const longitudes = categoryIdsToSave.map(
      (id) => categorySettingsById[id]?.longitude ?? null,
    );

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
      serves_at_vendor_place: reachFlags.serves_at_vendor_place,
      serves_at_customer_place: reachFlags.serves_at_customer_place,
      service_radius_km: radiusKm,
      phone: phone.trim(),
      ...(phoneChanged ? { is_manual_verified: false } : {}),
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
              p_upi_ids: upiIds,
              p_upi_qr_urls: upiQrUrls,
              p_upi_qr_payee_ids: upiQrPayeeIds,
              p_base_types: baseTypes,
              p_latitudes: latitudes,
              p_longitudes: longitudes,
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
      serves_at_vendor_place: reachFlags.serves_at_vendor_place,
      serves_at_customer_place: reachFlags.serves_at_customer_place,
      service_radius_km: radiusKm,
      phone: phone.trim(),
      ...(phoneChanged
        ? {
            is_manual_verified: false,
            verification_status: "identity_linked" as VerificationStatus,
          }
        : {}),
    });

    savedCategoryIdsRef.current = [...categoryIdsToSave];

    toast.success(s.my_business_saved);
    triggerCategoryModeConfidenceCheck(categoryIdsToSave);
    releaseSaveLock();
  };

  const handleUpiQrFile = async (categoryId: string, file: File) => {
    setUpiQrUploadingFor(categoryId);
    const path = `upi-qr/${vendor.id}/${categoryId}/${Date.now()}_${file.name}`;
    try {
      const { error: upErr } = await supabase.storage.from("vendor-docs").upload(path, file, {
        contentType: file.type || "image/jpeg",
        upsert: true,
      });
      if (upErr) {
        toast.error(s.vendor_qr_upload_failed);
        return;
      }
      const { data: pub } = supabase.storage.from("vendor-docs").getPublicUrl(path);
      const payeeId = await decodeUpiPayeeIdFromImageFile(file);
      updateCategorySettings(categoryId, {
        upi_qr_url: pub.publicUrl,
        upi_qr_payee_id: payeeId,
        ...(payeeId ? { upi_id: payeeId } : {}),
      });
      if (!payeeId) toast.error(s.vendor_qr_decode_failed);
    } finally {
      setUpiQrUploadingFor(null);
    }
  };

  const handleShopPhoto = async (
    shot: CapturedShot,
    opts?: { pendingLocationReview?: boolean },
  ) => {
    setCameraOpen(false);
    const targetCategoryId = shopPhotoCategoryId ?? selectedCategoryIds[0] ?? null;
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

  const updateBusinessLocation = async (categoryId: string) => {
    const cfg = categorySettingsById[categoryId] ?? accountDefaultsForInherit();
    const hadPin = cfg.latitude != null && cfg.longitude != null;
    const verifiedBiz =
      cfg.is_manual_verified === true ||
      cfg.verification_status === "business_verified" ||
      cfg.verification_status === "green_pending" ||
      (cfg.shop_photo_url != null && String(cfg.shop_photo_url).trim() !== "");
    if (hadPin && verifiedBiz) {
      const ok = window.confirm(s.vendor_location_reset_confirm);
      if (!ok) return;
    }
    if (!("geolocation" in navigator)) {
      toast.error(s.vendor_geo_not_supported);
      return;
    }
    setUpdatingLocationFor(categoryId);
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
      setUpdatingLocationFor(null);
      return;
    }

    const ids = selectedCategoryIdsRef.current;
    const nextSettings = {
      ...(categorySettingsById[categoryId] ?? accountDefaultsForInherit()),
      latitude: coords.lat,
      longitude: coords.lng,
      location_accuracy: coords.accuracy,
    };
    const categoryServiceModes = ids.map((id) => {
      const cat =
        availableCategories.find((c) => c.id === id) ??
        selectedCategories.find((c) => c.id === id);
      const modes = categorySettingsById[id]?.availability_modes ?? [];
      return pickPrimaryAvailabilityMode(modes, cat?.service_mode);
    });
    const categoryModesPayload = buildCategoryModesPayload(
      ids,
      Object.fromEntries(ids.map((id) => [id, categorySettingsById[id]?.availability_modes])),
    );
    const settingsFor = (id: string) =>
      id === categoryId ? nextSettings : (categorySettingsById[id] ?? accountDefaultsForInherit());

    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("vendor_update_categories", {
              p_vendor_id: vendor.id,
              p_vendor_phone: vendorPhone || phone.trim(),
              p_category_ids: ids,
              p_category_service_modes: categoryServiceModes,
              p_category_modes: categoryModesPayload,
              p_brand_names: ids.map(() => (vendor.shop_name ?? "").trim()),
              p_serves_at_vendor_place: ids.map(
                (id) =>
                  reachFlagsFromChoice(settingsFor(id).reachChoice)?.serves_at_vendor_place ===
                  true,
              ),
              p_serves_at_customer_place: ids.map(
                (id) =>
                  reachFlagsFromChoice(settingsFor(id).reachChoice)?.serves_at_customer_place ===
                  true,
              ),
              p_service_radius_km: ids.map((id) => settingsFor(id).service_radius_km),
              p_delivery_fulfillment_methods: ids.map(
                (id) => settingsFor(id).delivery_fulfillment_method,
              ),
              p_delivery_payment_timings: ids.map((id) =>
                deliveryPaymentTimingForFulfillment(
                  settingsFor(id).delivery_fulfillment_method,
                  settingsFor(id).delivery_payment_timing,
                ),
              ),
              p_upi_ids: ids.map((id) => (settingsFor(id).upi_id ?? "").trim()),
              p_upi_qr_urls: ids.map((id) => settingsFor(id).upi_qr_url ?? null),
              p_upi_qr_payee_ids: ids.map((id) => settingsFor(id).upi_qr_payee_id ?? null),
              p_base_types: ids.map((id) => settingsFor(id).base_type || null),
              p_latitudes: ids.map((id) => settingsFor(id).latitude ?? null),
              p_longitudes: ids.map((id) => settingsFor(id).longitude ?? null),
            }),
          ),
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
      const downgraded = hadPin && verifiedBiz;
      updateCategorySettings(categoryId, {
        latitude: coords.lat,
        longitude: coords.lng,
        location_accuracy: coords.accuracy,
        ...(downgraded
          ? {
              shop_photo_url: null,
              gps_match_distance: null,
              verification_status: "identity_linked",
              is_manual_verified: false,
            }
          : {}),
      });
      toast(downgraded ? s.vendor_reverification_required : s.vendor_location_updated, {
        description: downgraded ? s.vendor_reverification_body : s.vendor_location_updated_body,
      });
      triggerCategoryModeConfidenceCheck(ids);
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void updateBusinessLocation(categoryId), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      setUpdatingLocationFor(null);
    }
  };

  const hasSelfie = vendor.photo_selfie != null && String(vendor.photo_selfie).trim() !== "";
  const hasAccountLocation = vendor.latitude != null && vendor.longitude != null;
  const accountBaseType = vendor.base_type
    ? rowBaseType(vendor.base_type)
    : vendorTypeToBaseType(vendor.vendor_type);
  const identitySubtitle = ownerName.trim();

  return (
    <div data-testid="vendor-my-business" className="px-4 mb-6 space-y-4">
      {categoriesLoading ? (
        <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5 px-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {s.vendor_understanding}
        </p>
      ) : categoriesLoadFailed ? (
        <div
          className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 space-y-2"
          data-testid="my-business-categories-load-error"
        >
          <p className="text-sm text-destructive">{s.home_categories_load_error}</p>
          <button
            type="button"
            onClick={() => setCategoriesReloadKey((k) => k + 1)}
            className="min-h-[44px] rounded-lg border border-surface-border px-3 text-xs font-semibold text-foreground"
          >
            {s.network_retry_btn}
          </button>
        </div>
      ) : (
        <div className="space-y-3" data-testid="my-business-accordions">
          <SettingsCard
            className="mx-0 border-surface-border overflow-hidden"
            data-testid="my-business-identity-accordion"
          >
            <button
              type="button"
              data-testid="my-business-identity-accordion-toggle"
              aria-expanded={identityExpanded}
              onClick={() => setIdentityExpanded((prev) => !prev)}
              className={cn(
                "w-full flex items-center justify-between gap-3 px-4 py-3 text-left active:opacity-90",
                identityExpanded && "border-b border-surface-border",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground truncate">
                  {s.settings_myBusiness}
                </p>
                <p className="text-xs text-muted-foreground truncate mt-1">
                  {identitySubtitle || s.my_business_hint}
                </p>
              </div>
              <ChevronDown
                className={cn(
                  "h-5 w-5 text-muted-foreground transition-transform duration-200 shrink-0",
                  identityExpanded && "rotate-180",
                )}
              />
            </button>

            {identityExpanded && (
              <div
                className="pb-4 space-y-0"
                data-testid="my-business-identity-panel"
              >
                <div className="px-4 space-y-4 pt-3">
                  <Field
                    label={s.vendor_your_name}
                    value={ownerName}
                    onChange={setOwnerName}
                    placeholder={s.vendor_name_placeholder}
                    required
                    error={ownerName.length > 0 && !ownerOk ? s.vendor_name_invalid : undefined}
                  />

                  <Field
                    label={s.vendor_phone_label}
                    value={phone}
                    onChange={setPhone}
                    placeholder={s.vendor_phone_placeholder}
                    required
                    error={
                      phone.length > 0 && !isValidPhone(phone)
                        ? s.vendor_phone_invalid_body
                        : undefined
                    }
                  />
                </div>

                <VerifyRow
                  label={s.vendor_selfie_title}
                  hint={s.vendor_selfie_subtitle}
                  verified={hasSelfie}
                  verifiedLabel={s.my_business_verified}
                  actionLabel={hasSelfie ? s.vendor_selfie_reshoot : s.my_business_verify_now}
                  onAction={() => setSelfieCameraOpen(true)}
                  actionDisabled={!hasAccountLocation && accountBaseType !== "none"}
                >
                  {hasSelfie && (
                    <img
                      src={vendor.photo_selfie!}
                      alt={s.vendor_selfie_title}
                      className="w-full max-w-xs rounded-xl border border-border"
                    />
                  )}
                </VerifyRow>
              </div>
            )}
          </SettingsCard>

          {selectedCategories.length === 0 && (
            <p className="text-xs text-muted-foreground px-1">{s.vendor_categories_pick}</p>
          )}
          {selectedCategories.map((cat) => {
            const cfg = categorySettingsById[cat.id] ?? accountDefaultsForInherit();
            const catNeedsRadius = cfg.reachChoice === "customer" || cfg.reachChoice === "both";
            const catHasShopPhoto =
              cfg.shop_photo_url != null && String(cfg.shop_photo_url).trim() !== "";
            const catHasLocation = cfg.latitude != null && cfg.longitude != null;
            const catUpi = (cfg.upi_id ?? "").trim();
            const expanded = expandedCategoryIds.has(cat.id);
            const displayBrand =
              (cat.brand_name ?? "").trim() ||
              (selectedCategories.length === 1 ? shopName.trim() : "") ||
              vendor.shop_name ||
              getLabel(cat.label);
            return (
              <SettingsCard
                key={cat.id}
                className="mx-0 border-surface-border overflow-hidden"
                data-testid={`my-business-accordion-${cat.id}`}
              >
                <button
                  type="button"
                  data-testid={`my-business-accordion-toggle-${cat.id}`}
                  aria-expanded={expanded}
                  onClick={() => toggleAccordion(cat.id)}
                  className={cn(
                    "w-full flex items-center justify-between gap-3 px-4 py-3 text-left active:opacity-90",
                    expanded && "border-b border-surface-border",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground truncate">
                      {cat.emoji} {getLabel(cat.label)}
                    </p>
                    <p className="text-xs text-muted-foreground truncate mt-1">{displayBrand}</p>
                    {cfg.review_status === "pending_review" && (
                      <p
                        className="text-xs text-amber-600 font-medium mt-1"
                        data-testid={`my-business-pending-review-${cat.id}`}
                      >
                        {s.my_business_pending_review}
                      </p>
                    )}
                    {cfg.review_status === "rejected" && (
                      <p
                        className="text-xs text-destructive font-medium mt-1"
                        data-testid={`my-business-rejected-${cat.id}`}
                      >
                        {s.my_business_rejected}
                        {cfg.review_reason
                          ? ` — ${s.my_business_rejected_reason}: ${cfg.review_reason}`
                          : ""}
                      </p>
                    )}
                    {cfg.is_paused && cfg.review_status === "approved" && (
                      <p className="text-xs text-amber-600 font-medium mt-1">
                        {s.vendor_pause_business}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <BusinessVerificationBadge
                      account={vendor}
                      business={{
                        is_manual_verified: cfg.is_manual_verified,
                        shop_photo_url: cfg.shop_photo_url,
                        verification_status: cfg.verification_status,
                      }}
                      showLabel
                    />
                    <ChevronDown
                      className={cn(
                        "h-5 w-5 text-muted-foreground transition-transform duration-200",
                        expanded && "rotate-180",
                      )}
                    />
                  </div>
                </button>

                {expanded && (
                  <div
                    className="px-4 pb-4 pt-3 space-y-4"
                    data-testid={`my-business-category-settings-${cat.id}`}
                  >
                    <div
                      className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-3"
                      data-testid={`my-business-pause-row-${cat.id}`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">
                          {s.vendor_pause_business}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1 leading-snug">
                          {s.vendor_pause_business_hint}
                        </p>
                      </div>
                      <Switch
                        className="data-[state=checked]:bg-amber-500"
                        checked={cfg.is_paused}
                        disabled={cfg.review_status !== "approved"}
                        onCheckedChange={(checked) => void savePause(cat.id, checked)}
                        data-testid={`my-business-pause-${cat.id}`}
                      />
                    </div>

                    <div>
                      <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {s.vendor_inspection_fee_label}
                      </label>
                      <p className="text-xs text-muted-foreground mt-1 mb-1.5">
                        {s.vendor_inspection_fee_hint}
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          inputMode="numeric"
                          data-testid={`my-business-inspection-fee-${cat.id}`}
                          value={cfg.inspection_fee}
                          onChange={(e) =>
                            updateCategorySettings(cat.id, {
                              inspection_fee: e.target.value.replace(/[^\d]/g, "").slice(0, 5),
                            })
                          }
                          placeholder={s.vendor_inspection_fee_placeholder}
                          className="flex-1 bg-card border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                        <button
                          type="button"
                          data-testid={`my-business-inspection-fee-save-${cat.id}`}
                          onClick={() => void saveInspectionFee(cat.id)}
                          className="text-xs font-semibold text-brand hover:underline shrink-0"
                        >
                          {s.vendor_save_note}
                        </button>
                      </div>
                    </div>

                    {categoryHasDeliveryMode(cfg.availability_modes) && (
                    <div>
                      <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {s.vendor_min_delivery_label}
                      </label>
                      <p className="text-xs text-muted-foreground mt-1 mb-1.5">
                        {s.vendor_min_delivery_hint}
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          inputMode="numeric"
                          data-testid={`my-business-min-delivery-${cat.id}`}
                          value={cfg.min_delivery_order_amount ?? ""}
                          onChange={(e) =>
                            updateCategorySettings(cat.id, {
                              min_delivery_order_amount: e.target.value.replace(/[^\d]/g, "").slice(0, 5),
                            })
                          }
                          placeholder={s.vendor_min_delivery_placeholder}
                          className="flex-1 bg-card border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                        <button
                          type="button"
                          data-testid={`my-business-min-delivery-save-${cat.id}`}
                          onClick={() => void saveMinDeliveryOrder(cat.id)}
                          className="text-xs font-semibold text-brand hover:underline shrink-0"
                        >
                          {s.vendor_save_note}
                        </button>
                      </div>
                      {parseMinDeliveryOrderInput(cfg.min_delivery_order_amount) != null &&
                        !pricedMenuCategoryIds.has(cat.id) && (
                          <p
                            data-testid={`my-business-min-delivery-no-menu-warning-${cat.id}`}
                            className="mt-1.5 text-xs text-amber-600 leading-snug"
                          >
                            {s.vendor_min_delivery_no_menu_warning}
                          </p>
                        )}
                    </div>
                    )}

                    <div>
                      <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {s.reg_where_work_from}
                      </label>
                      <div className="mt-2 grid grid-cols-1 gap-2">
                        {(
                          [
                            {
                              value: "shop" as const,
                              emoji: "🏪",
                              title: s.reg_base_shop,
                              desc: s.reg_base_shop_desc,
                            },
                            {
                              value: "home" as const,
                              emoji: "🏠",
                              title: s.reg_base_home,
                              desc: s.reg_base_home_desc,
                            },
                            {
                              value: "none" as const,
                              emoji: "🚫",
                              title: s.reg_base_none,
                              desc: s.reg_base_none_desc,
                            },
                          ] as const
                        ).map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            data-testid={
                              !isMultiCategory
                                ? `my-business-base-${opt.value}`
                                : `my-business-cat-base-${cat.id}-${opt.value}`
                            }
                            onClick={() =>
                              updateCategorySettings(cat.id, { base_type: opt.value })
                            }
                            className={cn(
                              "rounded-2xl border-2 p-3 text-left transition-colors active:scale-[0.98]",
                              "bg-surface border-surface-border",
                              cfg.base_type === opt.value &&
                                "border-primary bg-primary/15 ring-1 ring-primary/30",
                            )}
                          >
                            <p className="text-base font-display font-bold text-foreground leading-tight">
                              {opt.emoji} {opt.title}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground leading-snug">
                              {opt.desc}
                            </p>
                          </button>
                        ))}
                      </div>
                    </div>

                    {!isMultiCategory && (
                      <Field
                        label={s.vendor_shop_name}
                        value={shopName}
                        onChange={setShopName}
                        placeholder={s.vendor_shop_placeholder}
                        required={cfg.base_type === "shop"}
                        error={
                          cfg.base_type === "shop"
                            ? shopName.length > 0 && !shopFieldOk
                              ? s.vendor_specify_hint
                              : undefined
                            : shopNameInvalid
                              ? s.vendor_specify_hint
                              : undefined
                        }
                        testId="my-business-shop-name"
                      />
                    )}

                    <Field
                      label={s.vendor_upi_label}
                      value={catUpi}
                      onChange={(value) => updateCategorySettings(cat.id, { upi_id: value })}
                      placeholder={s.vendor_upi_placeholder}
                      error={
                        catUpi.length > 0 && !isValidUpi(catUpi)
                          ? s.vendor_upi_format_body
                          : undefined
                      }
                      testId={
                        isMultiCategory
                          ? `my-business-cat-upi-${cat.id}`
                          : "my-business-upi"
                      }
                    />
                    <div>
                      <label className="text-xs text-muted-foreground">{s.vendor_upi_qr_label}</label>
                      <button
                        type="button"
                        data-testid={
                          isMultiCategory
                            ? `my-business-cat-upi-qr-${cat.id}`
                            : "my-business-upi-qr"
                        }
                        disabled={upiQrUploadingFor === cat.id}
                        onClick={() => {
                          setUpiQrTargetId(cat.id);
                          upiQrInputRef.current?.click();
                        }}
                        className="mt-1 w-full rounded-xl border border-border h-10 text-sm"
                      >
                        {upiQrUploadingFor === cat.id ? s.vendor_uploading : s.vendor_upi_qr_hint}
                      </button>
                      {cfg.upi_qr_url ? (
                        <p className="mt-1 text-xs text-muted-foreground truncate">
                          {cfg.upi_qr_url}
                        </p>
                      ) : null}
                    </div>

                    <div data-testid={isMultiCategory ? `my-business-cat-location-${cat.id}` : "my-business-location"}>
                      <VerifyRow
                        label={s.my_business_location_label}
                        hint={
                          catHasLocation
                            ? `📍 ${Number(cfg.latitude).toFixed(4)}, ${Number(cfg.longitude).toFixed(4)}`
                            : s.vendor_location_missing_body
                        }
                        // Keep Confirm location clickable after the first pin so vendors can re-set
                        // this business's GPS (VerifyRow hides the action when verified=true).
                        verified={false}
                        verifiedLabel={s.my_business_verified}
                        actionLabel={s.my_business_confirm_location}
                        onAction={() => void updateBusinessLocation(cat.id)}
                        actionLoading={updatingLocationFor === cat.id}
                      />
                    </div>

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
                            data-testid={
                              !isMultiCategory
                                ? `my-business-reach-${opt.value}`
                                : `my-business-cat-reach-${cat.id}-${opt.value}`
                            }
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
                            <p className="mt-1 text-xs text-muted-foreground">{opt.desc}</p>
                          </button>
                        ))}
                      </div>
                    </div>

                    {catNeedsRadius && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {isMultiCategory ? s.my_business_category_radius : s.vendor_radius_label}
                        </p>
                        {!isMultiCategory && (
                          <p className="mt-1 text-xs text-muted-foreground">{s.vendor_radius_hint}</p>
                        )}
                        <div
                          className="mt-3"
                          data-testid={
                            !isMultiCategory
                              ? "my-business-radius"
                              : `my-business-cat-radius-${cat.id}`
                          }
                        >
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
                      testIdPrefix={
                        isMultiCategory ? `my-business-cat-avail-${cat.id}` : "my-business-avail"
                      }
                      catalogServiceMode={resolveCatalogServiceMode(cat.service_mode)}
                      value={cfg.availability_modes}
                      onChange={(modes) =>
                        updateCategorySettings(cat.id, { availability_modes: modes })
                      }
                    />

                    {categoryHasDeliveryMode(cfg.availability_modes) && (
                      <DeliveryFulfillmentSettings
                        testIdPrefix={
                          isMultiCategory
                            ? `my-business-cat-delivery-${cat.id}`
                            : "my-business-delivery"
                        }
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

                    <VerifyRow
                      label={s.business_photo_verify}
                      hint={s.business_photo_verify_hint}
                      verified={catHasShopPhoto}
                      verifiedLabel={s.my_business_verified}
                      actionLabel={catHasShopPhoto ? s.vendor_reshoot : s.my_business_verify_now}
                      onAction={() => {
                        setShopPhotoCategoryId(cat.id);
                        setCameraOpen(true);
                      }}
                      actionDisabled={!catHasLocation && cfg.base_type !== "none"}
                    >
                      {gpsMatchFailCount >= GPS_MATCH_FAILS_BEFORE_SOFT_REVIEW &&
                        lastFailedShopShot &&
                        shopPhotoCategoryId === cat.id && (
                          <button
                            type="button"
                            data-testid="my-business-gps-submit-for-review"
                            onClick={() =>
                              void handleShopPhoto(lastFailedShopShot, {
                                pendingLocationReview: true,
                              })
                            }
                            className="w-full rounded-xl border border-amber-500/50 bg-amber-500/10 h-10 text-xs font-semibold text-amber-800"
                          >
                            {s.vendor_gps_submit_for_review}
                          </button>
                        )}
                      <div className="mb-2" data-testid={`my-business-trust-${cat.id}`}>
                        <BusinessVerificationBadge
                          account={vendor}
                          business={{
                            is_manual_verified: cfg.is_manual_verified,
                            shop_photo_url: cfg.shop_photo_url,
                            verification_status: cfg.verification_status,
                          }}
                          showLabel
                        />
                      </div>
                      {catHasShopPhoto && cfg.shop_photo_url && (
                        <img
                          src={cfg.shop_photo_url}
                          alt={s.vendor_captured_shop}
                          className="w-full rounded-xl border border-border"
                        />
                      )}
                    </VerifyRow>

                    <VendorMyBusinessOperations
                      vendor={vendor}
                      userPhone={userPhone}
                      approvedCategories={[
                        {
                          id: cat.id,
                          label: cat.label,
                          emoji: cat.emoji,
                          service_mode: cat.service_mode,
                        },
                      ]}
                      activeCategoryId={cat.id}
                      onActiveCategoryIdChange={() => {}}
                      categorySettingsById={categorySettingsById}
                      onCategoryNoteSaved={(categoryId, note) =>
                        updateCategorySettings(categoryId, { vendor_note: note })
                      }
                    />

                    {isMultiCategory && cfg.review_status === "approved" && (
                      <button
                        type="button"
                        data-testid={`my-business-remove-cat-${cat.id}`}
                        onClick={() => toggleCategory(cat.id)}
                        className="w-full rounded-xl border border-destructive/40 text-destructive min-h-[44px] text-xs font-semibold"
                      >
                        Remove {getLabel(cat.label)}
                      </button>
                    )}
                  </div>
                )}
              </SettingsCard>
            );
          })}
        </div>
      )}

      <div className="space-y-3">
        <button
          type="button"
          data-testid="my-business-add-business"
          onClick={() => setAddBusinessOpen(true)}
          className="w-full rounded-2xl border border-dashed border-primary/50 bg-primary/5 h-12 text-sm font-semibold text-primary disabled:opacity-50"
        >
          {s.my_business_add_business}
        </button>
        <p className="text-xs text-muted-foreground text-center">
          {selectedCategoryIds.filter(
            (id) => (categorySettingsById[id]?.review_status ?? "approved") === "approved",
          ).length >= VENDOR_BUSINESS_SOFT_CAP
            ? s.my_business_add_business_review_hint
            : s.my_business_add_business_hint}
        </p>
        <button
          type="button"
          data-testid="my-business-save"
          onClick={() => void saveProfile()}
          disabled={!saveReady || saving}
          className="w-full rounded-2xl bg-primary text-primary-foreground h-12 text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {s.menu_save}
        </button>
      </div>

      <BusinessSetupSheet
        open={addBusinessOpen}
        onOpenChange={setAddBusinessOpen}
        vendor={vendor}
        existingCategoryIds={selectedCategoryIds}
        existingSettings={categorySettingsById}
        approvedCount={
          selectedCategoryIds.filter(
            (id) => (categorySettingsById[id]?.review_status ?? "approved") === "approved",
          ).length
        }
        onAdded={() => setCategoriesReloadKey((k) => k + 1)}
      />

      <input
        ref={upiQrInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          const target = upiQrTargetId;
          e.target.value = "";
          if (f && target) void handleUpiQrFile(target, f);
        }}
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
