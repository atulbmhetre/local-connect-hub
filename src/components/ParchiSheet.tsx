import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Camera, ChevronDown, Loader2, MapPin, Mic } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { getVoiceLang } from "@/lib/voiceUtils";
import { captureError } from "@/lib/sentry";
import { ensureVoiceMicrophone } from "@/lib/nativePermissions";
import { UpiPaymentPanel } from "@/components/payment/UpiPaymentPanel";
import { TrustWarningBanner } from "@/components/TrustWarningBanner";
import { vendorBinaryTrustTier } from "@/lib/vendorBinaryTrust";
import { deriveBusinessLocationPasses, type BusinessLocationRow } from "@/lib/trustLevel";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  supabase,
  fetchUserTrust,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  type Vendor,
} from "@/lib/supabase";
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
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone, isPhoneKnown, migrateUserPhone } from "@/lib/userIdentity";
import { filterMenuItemsByCategoryContext, resolveCategoryVendorNote } from "@/lib/categoryScopedVendor";
import { formatVisitFeeAmount } from "@/lib/visitFee";
import {
  deliveryCartSubtotal,
  formatMinDeliveryOrderAmount,
  meetsMinDeliveryOrder,
} from "@/lib/deliveryMinOrder";
import { getIstHour, DELIVERY_ASAP_OFFSET_MS, DELIVERY_SLOT_CUTOFF_HOUR } from "@/lib/deliverySlotDeadline";
import {
  executeOrderInsert as executeOrderInsertCore,
  menuItemLabel,
  type ParchiVendorMenuItem,
} from "@/lib/executeOrderInsert";
import { clearOrderPlacementIdempotencyKey } from "@/lib/orderPlacementIdempotency";
import { PhoneEntrySheet } from "@/components/PhoneEntrySheet";
import { toast } from "sonner";
import { useLanguage } from "@/lib/language";
import { withNetworkRetry } from "@/lib/withNetworkRetry";
import { fetchParseImageJson } from "@/lib/parseImageFetch";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import { useAppConfig } from "@/hooks/useAppConfig";
import { useUserAddresses, type SavedAddress } from "@/hooks/useUserAddresses";
import { MAX_ADDRESS_TEXT_CHARS } from "@/lib/addressLimits";
import { cn } from "@/lib/utils";

type VendorMenuItem = ParchiVendorMenuItem;

export type ParchiPaymentOrder = {
  id: string;
  status: string;
  payment_status: "unpaid" | "claimed" | "confirmed" | "disputed";
  amount: number;
};

type VendorWithQr = Vendor & {
  upi_qr_url?: string | null;
  upi_qr_payee_id?: string | null;
};

type Props = {
  vendor: Vendor | null;
  vendorId?: string | null;
  serviceMode?: string | null;
  /** Matched/search category id from Radar (optional; RPC falls back to primary). */
  orderCategoryId?: string | null;
  /** Display label for the matched category (used in vendor push title). */
  orderCategoryLabel?: string | null;
  /** Category-scoped reach when ordering in a matched category context. */
  orderCategoryReach?: {
    serves_at_vendor_place: boolean;
    serves_at_customer_place: boolean;
  } | null;
  isOpen: boolean;
  onClose: () => void;
  /** Fulfilled order with payment details (optional). */
  order?: ParchiPaymentOrder | null;
  /** After successful order send; e.g. refresh radar resolution button visibility. */
  onOrderSent?: () => void;
  /** When user cancels an in-flight order/booking from this sheet (optional). */
  onOrderCancelled?: () => void;
};


export function ParchiSheet({
  vendor,
  vendorId: vendorIdProp,
  serviceMode: serviceModeProp,
  orderCategoryId = null,
  orderCategoryLabel = null,
  orderCategoryReach = null,
  isOpen,
  onClose,
  order,
  onOrderSent,
}: Props) {
  const { s } = useLanguage();
  const { config } = useAppConfig();
  const SLOT_LABELS: Record<string, string> = useMemo(() => ({
    asap: s.parchi_slotAsap,
    morning: s.parchi_slotMorning,
    afternoon: s.parchi_slotAfternoon,
    evening: s.parchi_slotEvening,
    tomorrow: s.parchi_slotTomorrow,
  }), [s]);
  const [message, setMessage] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [sending, setSending] = useState(false);
  /** Sync guard — `disabled={sending}` alone loses a fast double-tap before re-render. */
  const sendingLockRef = useRef(false);
  const [phoneSheetOpen, setPhoneSheetOpen] = useState(false);
  const { addresses, loading: addressLoading } = useUserAddresses();
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [newAddress, setNewAddress] = useState("");
  const [saveAddress, setSaveAddress] = useState(false);
  const [appointmentDate, setAppointmentDate] = useState("");
  const [appointmentTime, setAppointmentTime] = useState("");
  const [appointmentLocation, setAppointmentLocation] = useState<"home" | "shop" | "decide">("decide");
  const [helpLocation, setHelpLocation] = useState<"home" | "shop" | null>(null);
  const [deliverySlot, setDeliverySlot] = useState<string>("asap");
  const [appointmentTiming, setAppointmentTiming] = useState<"instant" | "scheduled">(
    "scheduled",
  );
  const [recurrenceKind, setRecurrenceKind] = useState<
    "one_time" | "daily" | "weekly" | "custom"
  >("one_time");
  const [recurrenceCustomDays, setRecurrenceCustomDays] = useState("3");
  const [offlineApptError, setOfflineApptError] = useState(false);
  const [trustBlock, setTrustBlock] = useState<
    "banned" | "suspended" | "payment_block" | null
  >(null);
  const [paymentBlockInfo, setPaymentBlockInfo] = useState<{
    vendorName: string;
    amount: number;
    requestId: string;
  } | null>(null);
  const navigate = useNavigate();
  const [lowTrustSheetOpen, setLowTrustSheetOpen] = useState(false);
  const [lowTrustConfirmed, setLowTrustConfirmed] = useState(false);
  const [mediumTrustDialogOpen, setMediumTrustDialogOpen] = useState(false);
  const [pendingPhone, setPendingPhone] = useState<string | null>(null);
  const [menuItems, setMenuItems] = useState<VendorMenuItem[]>([]);
  const [selectedMenuItems, setSelectedMenuItems] = useState<Record<string, number>>({});
  const selectedMenuItemsRef = useRef(selectedMenuItems);
  const menuItemsRef = useRef<VendorMenuItem[]>([]);
  selectedMenuItemsRef.current = selectedMenuItems;
  menuItemsRef.current = menuItems;
  const [menuExpanded, setMenuExpanded] = useState(true);
  const [businessGpsVerified, setBusinessGpsVerified] = useState<boolean | null>(null);
  const [categoryVendorNote, setCategoryVendorNote] = useState<string | null>(null);
  const [inspectionFee, setInspectionFee] = useState<number | null>(null);
  const [minDeliveryOrderAmount, setMinDeliveryOrderAmount] = useState<number | null>(null);
  const [businessUpi, setBusinessUpi] = useState<{
    upi_id: string;
    upi_qr_url: string | null;
    upi_qr_payee_id: string | null;
  } | null>(null);
  const lastVendor = useRef<Vendor | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const phoneSheetOpenRef = useRef(false);
  const [customerLat, setCustomerLat] = useState<number | null>(null);
  const [customerLng, setCustomerLng] = useState<number | null>(null);
  const [shareLocationEnabled, setShareLocationEnabled] = useState(false);
  const [locationPermissionBlocked, setLocationPermissionBlocked] = useState(false);
  const [locationCaptured, setLocationCaptured] = useState(false);
  useEffect(() => {
    if (vendor) lastVendor.current = vendor;
  }, [vendor]);

  const resetFormFields = useCallback(() => {
    setMessage("");
    setAppointmentDate("");
    setAppointmentTime("");
    setAppointmentLocation("decide");
    setHelpLocation(null);
    setDeliverySlot("asap");
    setAppointmentTiming("scheduled");
    setRecurrenceKind("one_time");
    setRecurrenceCustomDays("3");
    setOfflineApptError(false);
    setSelectedAddressId(null);
    setNewAddress("");
    setSelectedMenuItems({});
    setSending(false);
    setPendingPhone(null);
    setMenuExpanded(true);
    setCustomerLat(null);
    setCustomerLng(null);
    setShareLocationEnabled(false);
    setLocationPermissionBlocked(false);
    setLocationCaptured(false);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    resetFormFields();
    window.dispatchEvent(new Event("resize"));
    setTimeout(() => {
      scrollContainerRef.current?.scrollTo({ top: 0 });
    }, 50);
  }, [isOpen, resetFormFields]);
  
  const effectiveVendor = vendor ?? lastVendor.current;
  const resolvedVendorId = vendorIdProp ?? effectiveVendor?.id ?? null;
  
  // Fetch business-specific GPS verification when orderCategoryId is available
  useEffect(() => {
    if (!orderCategoryId || !resolvedVendorId) {
      setBusinessGpsVerified(null);
      setCategoryVendorNote(null);
      setInspectionFee(null);
      setMinDeliveryOrderAmount(null);
      setBusinessUpi(null);
      return;
    }

    const fetchBusinessGps = async () => {
      try {
        const { data, error } = await supabase
          .from("vendor_categories")
          .select("gps_match_distance, location_accuracy, photo_accuracy, verification_status, vendor_note, inspection_fee, min_delivery_order_amount, upi_id, upi_qr_url, upi_qr_payee_id")
          .eq("vendor_id", resolvedVendorId)
          .eq("category_id", orderCategoryId)
          .single();

        if (error || !data) {
          setBusinessGpsVerified(null);
          setCategoryVendorNote(null);
          setInspectionFee(null);
          setMinDeliveryOrderAmount(null);
          setBusinessUpi(null);
          return;
        }

        const note = String(data.vendor_note ?? "").trim();
        setCategoryVendorNote(note || null);
        setInspectionFee(formatVisitFeeAmount(data.inspection_fee));
        setMinDeliveryOrderAmount(formatMinDeliveryOrderAmount(data.min_delivery_order_amount));
        setBusinessUpi({
          upi_id: String(data.upi_id ?? "").trim(),
          upi_qr_url: data.upi_qr_url ?? null,
          upi_qr_payee_id: data.upi_qr_payee_id ?? null,
        });

        const businessLocationData: BusinessLocationRow = {
          vendor_id: resolvedVendorId,
          category_id: orderCategoryId,
          gps_match_distance: data.gps_match_distance,
          location_accuracy: data.location_accuracy,
          photo_accuracy: data.photo_accuracy,
          verification_status: data.verification_status,
        };

        const { gps } = deriveBusinessLocationPasses(businessLocationData);
        setBusinessGpsVerified(gps);
      } catch (err) {
        console.error("Failed to fetch business GPS data:", err);
        setBusinessGpsVerified(null);
        setBusinessUpi(null);
      }
    };

    void fetchBusinessGps();
  }, [orderCategoryId, resolvedVendorId]);
  const resolvedServiceMode =
    serviceModeProp ?? effectiveVendor?.service_mode ?? "help";
  const isDeliveryMode = resolvedServiceMode === "delivery";
  const isAppointmentMode = resolvedServiceMode === "appointment";
  const isHelpMode = resolvedServiceMode === "help";
  const showRecurrence =
    (isDeliveryMode && deliverySlot !== "asap" && deliverySlot !== "tomorrow") ||
    (isAppointmentMode && appointmentTiming === "scheduled");

  const resolvedReach = orderCategoryReach ?? {
    serves_at_vendor_place: effectiveVendor?.serves_at_vendor_place === true,
    serves_at_customer_place:
      effectiveVendor?.serves_at_customer_place === true ||
      (effectiveVendor?.serves_at_vendor_place !== true &&
        effectiveVendor?.serves_at_customer_place !== false),
  };
  const canServeAtCustomer = resolvedReach.serves_at_customer_place === true;
  const canServeAtVendor = resolvedReach.serves_at_vendor_place === true;
  const needsHelpWhereChoice = isHelpMode && canServeAtCustomer && canServeAtVendor;

  useEffect(() => {
    if (!isOpen || !isHelpMode) return;
    if (canServeAtCustomer && !canServeAtVendor) {
      setHelpLocation("home");
    } else if (!canServeAtCustomer && canServeAtVendor) {
      setHelpLocation("shop");
    } else if (needsHelpWhereChoice) {
      setHelpLocation(null);
    }
  }, [isOpen, isHelpMode, canServeAtCustomer, canServeAtVendor, needsHelpWhereChoice]);

  useEffect(() => {
    if (!isOpen || effectiveVendor?.is_active !== false) return;
    if (deliverySlot === "asap") setDeliverySlot("tomorrow");
    if (appointmentTiming === "instant") setAppointmentTiming("scheduled");
  }, [isOpen, effectiveVendor?.is_active, deliverySlot, appointmentTiming]);

  useEffect(() => {
    if (!isOpen) return;
    if (appointmentLocation === "home" && !canServeAtCustomer) {
      setAppointmentLocation(canServeAtVendor ? "shop" : "decide");
    } else if (appointmentLocation === "shop" && !canServeAtVendor) {
      setAppointmentLocation(canServeAtCustomer ? "home" : "decide");
    }
  }, [isOpen, canServeAtCustomer, canServeAtVendor, appointmentLocation]);

  useEffect(() => {
    if (!isOpen || !isDeliveryMode) return;
    if (deliverySlot === "asap" && !canServeAtCustomer) {
      setDeliverySlot("tomorrow");
    }
  }, [isOpen, isDeliveryMode, deliverySlot, canServeAtCustomer]);

  useEffect(() => {
    if (!showRecurrence && recurrenceKind !== "one_time") {
      setRecurrenceKind("one_time");
    }
  }, [showRecurrence, recurrenceKind]);

  useEffect(() => {
    if (!isOpen || !resolvedVendorId) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("vendor_menu_items")
        .select("id, name, description, price, unit, is_available, category_id, image_url")
        .eq("vendor_id", resolvedVendorId)
        .eq("is_available", true)
        .order("name", { ascending: true });
      if (cancelled) return;
      if (error || !data?.length) {
        if (error) {
          captureError(error, { scope: "parchiSheet.loadMenuItems", vendorId: resolvedVendorId });
        }
        setMenuItems([]);
        return;
      }
      setMenuItems(
        filterMenuItemsByCategoryContext(data as VendorMenuItem[], orderCategoryId),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, resolvedVendorId, orderCategoryId]);

  useEffect(() => {
    if (!isOpen) return;
    setMenuExpanded(message.trim().length === 0);
  }, [isOpen, message]);

  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => {
      const el = scrollContainerRef.current;
      if (!el) return;
      el.scrollTop = 0;
    });
  }, [isOpen, menuItems]);

  useEffect(() => {
    if (!isOpen || !effectiveVendor) return;
    const needsSilentCapture =
      resolvedServiceMode === "delivery" ||
      (resolvedServiceMode === "appointment" && appointmentLocation === "home");
    if (!needsSilentCapture || !navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCustomerLat(pos.coords.latitude);
        setCustomerLng(pos.coords.longitude);
      },
      () => {
        /* silent — delivery_address text remains fallback */
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60_000 },
    );
  }, [isOpen, resolvedServiceMode, appointmentLocation]);

  useEffect(() => {
    if (
      resolvedServiceMode === "appointment" &&
      appointmentLocation !== "home" &&
      !shareLocationEnabled
    ) {
      setCustomerLat(null);
      setCustomerLng(null);
    }
  }, [appointmentLocation, resolvedServiceMode, shareLocationEnabled]);

  const handleShareLocationToggle = useCallback(async (enabled: boolean) => {
    setShareLocationEnabled(enabled);
    if (!enabled) {
      setCustomerLat(null);
      setCustomerLng(null);
      setLocationPermissionBlocked(false);
      setLocationCaptured(false);
      return;
    }

    setLocationPermissionBlocked(false);
    setLocationCaptured(false);

    if (!navigator.geolocation) return;

    try {
      const perm = await navigator.permissions.query({ name: "geolocation" });
      if (perm.state === "denied") {
        setLocationPermissionBlocked(true);
        return;
      }
    } catch {
      /* permissions API unavailable — fall through to getCurrentPosition */
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCustomerLat(pos.coords.latitude);
        setCustomerLng(pos.coords.longitude);
        setLocationCaptured(true);
        setLocationPermissionBlocked(false);
      },
      () => {
        setShareLocationEnabled(false);
        setCustomerLat(null);
        setCustomerLng(null);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }, []);

  const buildMenuMessage = () => {
    return Object.entries(selectedMenuItems)
      .filter(([, qty]) => qty > 0)
      .map(([id, qty]) => {
        const item = menuItems.find((m) => m.id === id);
        if (!item) return null;
        return `${qty}x ${menuItemLabel(item)} ₹${item.price}`;
      })
      .filter(Boolean)
      .join("\n");
  };

  const addMenuToOrder = () => {
    const result = buildMenuMessage();
    if (!result) return;
    setMessage((prev) => (prev.trim() ? `${prev.trim()}\n${result}` : result));
    setMenuExpanded(false);
  };

  const selectedMenuCount = Object.values(selectedMenuItems).filter((q) => q > 0).length;

  useEffect(() => {
    if (!isOpen) return;
    const mode = resolvedServiceMode;
    const loadForAddress =
      mode === "delivery" || (mode === "appointment" && appointmentLocation === "home");
    if (!loadForAddress || addressLoading) return;
    const defaultAddr = addresses.find((a) => a.is_default);
    setSelectedAddressId(defaultAddr?.id ?? null);
  }, [isOpen, resolvedServiceMode, resolvedVendorId, appointmentLocation, addresses, addressLoading]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        // Radix may dismiss the parchi sheet when the nested phone sheet opens — keep form state.
        if (phoneSheetOpenRef.current) return;
        const vendorIdForIdem = effectiveVendor?.id ?? resolvedVendorId;
        if (vendorIdForIdem) clearOrderPlacementIdempotencyKey(vendorIdForIdem);
        resetFormFields();
        setSaveAddress(false);
        setTrustBlock(null);
        setPaymentBlockInfo(null);
        setLowTrustSheetOpen(false);
        setLowTrustConfirmed(false);
        setMediumTrustDialogOpen(false);
        setMenuItems([]);
        onClose();
      }
    },
    [onClose, resetFormFields, effectiveVendor?.id, resolvedVendorId],
  );

  const applyPaymentBlockRow = useCallback(
    (
      row:
        | {
            is_blocked?: boolean | null;
            vendor_name?: string | null;
            amount?: number | null;
            request_id?: string | null;
          }
        | undefined
        | null,
    ) => {
      if (
        row?.is_blocked &&
        row.vendor_name &&
        row.amount != null &&
        row.request_id
      ) {
        setTrustBlock("payment_block");
        setPaymentBlockInfo({
          vendorName: row.vendor_name,
          amount: row.amount,
          requestId: row.request_id,
        });
        return true;
      }
      setPaymentBlockInfo(null);
      setTrustBlock((prev) => (prev === "payment_block" ? null : prev));
      return false;
    },
    [],
  );

  const fetchPaymentBlockStatus = useCallback(
    async (phone: string | null, deviceId: string) => {
      try {
        const { data, error } = await supabase.rpc("get_customer_payment_block_status", {
          p_user_phone: phone,
          p_device_id: deviceId,
        });
        if (error) {
          captureError(error, { scope: "parchiSheet.paymentBlockStatus" });
          return false;
        }
        return applyPaymentBlockRow(data?.[0] ?? null);
      } catch (err) {
        captureError(err, { scope: "parchiSheet.paymentBlockStatus" });
        return false;
      }
    },
    [applyPaymentBlockRow],
  );

  useEffect(() => {
    if (!isOpen) return;
    const phone = getUserPhone();
    const deviceId = getDeviceId();
    void fetchPaymentBlockStatus(phone ?? null, deviceId);
  }, [isOpen, fetchPaymentBlockStatus]);

  const startVoiceInput = async () => {
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) {
        toast.error(s.home_voice_unavailable);
        return;
      }
      const micOk = await ensureVoiceMicrophone();
      if (!micOk) {
        toast.error(s.voice_permissionDenied);
        return;
      }
      setIsListening(true);
      const result = await SpeechRecognition.start({
        language: getVoiceLang(),
        maxResults: 1,
        popup: false,
        partialResults: false,
      });
      const text = result?.matches?.[0]?.trim();
      if (text) {
        setMessage((prev) => (prev ? `${prev} ${text}` : text));
      }
    } catch (e) {
      console.error("Voice error:", e);
    } finally {
      setIsListening(false);
    }
  };

  const startImageInput = async () => {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        setIsProcessingImage(true);
        try {
          const base64 = await new Promise<string>((res, rej) => {
            const reader = new FileReader();
            reader.onload = () => res((reader.result as string).split(",")[1]);
            reader.onerror = rej;
            reader.readAsDataURL(file);
          });
          const data = await fetchParseImageJson("parse-image-order", {
            image_base64: base64,
            media_type: file.type,
          });
          const parsedText = typeof data.text === "string" ? data.text : "";
          if (data.success && parsedText) {
            setMessage((prev) => (prev ? `${prev}\n${parsedText}` : parsedText));
            toast.success(s.image_parsed);
          } else {
            toast.error(s.image_failed);
          }
        } catch {
          toast.error(s.image_failed);
        } finally {
          setIsProcessingImage(false);
        }
      };
      input.click();
    } catch {
      toast.error(s.image_failed);
    } finally {
      setIsProcessingImage(false);
    }
  };

  const runOrderInsert = useCallback(
    async (phone: string) => {
      const v = effectiveVendor;
      if (!v) return;

      // Re-enter via `place` on network retry so refs/form match prior behavior.
      // Acquire sendingLockRef around retry so a second tap cannot race it.
      const place = async (): Promise<void> => {
        await executeOrderInsertCore(
          {
            phone,
            vendor: v,
            message,
            resolvedServiceMode,
            isHelpMode,
            isDeliveryMode,
            isAppointmentMode,
            showRecurrence,
            appointmentLocation,
            helpLocation,
            appointmentTiming,
            appointmentDate,
            appointmentTime,
            deliverySlot,
            recurrenceKind,
            recurrenceCustomDays,
            selectedAddressId,
            addresses,
            newAddress,
            saveAddress,
            customerLat,
            customerLng,
            canServeAtCustomer,
            canServeAtVendor,
            selectedMenuItems: selectedMenuItemsRef.current,
            menuItems: menuItemsRef.current,
            minDeliveryOrderAmount,
            orderCategoryId,
            maxOrderMessageChars: config.maxOrderMessageChars,
            s,
          },
          {
            setSending,
            setOfflineApptError,
            setTrustBlock,
            setMessage,
            setSelectedMenuItems,
            setPendingPhone,
            onOrderSent,
            onClose,
            fetchPaymentBlockStatus,
            scheduleNetworkRetry: () => {
              void (async () => {
                if (sendingLockRef.current) return;
                sendingLockRef.current = true;
                try {
                  await place();
                } finally {
                  sendingLockRef.current = false;
                }
              })();
            },
          },
        );
      };
      await place();
    },
    [
      effectiveVendor,
      message,
      onClose,
      onOrderSent,
      selectedAddressId,
      addresses,
      newAddress,
      saveAddress,
      customerLat,
      customerLng,
      appointmentDate,
      appointmentTime,
      appointmentLocation,
      appointmentTiming,
      canServeAtCustomer,
      canServeAtVendor,
      isHelpMode,
      helpLocation,
      deliverySlot,
      resolvedServiceMode,
      isAppointmentMode,
      isDeliveryMode,
      showRecurrence,
      recurrenceKind,
      recurrenceCustomDays,
      selectedMenuItems,
      menuItems,
      minDeliveryOrderAmount,
      orderCategoryId,
      config.maxOrderMessageChars,
      s,
      fetchPaymentBlockStatus,
    ],
  );

  const executeOrderInsert = useCallback(
    async (phone: string) => {
      if (sendingLockRef.current) return;
      sendingLockRef.current = true;
      try {
        await runOrderInsert(phone);
      } finally {
        sendingLockRef.current = false;
      }
    },
    [runOrderInsert],
  );

  const send = useCallback(
    async (overridePhone?: string) => {
      if (sendingLockRef.current) return;
      const v = effectiveVendor;
      if (!v) return;
      const text = message.trim();
      if (!text) {
        toast.error(s.parchi_errNoOrder);
        return;
      }
      if (isDeliveryMode) {
        const min = formatMinDeliveryOrderAmount(
          minDeliveryOrderAmount ?? effectiveVendor.min_delivery_order_amount,
        );
        const subtotal = deliveryCartSubtotal(selectedMenuItems, menuItems);
        if (!meetsMinDeliveryOrder(subtotal, min)) {
          toast.error(
            s.parchi_min_delivery_need
              .replace("{min}", String(min ?? 0))
              .replace("{short}", String(Math.max(0, Math.ceil((min ?? 0) - subtotal)))),
          );
          return;
        }
      }
      const needsAddress =
        resolvedServiceMode === "delivery" ||
        (resolvedServiceMode === "appointment" && appointmentLocation === "home");
      const finalAddress = needsAddress
        ? selectedAddressId
          ? (addresses.find((a) => a.id === selectedAddressId)?.address_text ?? "")
          : newAddress.trim()
        : null;

      if (needsAddress && !finalAddress) {
        toast.error(s.parchi_errNoAddress);
        return;
      }
      if (isHelpMode && needsHelpWhereChoice && !helpLocation) {
        toast.error(s.parchi_errHelpWhereRequired);
        return;
      }
      if (isAppointmentMode) {
        const isInstant =
          appointmentTiming === "instant" && effectiveVendor?.is_active === true;
        if (!isInstant && (!appointmentDate || !appointmentTime)) {
          toast.error(s.parchi_errNoDateTime);
          return;
        }
        if (
          !isInstant &&
          effectiveVendor?.is_active === false &&
          appointmentDate &&
          appointmentTime &&
          new Date(`${appointmentDate}T${appointmentTime}:00`).getTime() - Date.now() <
            DELIVERY_ASAP_OFFSET_MS
        ) {
          setOfflineApptError(true);
          return;
        }
      }
      setOfflineApptError(false);
      if (overridePhone == null && !isPhoneKnown()) {
        phoneSheetOpenRef.current = true;
        setPhoneSheetOpen(true);
        return;
      }
      const phone = overridePhone ?? getUserPhone()!;

      sendingLockRef.current = true;
      setSending(true);
      try {
        const paymentBlocked = await fetchPaymentBlockStatus(phone, getDeviceId());
        if (paymentBlocked) {
          setSending(false);
          return;
        }

        let trust: Awaited<ReturnType<typeof fetchUserTrust>> = null;
        try {
          trust = await withNetworkRetry(() => fetchUserTrust(phone), {
            maxAttempts: 2,
            baseDelayMs: 500,
            shouldRetry: () => getNavigatorOnline(),
          });
        } catch (err) {
          captureError(err, { scope: "parchiSheet.fetchUserTrust" });
          toast.warning(s.parchi_trust_fetch_failed);
          // Fail-open after retry: allow continue without trust gates.
          trust = null;
        }

        if (trust?.is_banned) {
          setSending(false);
          setTrustBlock("banned");
          return;
        }

        const score = trust?.trust_score;
        if (score != null && score >= 1 && score <= 24) {
          setSending(false);
          setTrustBlock("suspended");
          return;
        }

        if (score != null && score >= 25 && score <= 49) {
          setSending(false);
          if (resolvedServiceMode === "help") {
            toast.error(s.parchi_errHelpUnavailableTrust);
            onClose();
            return;
          }
          setPendingPhone(phone);
          setLowTrustConfirmed(false);
          setLowTrustSheetOpen(true);
          return;
        }

        if (score != null && score >= 50 && score <= 74) {
          setSending(false);
          setPendingPhone(phone);
          setMediumTrustDialogOpen(true);
          return;
        }

        // Keep sending=true through the insert gap; runOrderInsert finally clears it.
        // Lock already held — do not re-enter executeOrderInsert.
        await runOrderInsert(phone);
      } finally {
        sendingLockRef.current = false;
      }
    },
    [
      effectiveVendor,
      message,
      onClose,
      isHelpMode,
      needsHelpWhereChoice,
      helpLocation,
      runOrderInsert,
      selectedAddressId,
      addresses,
      newAddress,
      appointmentDate,
      appointmentTime,
      appointmentLocation,
      appointmentTiming,
      isAppointmentMode,
      resolvedServiceMode,
      isDeliveryMode,
      selectedMenuItems,
      menuItems,
      minDeliveryOrderAmount,
      s,
      fetchPaymentBlockStatus,
    ],
  );

  const confirmLowTrustOrder = () => {
    if (!lowTrustConfirmed || !pendingPhone) return;
    setLowTrustSheetOpen(false);
    setLowTrustConfirmed(false);
    void executeOrderInsert(pendingPhone);
  };

  const confirmMediumTrustOrder = () => {
    setMediumTrustDialogOpen(false);
    if (pendingPhone) void executeOrderInsert(pendingPhone);
  };

  const showPaymentSection =
    order?.status === "fulfilled" && order?.payment_status != null;

  if (!effectiveVendor) return null;

  const online = effectiveVendor.is_active === true;
  const len = message.length;
  const displayVendorNote = resolveCategoryVendorNote(
    categoryVendorNote,
    effectiveVendor.vendor_note,
    orderCategoryId,
  );
  const displayInspectionFee =
    inspectionFee ?? formatVisitFeeAmount(effectiveVendor.inspection_fee);
  const displayMinDelivery =
    isDeliveryMode
      ? formatMinDeliveryOrderAmount(
          minDeliveryOrderAmount ?? effectiveVendor.min_delivery_order_amount,
        )
      : null;
  const cartSubtotal = deliveryCartSubtotal(selectedMenuItems, menuItems);
  const deliveryBelowMin = !meetsMinDeliveryOrder(cartSubtotal, displayMinDelivery);

  const getAvailableSlots = () => {
    const now = new Date();
    const hour = getIstHour(now);

    const all = [
      { value: "asap", label: s.parchi_slotAsapEmoji, alwaysShow: true },
      {
        value: "morning",
        label: s.parchi_slotMorningEmoji,
        cutoffHour: DELIVERY_SLOT_CUTOFF_HOUR.morning,
      },
      {
        value: "afternoon",
        label: s.parchi_slotAfternoonEmoji,
        cutoffHour: DELIVERY_SLOT_CUTOFF_HOUR.afternoon,
      },
      {
        value: "evening",
        label: s.parchi_slotEveningEmoji,
        cutoffHour: DELIVERY_SLOT_CUTOFF_HOUR.evening,
      },
      { value: "tomorrow", label: s.parchi_slotTomorrowEmoji, alwaysShow: true },
    ];

    return all.filter(
      (slot) =>
        (slot.alwaysShow || (slot.cutoffHour !== undefined && hour < slot.cutoffHour)) &&
        (slot.value !== "asap" || (online && canServeAtCustomer)),
    );
  };

  return (
    <>
      <Sheet open={isOpen} onOpenChange={handleOpenChange}>
        <SheetContent
          data-testid="parchi-sheet"
          side="bottom"
          className="bg-page-bg border-t border-surface-raised text-white rounded-t-2xl h-[90vh] max-h-[90vh] flex flex-col overflow-hidden p-0 gap-0 [&>button]:text-gray-400"
          style={{
            WebkitOverflowScrolling: "touch",
          }}
        >
          <div
            ref={scrollContainerRef}
            data-testid="parchi-scroll-container"
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain will-change-scroll pb-52"
          >
          <SheetHeader className="sr-only">
            <SheetTitle>
              {resolvedServiceMode === "appointment"
                ? `${s.parchi_titleBook}${effectiveVendor?.shop_name ?? ""}`
                : `${s.parchi_titleOrder}${effectiveVendor?.shop_name ?? ""}`}
            </SheetTitle>
            <SheetDescription>{s.parchi_orderLabel}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pt-4 pb-3 border-b border-surface-border">
            <div className="flex items-center justify-between gap-2 pr-8">
              <h2 className="text-lg font-bold text-foreground truncate">
                {effectiveVendor?.shop_name}
              </h2>
              <span className="text-xs px-2 py-1 rounded-full bg-brand/20 text-brand font-medium shrink-0">
                {resolvedServiceMode === "delivery"
                  ? "🚚 Delivery"
                  : resolvedServiceMode === "appointment"
                    ? "📅 Booking"
                    : "🚶 Help"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              {resolvedServiceMode === "appointment" ? (
                online ? (
                  <>{s.parchi_onlineBooking}</>
                ) : (
                  <>{s.parchi_offlineBooking}</>
                )
              ) : online ? (
                <>{s.parchi_onlineOrder}</>
              ) : (
                <>{s.parchi_offlineOrder}</>
              )}
            </p>
            {displayVendorNote && (
              <p className="text-xs text-muted-foreground mt-1">
                {s.parchi_vendorNotePrefix}
                {displayVendorNote}
              </p>
            )}
            <TrustWarningBanner
              tier={vendorBinaryTrustTier({
                ...effectiveVendor,
                businessGpsVerified: businessGpsVerified ?? undefined,
              })}
              context="parchi"
            />
          </div>

          <div className="mt-5 space-y-3 px-4">
            {effectiveVendor.is_active === false && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 leading-relaxed">
                {s.parchi_offline_banner}
              </div>
            )}
            {trustBlock === "banned" && (
              <div className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-6 text-sm text-center text-foreground leading-relaxed">
                🚫 {s.customer_account_banned}
              </div>
            )}
            {trustBlock === "suspended" && (
              <div className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-6 text-sm text-center text-foreground leading-relaxed">
                ⛔ {s.customer_orders_suspended}
              </div>
            )}
            {trustBlock === "payment_block" && paymentBlockInfo && (
              <div
                data-testid="parchi-payment-block"
                className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-6 text-sm text-center text-foreground leading-relaxed space-y-3"
              >
                <p>{s.parchi_payment_block_body(paymentBlockInfo.vendorName, paymentBlockInfo.amount)}</p>
                <button
                  type="button"
                  data-testid="parchi-payment-block-my-orders-link"
                  onClick={() => navigate("/my-orders")}
                  className="text-brand font-semibold underline underline-offset-2"
                >
                  {s.parchi_payment_block_my_orders}
                </button>
              </div>
            )}
            {!trustBlock && (
            <>
            {(resolvedServiceMode === "delivery" ||
              (resolvedServiceMode === "appointment" && appointmentLocation === "home")) && (
              <div className="space-y-2">
                <p className="text-xs text-gray-400 flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> {s.parchi_deliveryAddress}
                </p>

                {addressLoading && (
                  <p className="text-xs text-gray-500">{s.parchi_loadingAddresses}</p>
                )}

                {!addressLoading && addresses.length > 0 && (
                  <div className="space-y-1.5">
                    {addresses.map((addr) => (
                      <button
                        key={addr.id}
                        type="button"
                        onClick={() => setSelectedAddressId(addr.id)}
                        className={`w-full text-left rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                          selectedAddressId === addr.id
                            ? "border-brand bg-brand-muted text-white"
                            : "border-surface-border bg-surface text-gray-300"
                        }`}
                      >
                        {addr.address_text}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setSelectedAddressId(null)}
                      className={`w-full text-left rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                        selectedAddressId === null
                          ? "border-brand bg-brand-muted text-white"
                          : "border-surface-border bg-surface text-gray-400"
                      }`}
                    >
                      {s.parchi_useDifferentAddress}
                    </button>
                  </div>
                )}

                {!addressLoading && selectedAddressId === null && (
                  <div className="space-y-2">
                    <input
                      type="text"
                      data-testid="parchi-address-input"
                      value={newAddress}
                      onChange={(e) =>
                        setNewAddress(e.target.value.slice(0, MAX_ADDRESS_TEXT_CHARS))
                      }
                      maxLength={MAX_ADDRESS_TEXT_CHARS}
                      placeholder={s.parchi_addressPlaceholder}
                      className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-brand/50"
                    />
                    <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={saveAddress}
                        onChange={(e) => setSaveAddress(e.target.checked)}
                        className="accent-brand"
                      />
                      {s.parchi_saveAddress}
                    </label>
                  </div>
                )}
              </div>
            )}

            {isAppointmentMode && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">{s.parchi_whereQuestion}</p>
                  <div className="grid grid-cols-3 gap-2">
                    {canServeAtCustomer && (
                    <button
                      type="button"
                      onClick={() => setAppointmentLocation("home")}
                      className={`rounded-xl border py-3 px-2 text-xs font-semibold transition-colors ${
                        appointmentLocation === "home"
                          ? "border-blue-500 bg-blue-500/10 text-blue-400"
                          : "border-surface-border bg-surface text-gray-400"
                      }`}
                    >
                      {s.parchi_locationComeToMeBtn}
                    </button>
                    )}
                    {canServeAtVendor && (
                    <button
                      type="button"
                      onClick={() => setAppointmentLocation("shop")}
                      className={`rounded-xl border py-3 px-2 text-xs font-semibold transition-colors ${
                        appointmentLocation === "shop"
                          ? "border-purple-500 bg-purple-500/10 text-purple-400"
                          : "border-surface-border bg-surface text-gray-400"
                      }`}
                    >
                      {s.parchi_locationVisitBtn}
                    </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setAppointmentLocation("decide")}
                      className={`rounded-xl border py-3 px-2 text-xs font-semibold transition-colors ${
                        appointmentLocation === "decide"
                          ? "border-gray-500 bg-gray-500/10 text-gray-300"
                          : "border-surface-border bg-surface text-gray-400"
                      }`}
                    >
                      {s.parchi_locationDecideLater}
                    </button>
                  </div>
                </div>
                <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">
                  {s.parchi_whenAppt}
                </p>
                <div className="grid grid-cols-1 gap-2">
                  {online && (
                    <button
                      type="button"
                      onClick={() => {
                        setAppointmentTiming("instant");
                        setOfflineApptError(false);
                      }}
                      className={`rounded-xl border py-2.5 px-3 text-sm font-semibold text-left transition-colors ${
                        appointmentTiming === "instant"
                          ? "border-brand bg-brand/15 text-brand"
                          : "border-surface-border bg-surface text-gray-400"
                      }`}
                    >
                      {s.parchi_appointmentInstantEmoji}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setAppointmentTiming("scheduled");
                      setOfflineApptError(false);
                    }}
                    className={`rounded-xl border py-2.5 px-3 text-sm font-semibold text-left transition-colors ${
                      appointmentTiming === "scheduled"
                        ? "border-brand bg-brand/15 text-brand"
                        : "border-surface-border bg-surface text-gray-400"
                    }`}
                  >
                    {s.parchi_appointmentScheduled}
                  </button>
                </div>
                {appointmentTiming === "scheduled" && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-xs text-gray-500">{s.parchi_dateLabel}</label>
                      <input
                        type="date"
                        value={appointmentDate}
                        min={new Date().toISOString().split("T")[0]}
                        onChange={(e) => {
                          setAppointmentDate(e.target.value);
                          setOfflineApptError(false);
                        }}
                        className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand/50"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-gray-500">{s.parchi_timeLabel}</label>
                      <input
                        type="time"
                        value={appointmentTime}
                        onChange={(e) => {
                          setAppointmentTime(e.target.value);
                          setOfflineApptError(false);
                        }}
                        className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand/50"
                      />
                    </div>
                  </div>
                )}
                {offlineApptError && (
                  <p className="text-xs text-amber-600 leading-snug">
                    {s.parchi_offline_appt_too_soon}
                  </p>
                )}
              </div>
            )}

            {isDeliveryMode && (
              <div className="space-y-2">
                <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">
                  {s.parchi_whenDelivery}
                </p>
                <select
                  data-testid="parchi-slot-select"
                  value={deliverySlot}
                  onChange={(e) => setDeliverySlot(e.target.value)}
                  className="w-full rounded-xl border border-surface-border bg-surface text-foreground px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/50"
                >
                  {getAvailableSlots().map((slot) => (
                    <option key={slot.value} value={slot.value}>
                      {slot.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {showRecurrence && (
              <div className="space-y-2" data-testid="parchi-recurrence">
                <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">
                  {s.parchi_recurrenceLabel}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["one_time", s.parchi_recurrence_one_time],
                      ["daily", s.parchi_recurrence_daily],
                      ["weekly", s.parchi_recurrence_weekly],
                      ["custom", s.parchi_recurrence_custom],
                    ] as const
                  ).map(([kind, label]) => (
                    <button
                      key={kind}
                      type="button"
                      data-testid={`parchi-recurrence-${kind}`}
                      onClick={() => setRecurrenceKind(kind)}
                      className={`rounded-xl border py-3 px-2 text-xs font-semibold transition-colors ${
                        recurrenceKind === kind
                          ? "border-brand bg-brand/15 text-brand"
                          : "border-surface-border bg-surface text-gray-400"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {recurrenceKind === "custom" && (
                  <label className="block space-y-1">
                    <span className="text-xs text-gray-500">{s.parchi_recurrence_custom_days}</span>
                    <input
                      type="number"
                      min={2}
                      max={30}
                      data-testid="parchi-recurrence-custom-days"
                      value={recurrenceCustomDays}
                      onChange={(e) => setRecurrenceCustomDays(e.target.value.replace(/[^\d]/g, "").slice(0, 2))}
                      className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand/50"
                    />
                  </label>
                )}
                {recurrenceKind !== "one_time" && (
                  <p className="text-xs text-muted-foreground leading-snug">
                    {s.parchi_recurrence_hint}
                  </p>
                )}
              </div>
            )}

            {menuItems.length > 0 && (
              <div className="border border-surface-border rounded-2xl overflow-hidden">
                <button
                  type="button"
                  onClick={() => setMenuExpanded((v) => !v)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-surface text-left active:opacity-90"
                >
                  <span className="text-sm font-semibold text-foreground">
                    📋 Menu ({menuItems.length} items)
                  </span>
                  <ChevronDown
                    className={cn(
                      "w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200",
                      menuExpanded && "rotate-180",
                    )}
                  />
                </button>
                {menuExpanded && (
                  <div
                    data-testid="parchi-menu-items-panel"
                    className="flex flex-col min-h-0 max-h-[min(42vh,20rem)]"
                  >
                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 space-y-1.5">
                    {menuItems.map((item) => {
                      const qty = selectedMenuItems[item.id] ?? 0;
                      const selected = qty > 0;
                      const label = menuItemLabel(item);
                      if (isDeliveryMode) {
                        return (
                          <div
                            key={item.id}
                            className={cn(
                              "flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 transition-colors",
                              selected
                                ? "border-brand bg-brand/10"
                                : "border-surface-border bg-surface/50",
                            )}
                          >
                            {item.image_url ? (
                              <img
                                src={item.image_url}
                                alt=""
                                className="h-10 w-10 rounded-lg object-cover shrink-0 border border-surface-border"
                              />
                            ) : null}
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-white break-words">
                                {label}
                              </p>
                              <p className="text-xs text-gray-400">₹{item.price}</p>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() =>
                                  setSelectedMenuItems((prev) => {
                                    const next = Math.max(0, (prev[item.id] ?? 0) - 1);
                                    if (next === 0) {
                                      const copy = { ...prev };
                                      delete copy[item.id];
                                      return copy;
                                    }
                                    return { ...prev, [item.id]: next };
                                  })
                                }
                                className="h-8 w-8 rounded-lg border border-surface-border text-gray-300 font-bold disabled:opacity-40"
                                aria-label={`Decrease ${label}`}
                              >
                                −
                              </button>
                              <span className="w-6 text-center text-sm font-semibold tabular-nums text-white">
                                {qty}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setSelectedMenuItems((prev) => ({
                                    ...prev,
                                    [item.id]: Math.min(99, (prev[item.id] ?? 0) + 1),
                                  }))
                                }
                                disabled={qty >= 99}
                                className="h-8 w-8 rounded-lg border border-surface-border text-gray-300 font-bold disabled:opacity-40"
                                aria-label={`Increase ${label}`}
                              >
                                +
                              </button>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() =>
                            setSelectedMenuItems((prev) => {
                              if ((prev[item.id] ?? 0) > 0) {
                                const copy = { ...prev };
                                delete copy[item.id];
                                return copy;
                              }
                              return { ...prev, [item.id]: 1 };
                            })
                          }
                          className={cn(
                            "w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                            selected
                              ? "border-brand bg-brand/10"
                              : "border-surface-border bg-surface/50",
                          )}
                        >
                          <input
                            type="checkbox"
                            readOnly
                            checked={selected}
                            className="accent-brand shrink-0 pointer-events-none"
                            tabIndex={-1}
                            aria-hidden
                          />
                          {item.image_url ? (
                            <img
                              src={item.image_url}
                              alt=""
                              className="h-10 w-10 rounded-lg object-cover shrink-0 border border-surface-border"
                            />
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-white break-words">
                              {label}
                            </p>
                            <p className="text-xs text-gray-400">₹{item.price}</p>
                          </div>
                        </button>
                      );
                    })}
                    </div>
                    <div
                      className={cn(
                        "shrink-0 border-t border-surface-border bg-surface px-2 py-2 transition-all duration-150",
                        selectedMenuCount > 0
                          ? "opacity-100 max-h-24"
                          : "opacity-0 pointer-events-none max-h-0 overflow-hidden py-0 border-0",
                      )}
                    >
                      <button
                        type="button"
                        onClick={addMenuToOrder}
                        className="w-full rounded-xl bg-brand/20 border border-brand text-brand h-10 text-sm font-semibold active:scale-[0.98]"
                      >
                        Add to order
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div>
              <label
                htmlFor="parchi-message"
                className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block"
              >
                {resolvedServiceMode === "appointment"
                  ? s.parchi_whenAppt
                  : s.parchi_orderLabel}
              </label>
            <div className="relative">
              <textarea
                id="parchi-message"
                data-testid="parchi-message-input"
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, config.maxOrderMessageChars))}
                rows={5}
                placeholder={
                  resolvedServiceMode === "appointment"
                    ? s.parchi_placeholderAppt
                    : s.parchi_placeholderOrder
                }
                className="w-full bg-surface border border-surface-border rounded-xl px-3 py-3 pr-20 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:border-brand"
              />
              <button
                type="button"
                onClick={() => void startImageInput()}
                disabled={isProcessingImage}
                className="absolute bottom-3 right-10 p-1.5 rounded-full bg-surface-raised text-gray-400 hover:text-brand transition-colors disabled:opacity-50"
                aria-label={isProcessingImage ? s.image_processing : s.image_parsed}
              >
                {isProcessingImage ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4" />
                )}
              </button>
              {Capacitor.isNativePlatform() && (
                <button
                  type="button"
                  onClick={() => void startVoiceInput()}
                  className={`absolute bottom-3 right-3 p-1.5 rounded-full transition-colors ${
                    isListening
                      ? "bg-danger text-white animate-pulse"
                      : "bg-surface-raised text-gray-400 hover:text-brand"
                  }`}
                  aria-label={isListening ? s.voice_listening : s.voice_prompt}
                >
                  <Mic className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="flex justify-end text-xs text-muted-foreground tabular-nums mt-1">
              {len}{s.parchi_charSeparator}{config.maxOrderMessageChars}
            </div>

            {resolvedServiceMode === "help" && needsHelpWhereChoice && (
              <div className="space-y-2 mt-3">
                <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">
                  {s.parchi_whereQuestion}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    data-testid="parchi-help-come-to-me"
                    onClick={() => setHelpLocation("home")}
                    className={`rounded-xl border py-3 px-2 text-xs font-semibold transition-colors ${
                      helpLocation === "home"
                        ? "border-blue-500 bg-blue-500/10 text-blue-400"
                        : "border-surface-border bg-surface text-gray-400"
                    }`}
                  >
                    {s.parchi_locationComeToMeBtn}
                  </button>
                  <button
                    type="button"
                    data-testid="parchi-help-visit-shop"
                    onClick={() => setHelpLocation("shop")}
                    className={`rounded-xl border py-3 px-2 text-xs font-semibold transition-colors ${
                      helpLocation === "shop"
                        ? "border-purple-500 bg-purple-500/10 text-purple-400"
                        : "border-surface-border bg-surface text-gray-400"
                    }`}
                  >
                    {s.parchi_locationVisitBtn}
                  </button>
                </div>
              </div>
            )}

            {resolvedServiceMode === "help" && (
              <div className="space-y-1.5 mt-3">
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={shareLocationEnabled}
                    onChange={(e) => void handleShareLocationToggle(e.target.checked)}
                    className="accent-brand h-4 w-4 shrink-0"
                  />
                  <span className="text-sm text-gray-300">{s.parchi_shareLocationToggle}</span>
                </label>
                {locationPermissionBlocked && (
                  <p className="text-xs text-amber-600 leading-snug">
                    {s.parchi_locationPermissionBlocked}
                  </p>
                )}
                {locationCaptured && shareLocationEnabled && !locationPermissionBlocked && (
                  <p className="text-xs text-green-500">{s.parchi_locationCaptured}</p>
                )}
              </div>
            )}
            </div>

            {showPaymentSection && order && (
              <div className="space-y-3 pt-1" data-testid="parchi-payment-section">
                <UpiPaymentPanel
                  idPrefix="parchi-payment"
                  orderId={order.id}
                  paymentStatus={order.payment_status}
                  amountRupees={order.amount / 100}
                  vendorId={effectiveVendor.id}
                  shopName={effectiveVendor.shop_name}
                  upiId={businessUpi?.upi_id ?? (orderCategoryId ? "" : effectiveVendor.upi_id)}
                  vendorPhone={effectiveVendor.phone}
                  qrUrl={
                    businessUpi
                      ? businessUpi.upi_qr_url
                      : orderCategoryId
                        ? null
                        : (effectiveVendor as VendorWithQr).upi_qr_url
                  }
                  qrPayeeId={
                    businessUpi
                      ? businessUpi.upi_qr_payee_id
                      : orderCategoryId
                        ? null
                        : (effectiveVendor as VendorWithQr).upi_qr_payee_id
                  }
                />
              </div>
            )}

            </>
            )}
          </div>
          </div>
          {!trustBlock && (
            <div className="shrink-0 border-t border-surface-border bg-page-bg px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-2">
              {displayInspectionFee != null && (
                <p
                  data-testid="parchi-inspection-fee"
                  className="text-sm font-semibold text-center text-foreground"
                >
                  {s.parchi_inspection_fee.replace("{amount}", String(displayInspectionFee))}
                </p>
              )}
              {displayMinDelivery != null && (
                <>
                  <p
                    data-testid="parchi-min-delivery-subtotal"
                    className="text-sm font-semibold text-center text-foreground"
                  >
                    {s.parchi_min_delivery_subtotal.replace("{amount}", String(Math.round(cartSubtotal)))}
                  </p>
                  {deliveryBelowMin && (
                    <p
                      data-testid="parchi-min-delivery-need"
                      className="text-xs text-center text-amber-400"
                    >
                      {s.parchi_min_delivery_need
                        .replace("{min}", String(displayMinDelivery))
                        .replace(
                          "{short}",
                          String(Math.max(0, Math.ceil(displayMinDelivery - cartSubtotal))),
                        )}
                    </p>
                  )}
                </>
              )}
              {resolvedServiceMode === "appointment" ? (
                <p className="text-xs text-muted-foreground text-center">
                  {s.parchi_cancellationAppt}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground text-center">
                  {s.parchi_cancellationOrder}
                </p>
              )}
              <button
                type="button"
                data-testid="parchi-submit-btn"
                disabled={sending || deliveryBelowMin}
                onClick={() => void send()}
                className="w-full h-12 bg-brand text-white font-bold rounded-2xl text-sm active:scale-[0.98] transition-transform disabled:opacity-60 disabled:pointer-events-none"
              >
                {sending
                  ? "..."
                  : resolvedServiceMode === "appointment"
                    ? s.parchi_btnConfirmBooking
                    : s.parchi_btnSendOrder}
              </button>
              <button
                type="button"
                disabled={sending}
                onClick={() => handleOpenChange(false)}
                className="w-full min-h-11 py-2 text-sm text-gray-500 hover:text-gray-400 transition-colors"
              >
                {s.parchi_btnCancel}
              </button>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <Sheet
        open={lowTrustSheetOpen}
        onOpenChange={(open) => {
          setLowTrustSheetOpen(open);
          if (!open) {
            setLowTrustConfirmed(false);
            setPendingPhone(null);
          }
        }}
      >
        <SheetContent
          side="bottom"
          className="bg-page-bg border-t border-surface-raised text-white rounded-t-2xl px-4"
        >
          <SheetHeader className="text-left">
            <SheetTitle className="text-white">{s.parchi_trust_low_title}</SheetTitle>
            <SheetDescription className="text-gray-400 text-left">
              {s.parchi_trust_low_body}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-5 space-y-4">
            <label className="flex items-start gap-3 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                data-testid="parchi-low-trust-checkbox"
                checked={lowTrustConfirmed}
                onChange={(e) => setLowTrustConfirmed(e.target.checked)}
                className="mt-1 accent-brand"
              />
              {s.parchi_trust_low_confirmCheckbox}
            </label>
            <button
              type="button"
              disabled={!lowTrustConfirmed || sending}
              data-testid="parchi-low-trust-confirm"
              onClick={confirmLowTrustOrder}
              className="w-full rounded-xl bg-brand text-page-bg h-12 font-semibold disabled:opacity-50"
            >
              {sending ? "..." : s.parchi_trust_low_confirmBtn}
            </button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={mediumTrustDialogOpen}
        onOpenChange={(open) => {
          setMediumTrustDialogOpen(open);
          if (!open) setPendingPhone(null);
        }}
      >
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{s.parchi_trust_medium_title}</AlertDialogTitle>
            <AlertDialogDescription className="text-left leading-relaxed">
              {s.parchi_trust_medium_body}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel className="mt-0">{s.parchi_btnCancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-brand text-page-bg hover:bg-brand/90"
              data-testid="parchi-medium-trust-confirm"
              onClick={confirmMediumTrustOrder}
            >
              {s.parchi_trust_medium_confirmBtn}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PhoneEntrySheet
        isOpen={phoneSheetOpen}
        context="order"
        skipRecovery
        onClose={() => {
          phoneSheetOpenRef.current = false;
          setPhoneSheetOpen(false);
        }}
        onConfirmed={async (phone) => {
          phoneSheetOpenRef.current = false;
          setPhoneSheetOpen(false);
          await migrateUserPhone(phone, getDeviceId());
          void send(phone);
        }}
      />
    </>
  );
}
