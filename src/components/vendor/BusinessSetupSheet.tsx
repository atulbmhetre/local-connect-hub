import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ServiceRadiusChips } from "@/components/ServiceRadiusChips";
import { LiveCamera, type CapturedShot } from "@/components/LiveCamera";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  supabase,
  type Vendor,
  type Category,
  SHOP_PHOTOS_BUCKET,
  useCategoryLabel,
  isValidUpi,
} from "@/lib/supabase";
import { decodeUpiPayeeIdFromImageFile } from "@/lib/upiQrDecode";
import {
  GPS_MATCH_FAILS_BEFORE_SOFT_REVIEW,
  evaluateGpsMatch,
  logGpsMatchFailure,
  type GpsPoint,
} from "@/lib/gpsMatch";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import { checkAndNotifyAdminCategoryGreenReady } from "@/lib/vendorGreenReady";
import { triggerProactiveCategoryAliases } from "@/lib/proactiveCategoryAliases";
import { triggerCategoryModeConfidenceCheck } from "@/lib/categoryModeConfidence";
import {
  type AvailabilityMode,
  type BaseTypeValue,
  type ReachChoiceValue,
  reachFlagsFromChoice,
  VENDOR_BUSINESS_SOFT_CAP,
} from "@/lib/vendorRegistration";
import { CategoryAvailabilityModeSelector } from "@/components/vendor/CategoryAvailabilityModeSelector";
import {
  buildCategoryModesPayload,
  pickPrimaryAvailabilityMode,
  normalizeAvailabilityModes,
  initialModesForCatalog,
  resolveCatalogServiceMode,
} from "@/lib/categoryAvailabilityModes";
import {
  licenseFieldHasValue,
  wizardLicenseFields,
  type LicenseType,
} from "@/lib/vendorLicenses";

export type BusinessSetupExistingSettings = {
  reachChoice: ReachChoiceValue;
  service_radius_km: number | null;
  availability_modes: AvailabilityMode[];
};

type RegCategoryRow = Pick<Category, "id" | "label" | "emoji"> & {
  service_mode: string;
  license_type?: string | null;
  license_review_status?: string | null;
};

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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendor: Vendor;
  existingCategoryIds: string[];
  existingSettings: Record<string, BusinessSetupExistingSettings>;
  approvedCount?: number;
  onAdded: () => void;
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

function ChoiceCard({
  selected,
  onClick,
  emoji,
  title,
  desc,
  testId,
}: {
  selected: boolean;
  onClick: () => void;
  emoji: string;
  title: string;
  desc: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
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

type ColocatedMatch = {
  category_id: string;
  distance_meters: number;
  shop_photo_url: string | null;
  latitude: number;
  longitude: number;
  category_label: string | null;
  brand_name: string | null;
};

export function BusinessSetupSheet({
  open,
  onOpenChange,
  vendor,
  existingCategoryIds,
  existingSettings,
  approvedCount,
  onAdded,
}: Props) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const vendorPhone = (vendor.phone ?? "").trim();

  const [categories, setCategories] = useState<RegCategoryRow[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [setupPage, setSetupPage] = useState<1 | 2>(1);
  const [licenseDrafts, setLicenseDrafts] = useState<
    Record<string, { number: string; file: File | null; preview: string | null }>
  >({});
  const licensePhotoInputRef = useRef<HTMLInputElement>(null);
  const licensePhotoTargetRef = useRef<string | null>(null);
  const [baseType, setBaseType] = useState<BaseTypeValue>("");
  const [upi, setUpi] = useState("");
  const [upiBlurred, setUpiBlurred] = useState(false);
  const [upiQrUrl, setUpiQrUrl] = useState("");
  const [upiQrPayeeId, setUpiQrPayeeId] = useState<string | null>(null);
  const [upiQrUploading, setUpiQrUploading] = useState(false);
  const upiQrInputRef = useRef<HTMLInputElement>(null);
  const [reachChoice, setReachChoice] = useState<ReachChoiceValue>("");
  const [serviceRadiusKm, setServiceRadiusKm] = useState<number | null>(null);
  const [availabilityModes, setAvailabilityModes] = useState<AvailabilityMode[]>([]);
  const [vendorNote, setVendorNote] = useState("");
  const [cancelReasons, setCancelReasons] = useState(["", "", "", ""]);
  const [shopPhotoBlob, setShopPhotoBlob] = useState<Blob | null>(null);
  const [shopPhotoDataUrl, setShopPhotoDataUrl] = useState<string | null>(null);
  const [shopPhotoGpsDistance, setShopPhotoGpsDistance] = useState(0);
  const [shopPhotoCoords, setShopPhotoCoords] = useState<GpsPoint | null>(null);
  const [shopPhotoLocationAccuracy, setShopPhotoLocationAccuracy] = useState<number | null>(
    null,
  );
  const [shopPhotoAccuracy, setShopPhotoAccuracy] = useState<number | null>(null);
  const [shopPhotoPendingLocationReview, setShopPhotoPendingLocationReview] = useState(false);
  const [gpsMatchFailCount, setGpsMatchFailCount] = useState(0);
  const [lastFailedShopShot, setLastFailedShopShot] = useState<CapturedShot | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [colocated, setColocated] = useState<ColocatedMatch | null>(null);
  const [colocatedChecking, setColocatedChecking] = useState(false);
  const [inheritFromCategoryId, setInheritFromCategoryId] = useState<string | null>(null);
  const [gatePin, setGatePin] = useState<GpsPoint | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedCategoryId(null);
    setSetupPage(1);
    setLicenseDrafts({});
    setBaseType("");
    setUpi("");
    setUpiBlurred(false);
    setUpiQrUrl("");
    setUpiQrPayeeId(null);
    setUpiQrUploading(false);
    setReachChoice("");
    setServiceRadiusKm(null);
    setAvailabilityModes([]);
    setVendorNote("");
    setCancelReasons(["", "", "", ""]);
    setShopPhotoBlob(null);
    setShopPhotoDataUrl(null);
    setShopPhotoGpsDistance(0);
    setShopPhotoCoords(null);
    setShopPhotoLocationAccuracy(null);
    setShopPhotoAccuracy(null);
    setShopPhotoPendingLocationReview(false);
    setGpsMatchFailCount(0);
    setLastFailedShopShot(null);
    setColocated(null);
    setColocatedChecking(false);
    setInheritFromCategoryId(null);
    setGatePin(null);
    setCategoriesLoading(true);
    void supabase
      .from("categories")
      .select("id, label, emoji, service_mode, license_type, license_review_status")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .then(({ data, error }) => {
        setCategoriesLoading(false);
        if (error) {
          console.error("load categories for business setup", error);
          setCategories([]);
          return;
        }
        setCategories((data ?? []) as RegCategoryRow[]);
      });
  }, [open]);

  const available = categories.filter((c) => !existingCategoryIds.includes(c.id));
  const selectedCategory = categories.find((c) => c.id === selectedCategoryId) ?? null;
  const licenseFields = useMemo(
    () => (selectedCategory ? wizardLicenseFields([selectedCategory]) : []),
    [selectedCategory],
  );
  const needsLicenseStep = licenseFields.length > 0;
  const liveCount = approvedCount ?? existingCategoryIds.length;
  const needsAdminReview = liveCount >= VENDOR_BUSINESS_SOFT_CAP;
  const reachFlags = reachChoice ? reachFlagsFromChoice(reachChoice) : null;
  const needsRadius = reachFlags?.serves_at_customer_place === true;
  const radiusOk = !needsRadius || serviceRadiusKm != null;
  const photoReady = shopPhotoBlob != null || inheritFromCategoryId != null;
  const upiFmtOk = isValidUpi(upi);
  const ready =
    selectedCategoryId != null &&
    baseType !== "" &&
    upiFmtOk &&
    reachChoice !== "" &&
    radiusOk &&
    availabilityModes.length > 0 &&
    photoReady &&
    available.length > 0;
  const upiFormatError =
    upiBlurred && upi.trim().length > 0 && !upiFmtOk ? s.vendor_upi_id_format_invalid : undefined;

  useEffect(() => {
    if (!needsLicenseStep && setupPage === 2) setSetupPage(1);
  }, [needsLicenseStep, setupPage]);

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

  const handleLicensePhotoPicked = (file: File | undefined | null) => {
    const key = licensePhotoTargetRef.current;
    licensePhotoTargetRef.current = null;
    if (!key || !file) return;
    updateLicenseDraft(key, { file, preview: URL.createObjectURL(file) });
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
    setInheritFromCategoryId(null);
    if (opts.pendingLocationReview) {
      toast.success(s.vendor_gps_pending_review_toast);
    } else {
      toast.success(s.vendor_photo_verified);
    }
  };

  const handleShopPhoto = (shot: CapturedShot) => {
    setCameraOpen(false);
    // Gate against THIS business pin when set; else first capture establishes the pin.
    const pin = gatePin;
    if (pin != null) {
      const match = evaluateGpsMatch(pin, shot.coords);
      if (!match.ok) {
        const nextFails = gpsMatchFailCount + 1;
        setGpsMatchFailCount(nextFails);
        setLastFailedShopShot(shot);
        void logGpsMatchFailure({
          distanceMeters: match.distanceMeters,
          locationAccuracy: match.locationAccuracy,
          photoAccuracy: match.photoAccuracy,
          effectiveTolerance: match.effectiveTolerance,
          source: "add_business",
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
    setGatePin(shot.coords);
  };

  const submitShopPhotoForLocationReview = () => {
    if (!lastFailedShopShot || gatePin == null) return;
    const match = evaluateGpsMatch(gatePin, lastFailedShopShot.coords);
    acceptShopPhoto(lastFailedShopShot, {
      distance: match.distanceMeters,
      locationAccuracy: match.locationAccuracy,
      photoAccuracy: match.photoAccuracy,
      pendingLocationReview: true,
    });
  };

  const readDeviceGps = (): Promise<GpsPoint | null> =>
    new Promise((resolve) => {
      if (!("geolocation" in navigator)) {
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (p) =>
          resolve({
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            accuracy:
              typeof p.coords.accuracy === "number" && Number.isFinite(p.coords.accuracy)
                ? p.coords.accuracy
                : null,
          }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
      );
    });

  const beginShopPhotoFlow = async () => {
    if (colocatedChecking) return;
    setColocatedChecking(true);
    setColocated(null);
    try {
      const gps = await readDeviceGps();
      if (!gps) {
        // No GPS: fall back to camera; pin established on capture.
        setGatePin(null);
        setCameraOpen(true);
        return;
      }
      const { data, error } = await supabase.rpc("vendor_find_colocated_category", {
        p_vendor_id: vendor.id,
        p_vendor_phone: vendorPhone,
        p_lat: gps.lat,
        p_lng: gps.lng,
        p_exclude_category_id: selectedCategoryId,
      });
      if (error) {
        console.error("vendor_find_colocated_category", error);
        setGatePin(null);
        setCameraOpen(true);
        return;
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.category_id) {
        setColocated({
          category_id: String(row.category_id),
          distance_meters: Number(row.distance_meters),
          shop_photo_url: row.shop_photo_url ?? null,
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
          category_label: row.category_label ?? null,
          brand_name: row.brand_name ?? null,
        });
        setGatePin({
          lat: Number(row.latitude),
          lng: Number(row.longitude),
          accuracy: null,
        });
        return;
      }
      // No match: new location — gate against nothing yet; capture sets pin.
      setGatePin(null);
      setCameraOpen(true);
    } finally {
      setColocatedChecking(false);
    }
  };

  const confirmReuseColocated = () => {
    if (!colocated) return;
    setInheritFromCategoryId(colocated.category_id);
    setShopPhotoBlob(null);
    setShopPhotoDataUrl(colocated.shop_photo_url);
    setShopPhotoCoords({
      lat: colocated.latitude,
      lng: colocated.longitude,
    });
    setShopPhotoGpsDistance(0);
    setShopPhotoPendingLocationReview(false);
    setLastFailedShopShot(null);
    setColocated(null);
    toast.success(s.my_business_photo_reused);
  };

  const captureNewDespiteColocated = () => {
    // Fresh capture at a NEW pin for this business (user declined reuse).
    setInheritFromCategoryId(null);
    setColocated(null);
    setGatePin(null);
    setCameraOpen(true);
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

  const submit = async () => {
    if (!ready || !selectedCategoryId || !reachFlags) return;
    if (!shopPhotoBlob && !inheritFromCategoryId) return;

    const persistLicenses = async () => {
      if (licenseFields.length === 0) return;
      const filledLicenses: Array<{
        category_id: string;
        license_type: string;
        license_number: string | null;
        photo_url: string | null;
      }> = [];
      for (const field of licenseFields) {
        const draft = licenseDrafts[field.fieldKey];
        const number = String(draft?.number ?? "").trim();
        let photoUrl: string | null = null;
        if (draft?.file) {
          const path = `license-docs/${vendor.id}/${selectedCategoryId}/${field.licenseType}_${Date.now()}.jpg`;
          const { error: upErr } = await supabase.storage.from("vendor-docs").upload(
            path,
            draft.file,
            { contentType: draft.file.type || "image/jpeg", upsert: true },
          );
          if (!upErr) {
            photoUrl = supabase.storage.from("vendor-docs").getPublicUrl(path).data.publicUrl;
          }
        }
        if (licenseFieldHasValue({ license_number: number, photo_url: photoUrl })) {
          filledLicenses.push({
            category_id: selectedCategoryId,
            license_type: field.licenseType,
            license_number: number || null,
            photo_url: photoUrl,
          });
        }
      }
      if (filledLicenses.length === 0) return;
      await supabase.rpc("vendor_upsert_licenses", {
        p_vendor_id: vendor.id,
        p_vendor_phone: vendorPhone,
        p_licenses: filledLicenses,
      });
    };

    const modesById: Record<string, AvailabilityMode[]> = {};
    for (const id of existingCategoryIds) {
      const modes = normalizeAvailabilityModes(existingSettings[id]?.availability_modes);
      if (modes.length === 0) {
        toast.error(s.vendor_update_failed);
        return;
      }
      modesById[id] = modes;
    }
    modesById[selectedCategoryId] = normalizeAvailabilityModes(availabilityModes);

    const nextIds = [...existingCategoryIds, selectedCategoryId];
    const categoryModesPayload = buildCategoryModesPayload(nextIds, modesById);
    const categoryServiceModes = nextIds.map((id) => {
      const cat = categories.find((c) => c.id === id);
      return pickPrimaryAvailabilityMode(modesById[id], cat?.service_mode);
    });
    const shopName = String(vendor.shop_name ?? "").trim();
    const brandNames = nextIds.map(() => shopName);
    const servesVendorPlace = nextIds.map((id) => {
      if (id === selectedCategoryId) return reachFlags.serves_at_vendor_place;
      const cfg = existingSettings[id];
      return reachFlagsFromChoice(cfg?.reachChoice)?.serves_at_vendor_place === true;
    });
    const servesCustomerPlace = nextIds.map((id) => {
      if (id === selectedCategoryId) return reachFlags.serves_at_customer_place;
      const cfg = existingSettings[id];
      return reachFlagsFromChoice(cfg?.reachChoice)?.serves_at_customer_place === true;
    });
    const radii = nextIds.map((id, i) => {
      if (!servesCustomerPlace[i]) return null;
      if (id === selectedCategoryId) return serviceRadiusKm;
      return existingSettings[id]?.service_radius_km ?? null;
    });

    setSubmitting(true);
    const { error: vcError } = await supabase.rpc("vendor_update_categories", {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendorPhone,
      p_category_ids: nextIds,
      p_category_service_modes: categoryServiceModes,
      p_category_modes: categoryModesPayload,
      p_brand_names: brandNames,
      p_serves_at_vendor_place: servesVendorPlace,
      p_serves_at_customer_place: servesCustomerPlace,
      p_service_radius_km: radii,
      p_upi_id: upi.trim(),
      p_upi_qr_url: upiQrUrl || null,
      p_upi_qr_payee_id: upiQrPayeeId,
      p_base_type: baseType,
    });
    if (vcError) {
      setSubmitting(false);
      toast.error(s.vendor_categories_partial_save);
      return;
    }
    triggerCategoryModeConfidenceCheck(nextIds);

    if (vendorNote.trim()) {
      await supabase.rpc("vendor_update_category_profile", {
        p_vendor_id: vendor.id,
        p_vendor_phone: vendorPhone,
        p_category_id: selectedCategoryId,
        p_patch: { vendor_note: vendorNote.trim() },
      });
    }

    const filledReasons = cancelReasons.map((r) => r.trim());
    if (filledReasons.some((r) => r.length > 0)) {
      const { error: reasonsErr } = await supabase.rpc(
        "vendor_upsert_category_cancel_reasons",
        {
          p_vendor_id: vendor.id,
          p_vendor_phone: vendorPhone,
          p_category_id: selectedCategoryId,
          p_reasons: filledReasons,
        },
      );
      if (reasonsErr) {
        console.error("cancel reasons upsert failed", reasonsErr);
      }
    }

    if (inheritFromCategoryId) {
      const { error: inheritErr } = await supabase.rpc("vendor_inherit_colocated_shop_photo", {
        p_vendor_id: vendor.id,
        p_vendor_phone: vendorPhone,
        p_category_id: selectedCategoryId,
        p_from_category_id: inheritFromCategoryId,
      });
      if (inheritErr) {
        setSubmitting(false);
        toast.error(s.vendor_save_verification_failed, { description: inheritErr.message });
        return;
      }
      void checkAndNotifyAdminCategoryGreenReady(vendor.id, selectedCategoryId, {
        shopName: vendor.shop_name,
        vendorPhone,
      });
      triggerProactiveCategoryAliases({
        vendorId: vendor.id,
        categoryId: selectedCategoryId,
      });
      await persistLicenses();
      setSubmitting(false);
      toast.success(needsAdminReview ? s.my_business_pending_review_toast : s.my_business_saved);
      onOpenChange(false);
      onAdded();
      return;
    }

    if (!shopPhotoBlob) {
      setSubmitting(false);
      return;
    }

    const path = `${vendor.id}/${selectedCategoryId}/${Date.now()}.jpg`;
    const { error: upErr } = await supabase.storage
      .from(SHOP_PHOTOS_BUCKET)
      .upload(path, shopPhotoBlob, { contentType: "image/jpeg", upsert: true });
    if (upErr) {
      setSubmitting(false);
      toast.error(s.vendor_upload_failed, { description: upErr.message });
      return;
    }
    const { data: pub } = supabase.storage.from(SHOP_PHOTOS_BUCKET).getPublicUrl(path);

    // Business pin: existing gate pin, else capture coords (first pin for this business).
    const bizLat = gatePin?.lat ?? shopPhotoCoords?.lat ?? null;
    const bizLng = gatePin?.lng ?? shopPhotoCoords?.lng ?? null;
    const accountEmpty = vendor.latitude == null || vendor.longitude == null;

    const { error: photoErr } = await supabase.rpc("vendor_submit_category_shop_photo", {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendorPhone,
      p_category_id: selectedCategoryId,
      p_shop_photo_url: pub.publicUrl,
      p_gps_match_distance: shopPhotoGpsDistance,
      p_set_account_lat: accountEmpty ? bizLat : null,
      p_set_account_lng: accountEmpty ? bizLng : null,
      p_pending_location_review: shopPhotoPendingLocationReview,
      p_location_accuracy: shopPhotoLocationAccuracy,
      p_photo_accuracy: shopPhotoAccuracy,
      p_set_account_location_accuracy: accountEmpty
        ? shopPhotoCoords?.accuracy ?? null
        : null,
      p_business_lat: bizLat,
      p_business_lng: bizLng,
    });
    if (photoErr) {
      setSubmitting(false);
      toast.error(s.vendor_save_verification_failed, { description: photoErr.message });
      return;
    }

    await persistLicenses();

    void checkAndNotifyAdminCategoryGreenReady(vendor.id, selectedCategoryId, {
      shopName: vendor.shop_name,
      vendorPhone,
    });
    triggerProactiveCategoryAliases({
      vendorId: vendor.id,
      categoryId: selectedCategoryId,
    });

    setSubmitting(false);
    toast.success(needsAdminReview ? s.my_business_pending_review_toast : s.my_business_saved);
    onOpenChange(false);
    onAdded();
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[92vh] overflow-y-auto rounded-t-2xl p-0"
        >
          <SheetHeader className="px-4 pt-4 pb-2 text-left">
            <SheetTitle>{s.my_business_add_business}</SheetTitle>
            <SheetDescription data-testid="add-business-review-hint">
              {needsAdminReview ? s.my_business_add_business_review_hint : s.my_business_add_business_hint}
            </SheetDescription>
          </SheetHeader>

          <div className="px-4 pb-6 space-y-4" data-testid="add-business-sheet">
            {available.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {s.vendor_categories_selected(existingCategoryIds.length)}
              </p>
            ) : (
              <>
                {setupPage === 1 && (
              <>
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {s.vendor_categories_label} *
                  </label>
                  {categoriesLoading ? (
                    <p className="mt-2 text-xs text-muted-foreground inline-flex items-center gap-1.5">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {s.vendor_understanding}
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {available.map((cat) => {
                        const selected = selectedCategoryId === cat.id;
                        return (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => {
                              setSelectedCategoryId((prev) => {
                                const next = prev === cat.id ? null : cat.id;
                                if (next) {
                                  setAvailabilityModes(
                                    initialModesForCatalog(
                                      resolveCatalogServiceMode(cat.service_mode),
                                    ),
                                  );
                                } else {
                                  setAvailabilityModes([]);
                                }
                                setSetupPage(1);
                                return next;
                              });
                            }}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium",
                              selected
                                ? "border-primary bg-primary/20 ring-1 ring-primary/30"
                                : "border-border bg-card",
                            )}
                          >
                            {cat.emoji} {getLabel(cat.label)}
                            <span className="text-[10px] text-muted-foreground">
                              {categoryServiceModeChipLabel(cat.service_mode, s)}
                            </span>
                          </button>
                        );
                      })}
                      {available.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          {s.vendor_categories_pick}
                        </p>
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
                      testId="add-business-base-shop"
                    />
                    <ChoiceCard
                      selected={baseType === "home"}
                      onClick={() => setBaseType("home")}
                      emoji="🏠"
                      title={s.reg_base_home}
                      desc={s.reg_base_home_desc}
                      testId="add-business-base-home"
                    />
                    <ChoiceCard
                      selected={baseType === "none"}
                      onClick={() => setBaseType("none")}
                      emoji="🚫"
                      title={s.reg_base_none}
                      desc={s.reg_base_none_desc}
                      testId="add-business-base-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {s.vendor_upi_label} *
                  </label>
                  <input
                    type="text"
                    data-testid="add-business-upi"
                    value={upi}
                    onChange={(e) => setUpi(e.target.value)}
                    onBlur={() => setUpiBlurred(true)}
                    placeholder={s.vendor_upi_placeholder}
                    className="mt-1 w-full bg-card border border-border rounded-xl px-4 py-2.5 text-sm"
                  />
                  {upiFormatError && (
                    <p className="mt-1 text-xs text-destructive">{upiFormatError}</p>
                  )}
                </div>
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
                    data-testid="add-business-upi-qr"
                    disabled={upiQrUploading}
                    onClick={() => upiQrInputRef.current?.click()}
                    className="mt-1 w-full rounded-xl border border-border py-2.5 text-sm"
                  >
                    {upiQrUploading ? s.vendor_uploading : s.vendor_upi_qr_hint}
                  </button>
                </div>

                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {s.my_business_category_reach} *
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
                      {s.my_business_category_radius} *
                    </p>
                    <div className="mt-3">
                      <ServiceRadiusChips
                        value={serviceRadiusKm}
                        onChange={setServiceRadiusKm}
                      />
                    </div>
                  </div>
                )}

                <CategoryAvailabilityModeSelector
                  variant="pills"
                  label={s.my_business_category_availability}
                  required
                  testIdPrefix="add-business-avail"
                  catalogServiceMode={resolveCatalogServiceMode(
                    categories.find((c) => c.id === selectedCategoryId)?.service_mode,
                  )}
                  value={availabilityModes}
                  onChange={setAvailabilityModes}
                />

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
                        className="w-full bg-card border border-border rounded-xl px-4 py-2.5 text-sm"
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
                  <p className="mt-1 text-xs text-muted-foreground">
                    {s.business_photo_verify_hint}
                  </p>
                  {colocated && (
                    <div
                      className="mt-2 rounded-xl border border-brand/40 bg-brand/5 p-3 space-y-2"
                      data-testid="add-business-same-shop"
                    >
                      <p className="text-sm font-semibold text-foreground">
                        {s.my_business_same_shop_title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {s.my_business_same_shop_body(
                          colocated.category_label
                            ? getLabel(colocated.category_label)
                            : colocated.brand_name || s.business_photo_verify,
                        )}
                      </p>
                      <div className="flex flex-col gap-2">
                        <button
                          type="button"
                          data-testid="add-business-reuse-photo"
                          onClick={confirmReuseColocated}
                          className="w-full rounded-xl bg-primary text-primary-foreground py-2.5 text-sm font-semibold"
                        >
                          {s.my_business_reuse_photo}
                        </button>
                        <button
                          type="button"
                          data-testid="add-business-capture-new-photo"
                          onClick={captureNewDespiteColocated}
                          className="w-full rounded-xl border border-border py-2.5 text-sm font-semibold"
                        >
                          {s.my_business_capture_new_photo}
                        </button>
                      </div>
                    </div>
                  )}
                  <button
                    type="button"
                    data-testid="add-business-shop-photo"
                    disabled={colocatedChecking}
                    onClick={() => void beginShopPhotoFlow()}
                    className={cn(
                      "mt-2 w-full rounded-xl border-2 py-3.5 flex items-center justify-center gap-2 font-semibold disabled:opacity-50",
                      photoReady
                        ? "border-secondary text-secondary bg-secondary/5"
                        : "border-border",
                    )}
                  >
                    {colocatedChecking ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : photoReady ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <Camera className="h-4 w-4" />
                    )}
                    {photoReady
                      ? inheritFromCategoryId
                        ? s.my_business_reuse_photo
                        : s.vendor_reshoot
                      : s.my_business_verify_now}
                  </button>
                  {gpsMatchFailCount >= GPS_MATCH_FAILS_BEFORE_SOFT_REVIEW &&
                    lastFailedShopShot &&
                    !photoReady && (
                      <button
                        type="button"
                        data-testid="add-business-gps-submit-for-review"
                        onClick={submitShopPhotoForLocationReview}
                        className="mt-2 w-full rounded-xl border border-amber-500/50 bg-amber-500/10 py-3 text-sm font-semibold text-amber-800"
                      >
                        {s.vendor_gps_submit_for_review}
                      </button>
                    )}
                  {shopPhotoDataUrl && (
                    <img
                      src={shopPhotoDataUrl}
                      alt={s.vendor_captured_shop}
                      className="mt-2 w-full rounded-xl border border-border"
                    />
                  )}
                </div>

                {needsLicenseStep ? (
                  <button
                    type="button"
                    data-testid="add-business-next"
                    disabled={!ready || submitting}
                    onClick={() => setSetupPage(2)}
                    className="w-full rounded-2xl bg-primary text-primary-foreground py-3.5 text-sm font-semibold disabled:opacity-50"
                  >
                    {s.reg_wizard_next}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="add-business-submit"
                    disabled={!ready || submitting}
                    onClick={() => void submit()}
                    className="w-full rounded-2xl bg-primary text-primary-foreground py-3.5 text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
                  >
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {s.my_business_add_business}
                  </button>
                )}
              </>
                )}
                {setupPage === 2 && (
                  <div className="space-y-3" data-testid="add-business-license-step">
                    <p className="text-sm font-semibold text-foreground text-center">
                      {s.reg_step_licenses}
                    </p>
                    <p
                      className="text-xs text-muted-foreground leading-relaxed text-center"
                      data-testid="add-business-license-disclaimer"
                    >
                      {s.reg_license_disclaimer}
                    </p>
                    {licenseFields.map((field) => {
                      const draft = licenseDrafts[field.fieldKey];
                      return (
                        <div
                          key={field.fieldKey}
                          data-testid={`add-business-license-field-${field.licenseType}`}
                          className="rounded-2xl border border-border p-3 space-y-2"
                        >
                          <p className="text-sm font-semibold text-foreground">
                            {getLabel(field.categoryLabel)} ·{" "}
                            {licenseTypeLabel(field.licenseType, s, field.displayName)}
                          </p>
                          <div>
                            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              {s.reg_license_number}
                            </label>
                            <input
                              type="text"
                              value={draft?.number ?? ""}
                              onChange={(e) =>
                                updateLicenseDraft(field.fieldKey, { number: e.target.value })
                              }
                              placeholder={s.reg_license_number}
                              className="mt-1 w-full bg-card border border-border rounded-xl px-4 py-2.5 text-sm"
                            />
                          </div>
                          <div>
                            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              {s.reg_license_photo}
                            </label>
                            <button
                              type="button"
                              data-testid={`add-business-license-photo-${field.licenseType}`}
                              onClick={() => {
                                licensePhotoTargetRef.current = field.fieldKey;
                                licensePhotoInputRef.current?.click();
                              }}
                              className="mt-2 w-full rounded-xl border border-border py-3 text-sm font-semibold"
                            >
                              {draft?.preview
                                ? s.reg_license_photo_replace
                                : s.reg_license_photo_upload}
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
                        onClick={() => setSetupPage(1)}
                        className="flex-1 rounded-2xl border border-border py-3.5 text-sm font-semibold"
                      >
                        {s.reg_wizard_back}
                      </button>
                      <button
                        type="button"
                        data-testid="add-business-license-skip"
                        disabled={submitting}
                        onClick={() => void submit()}
                        className="flex-1 rounded-2xl border border-border py-3.5 text-sm font-semibold disabled:opacity-50"
                      >
                        {s.reg_license_skip}
                      </button>
                      <button
                        type="button"
                        data-testid="add-business-submit"
                        disabled={submitting}
                        onClick={() => void submit()}
                        className="flex-[2] rounded-2xl bg-primary text-primary-foreground py-3.5 text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
                      >
                        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        {s.my_business_add_business}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <LiveCamera open={cameraOpen} onClose={() => setCameraOpen(false)} onCapture={handleShopPhoto} />
    </>
  );
}
