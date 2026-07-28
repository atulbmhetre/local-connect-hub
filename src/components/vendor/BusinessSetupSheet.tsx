import { useEffect, useState } from "react";
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
} from "@/lib/supabase";
import {
  GPS_MATCH_FAILS_BEFORE_SOFT_REVIEW,
  evaluateGpsMatch,
  logGpsMatchFailure,
  type GpsPoint,
} from "@/lib/gpsMatch";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import { checkAndNotifyAdminCategoryGreenReady } from "@/lib/vendorGreenReady";
import {
  type AvailabilityMode,
  type ReachChoiceValue,
  reachFlagsFromChoice,
  MAX_REG_CATEGORIES,
} from "@/lib/vendorRegistration";
import { CategoryAvailabilityModeSelector } from "@/components/vendor/CategoryAvailabilityModeSelector";
import {
  buildCategoryModesPayload,
  normalizeAvailabilityModes,
  pickPrimaryAvailabilityMode,
} from "@/lib/categoryAvailabilityModes";

export type BusinessSetupExistingSettings = {
  reachChoice: ReachChoiceValue;
  service_radius_km: number | null;
  availability_modes: AvailabilityMode[];
};

type RegCategoryRow = Pick<Category, "id" | "label" | "emoji"> & {
  service_mode: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendor: Vendor;
  existingCategoryIds: string[];
  existingSettings: Record<string, BusinessSetupExistingSettings>;
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

export function BusinessSetupSheet({
  open,
  onOpenChange,
  vendor,
  existingCategoryIds,
  existingSettings,
  onAdded,
}: Props) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const vendorPhone = (vendor.phone ?? "").trim();

  const [categories, setCategories] = useState<RegCategoryRow[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
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

  useEffect(() => {
    if (!open) return;
    setSelectedCategoryId(null);
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
    setCategoriesLoading(true);
    void supabase
      .from("categories")
      .select("id, label, emoji, service_mode")
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
  const atMax = existingCategoryIds.length >= MAX_REG_CATEGORIES;
  const reachFlags = reachChoice ? reachFlagsFromChoice(reachChoice) : null;
  const needsRadius = reachFlags?.serves_at_customer_place === true;
  const radiusOk = !needsRadius || serviceRadiusKm != null;
  const ready =
    selectedCategoryId != null &&
    reachChoice !== "" &&
    radiusOk &&
    availabilityModes.length > 0 &&
    shopPhotoBlob != null &&
    !atMax;

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

  const handleShopPhoto = (shot: CapturedShot) => {
    setCameraOpen(false);
    const hasShopLocation = vendor.latitude != null && vendor.longitude != null;
    if (hasShopLocation) {
      const match = evaluateGpsMatch(
        {
          lat: vendor.latitude!,
          lng: vendor.longitude!,
          accuracy: vendor.location_accuracy,
        },
        shot.coords,
      );
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
  };

  const submitShopPhotoForLocationReview = () => {
    if (!lastFailedShopShot || vendor.latitude == null || vendor.longitude == null) return;
    const match = evaluateGpsMatch(
      {
        lat: vendor.latitude,
        lng: vendor.longitude,
        accuracy: vendor.location_accuracy,
      },
      lastFailedShopShot.coords,
    );
    acceptShopPhoto(lastFailedShopShot, {
      distance: match.distanceMeters,
      locationAccuracy: match.locationAccuracy,
      photoAccuracy: match.photoAccuracy,
      pendingLocationReview: true,
    });
  };

  const submit = async () => {
    if (!ready || !selectedCategoryId || !reachFlags || !shopPhotoBlob) return;

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
    });
    if (vcError) {
      setSubmitting(false);
      toast.error(s.vendor_categories_partial_save);
      return;
    }

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

    const hasShopLocation = vendor.latitude != null && vendor.longitude != null;
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
    const { error: photoErr } = await supabase.rpc("vendor_submit_category_shop_photo", {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendorPhone,
      p_category_id: selectedCategoryId,
      p_shop_photo_url: pub.publicUrl,
      p_gps_match_distance: shopPhotoGpsDistance,
      p_set_account_lat: hasShopLocation ? null : shopPhotoCoords?.lat ?? null,
      p_set_account_lng: hasShopLocation ? null : shopPhotoCoords?.lng ?? null,
      p_pending_location_review: shopPhotoPendingLocationReview,
      p_location_accuracy: shopPhotoLocationAccuracy,
      p_photo_accuracy: shopPhotoAccuracy,
      p_set_account_location_accuracy: hasShopLocation
        ? null
        : shopPhotoCoords?.accuracy ?? null,
    });
    if (photoErr) {
      setSubmitting(false);
      toast.error(s.vendor_save_verification_failed, { description: photoErr.message });
      return;
    }

    void checkAndNotifyAdminCategoryGreenReady(vendor.id, selectedCategoryId, {
      shopName: vendor.shop_name,
      vendorPhone,
    });

    setSubmitting(false);
    toast.success(s.my_business_saved);
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
            <SheetDescription>{s.my_business_add_business_hint}</SheetDescription>
          </SheetHeader>

          <div className="px-4 pb-6 space-y-4">
            {atMax ? (
              <p className="text-sm text-muted-foreground">
                {s.vendor_categories_selected(existingCategoryIds.length)}
              </p>
            ) : (
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
                            onClick={() =>
                              setSelectedCategoryId((prev) =>
                                prev === cat.id ? null : cat.id,
                              )
                            }
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
                  <button
                    type="button"
                    data-testid="add-business-shop-photo"
                    onClick={() => setCameraOpen(true)}
                    className={cn(
                      "mt-2 w-full rounded-xl border-2 py-3.5 flex items-center justify-center gap-2 font-semibold",
                      shopPhotoBlob
                        ? "border-secondary text-secondary bg-secondary/5"
                        : "border-border",
                    )}
                  >
                    {shopPhotoBlob ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <Camera className="h-4 w-4" />
                    )}
                    {shopPhotoBlob ? s.vendor_reshoot : s.my_business_verify_now}
                  </button>
                  {gpsMatchFailCount >= GPS_MATCH_FAILS_BEFORE_SOFT_REVIEW &&
                    lastFailedShopShot &&
                    !shopPhotoBlob && (
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
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <LiveCamera open={cameraOpen} onClose={() => setCameraOpen(false)} onCapture={handleShopPhoto} />
    </>
  );
}
