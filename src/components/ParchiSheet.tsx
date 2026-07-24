import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, ChevronDown, Loader2, MapPin, Mic } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { getVoiceLang } from "@/lib/voiceUtils";
import { captureError } from "@/lib/sentry";
import { UpiPaymentPanel } from "@/components/payment/UpiPaymentPanel";
import { TrustWarningBanner } from "@/components/TrustWarningBanner";
import { vendorBinaryTrustTier } from "@/lib/vendorBinaryTrust";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  supabase,
  upsertUser,
  incrementUserOrders,
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
import { filterMenuItemsByCategoryContext } from "@/lib/categoryScopedVendor";
import { PhoneEntrySheet } from "@/components/PhoneEntrySheet";
import { toast } from "sonner";
import { useLanguage } from "@/lib/language";
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
import { useAppConfig } from "@/hooks/useAppConfig";
import { useUserAddresses, type SavedAddress } from "@/hooks/useUserAddresses";
import { cn } from "@/lib/utils";

type VendorMenuItem = {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  unit?: string | null;
  is_available: boolean;
  category_id?: string | null;
};

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

const menuItemLabel = (item: VendorMenuItem) =>
  item.name?.trim() || item.description?.trim() || "Item";

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

function getDeliverySlotDeadline(slot: string | null): string | null {
  const now = new Date();

  if (slot === "asap") {
    return new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  }
  if (slot === "morning") {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    return d.toISOString();
  }
  if (slot === "afternoon") {
    const d = new Date(now);
    d.setHours(16, 0, 0, 0);
    return d.toISOString();
  }
  if (slot === "evening") {
    const d = new Date(now);
    d.setHours(20, 0, 0, 0);
    return d.toISOString();
  }
  if (slot === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(20, 0, 0, 0);
    return d.toISOString();
  }
  return null;
}

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
  const [phoneSheetOpen, setPhoneSheetOpen] = useState(false);
  const { addresses, loading: addressLoading } = useUserAddresses();
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [newAddress, setNewAddress] = useState("");
  const [saveAddress, setSaveAddress] = useState(false);
  const [appointmentDate, setAppointmentDate] = useState("");
  const [appointmentTime, setAppointmentTime] = useState("");
  const [appointmentLocation, setAppointmentLocation] = useState<"home" | "shop" | "decide">("decide");
  const [deliverySlot, setDeliverySlot] = useState<string>("asap");
  const [appointmentTiming, setAppointmentTiming] = useState<"instant" | "scheduled">(
    "scheduled",
  );
  const [offlineApptError, setOfflineApptError] = useState(false);
  const [trustBlock, setTrustBlock] = useState<"banned" | "suspended" | null>(null);
  const [lowTrustSheetOpen, setLowTrustSheetOpen] = useState(false);
  const [lowTrustConfirmed, setLowTrustConfirmed] = useState(false);
  const [mediumTrustDialogOpen, setMediumTrustDialogOpen] = useState(false);
  const [pendingPhone, setPendingPhone] = useState<string | null>(null);
  const [menuItems, setMenuItems] = useState<VendorMenuItem[]>([]);
  const [selectedMenuItems, setSelectedMenuItems] = useState<Record<string, number>>({});
  const [menuExpanded, setMenuExpanded] = useState(true);
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
    setDeliverySlot("asap");
    setAppointmentTiming("scheduled");
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
  const resolvedServiceMode =
    serviceModeProp ?? effectiveVendor?.service_mode ?? "help";
  const isDeliveryMode = resolvedServiceMode === "delivery";
  const isAppointmentMode = resolvedServiceMode === "appointment";
  const isHelpMode = resolvedServiceMode === "help";

  const resolvedReach = orderCategoryReach ?? {
    serves_at_vendor_place: effectiveVendor?.serves_at_vendor_place === true,
    serves_at_customer_place:
      effectiveVendor?.serves_at_customer_place === true ||
      (effectiveVendor?.serves_at_vendor_place !== true &&
        effectiveVendor?.serves_at_customer_place !== false),
  };
  const canServeAtCustomer = resolvedReach.serves_at_customer_place === true;
  const canServeAtVendor = resolvedReach.serves_at_vendor_place === true;

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
    if (!isOpen || !resolvedVendorId) return;
    setMenuExpanded(message.trim().length === 0);
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("vendor_menu_items")
        .select("id, name, description, price, unit, is_available, category_id")
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
  }, [isOpen, resolvedVendorId, message, orderCategoryId]);

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
    setSelectedMenuItems({});
  };

  const selectedMenuCount = Object.values(selectedMenuItems).filter((q) => q > 0).length;

  useEffect(() => {
    console.log("selectedMenuCount", selectedMenuCount);
  }, [selectedMenuCount]);

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
        resetFormFields();
        setSaveAddress(false);
        setTrustBlock(null);
        setLowTrustSheetOpen(false);
        setLowTrustConfirmed(false);
        setMediumTrustDialogOpen(false);
        setMenuItems([]);
        onClose();
      }
    },
    [onClose, resetFormFields],
  );

  const startVoiceInput = async () => {
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) {
        toast.error(s.home_voice_unavailable);
        return;
      }
      await SpeechRecognition.requestPermissions();
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
      input.capture = "environment";
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
          const resp = await fetch(`${SUPABASE_URL}/functions/v1/parse-image-order`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({
              image_base64: base64,
              media_type: file.type,
            }),
          });
          const data = await resp.json();
          if (data.success && data.text) {
            setMessage((prev) => (prev ? `${prev}\n${data.text}` : data.text));
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

  const executeOrderInsert = useCallback(
    async (phone: string) => {
      const v = effectiveVendor;
      if (!v) return;

      // Hold disabled from first entry through RPC completion so trust→insert
      // cannot double-submit (caller may already have set sending during trust).
      setSending(true);
      try {
      const text = message.trim();
      const needsAddress =
        resolvedServiceMode === "delivery" ||
        (resolvedServiceMode === "appointment" && appointmentLocation === "home");
      const finalAddress = needsAddress
        ? selectedAddressId
          ? (addresses.find((a) => a.id === selectedAddressId)?.address_text ?? "")
          : newAddress.trim()
        : null;
      const locationNote =
        resolvedServiceMode === "appointment"
          ? appointmentLocation === "home"
            ? s.parchi_locationComeToMe
            : appointmentLocation === "shop"
              ? s.parchi_locationVisitShop
              : s.parchi_locationTbd
          : "";
      const isInstantAppointment =
        isAppointmentMode && appointmentTiming === "instant" && v.is_active === true;
      const appointmentTimestamp = isInstantAppointment
        ? getDeliverySlotDeadline("asap")
        : isAppointmentMode && appointmentDate && appointmentTime
          ? new Date(`${appointmentDate}T${appointmentTime}:00`).toISOString()
          : null;
      const selectedSlot = isDeliveryMode ? deliverySlot : null;

      if (isDeliveryMode) {
        if (selectedSlot === "asap" && v.is_active !== true) {
          toast.error(s.parchi_errVendorNotLiveAsap);
          return;
        }
        const slotDeadline = getDeliverySlotDeadline(selectedSlot);
        if (slotDeadline != null && new Date(slotDeadline) < new Date()) {
          toast.error(s.parchi_slot_expired);
          return;
        }
      }

      if (isAppointmentMode) {
        if (!isInstantAppointment && appointmentTimestamp == null) {
          toast.error(s.parchi_errNoDateTime);
          return;
        }
        if (appointmentTimestamp != null && new Date(appointmentTimestamp) < new Date()) {
          toast.error(s.parchi_appointment_expired);
          return;
        }
        if (
          !isInstantAppointment &&
          v.is_active === false &&
          appointmentTimestamp != null &&
          new Date(appointmentTimestamp).getTime() - Date.now() < 2 * 60 * 60 * 1000
        ) {
          setOfflineApptError(true);
          return;
        }
      }

      const device_id = getDeviceId();
        const { error } = await withNetworkRetry(
          async () =>
            throwOnSupabaseNetworkError(
              await supabase.rpc("create_customer_request", {
                p_device_id: device_id,
                p_vendor_id: v.id,
                p_message: text.slice(0, config.maxOrderMessageChars) + locationNote,
                p_user_phone: phone,
                p_device_id_log: device_id,
                p_delivery_address: finalAddress,
                p_delivery_slot: selectedSlot,
                p_delivery_slot_deadline:
                  resolvedServiceMode === "delivery"
                    ? getDeliverySlotDeadline(selectedSlot)
                    : null,
                p_appointment_time: appointmentTimestamp,
                p_appointment_status: appointmentTimestamp ? "pending" : null,
                p_customer_latitude: customerLat ?? null,
                p_customer_longitude: customerLng ?? null,
                p_appointment_instant: isInstantAppointment,
                p_category_id: orderCategoryId ?? null,
                p_service_mode: resolvedServiceMode,
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
        if (error) {
          captureError(error, {
            scope: "parchiSheet.createCustomerRequest",
            vendorId: v.id,
            serviceMode: resolvedServiceMode,
          });
          const msg = error.message ?? "";
          if (msg.includes("vendor_not_live_for_asap") || msg.includes("vendor_not_live_for_instant")) {
            toast.error(s.parchi_errVendorNotLiveAsap);
          } else if (msg.includes("customer_banned")) {
            setTrustBlock("banned");
          } else if (msg.includes("vendor_banned") || msg.includes("vendor_not_discoverable")) {
            toast.error(s.parchi_errCouldNotSend, { description: error.message });
          } else {
            toast.error(s.parchi_errCouldNotSend, { description: error.message });
          }
          return;
        }
        void upsertUser(phone);
        void incrementUserOrders(phone);
        // Vendor new_order notify is server-triggered (request_after_insert_notify_vendor).
        if (saveAddress && newAddress.trim()) {
          const { error: addrError } = await supabase.rpc("insert_user_address", {
            p_device_id: getDeviceId(),
            p_user_phone: getUserPhone() ?? null,
            p_label: "",
            p_address_text: newAddress.trim(),
            p_is_default: addresses.length === 0,
          });
          if (addrError) {
            captureError(addrError, { scope: "parchiSheet.saveAddress" });
            console.error("Address save failed:", addrError.message);
          }
        }
        toast.success(
          isAppointmentMode ? s.parchi_toastBookingSuccess : s.parchi_toastOrderSuccess,
        );
        try {
          sessionStorage.setItem(`aaspaas:parchi:${v.id}`, "1");
        } catch {
          /* ignore */
        }
        setMessage("");
        setPendingPhone(null);
        onOrderSent?.();
        onClose();
      } catch (err) {
        dismissNetworkRetryingToast();
        if (err instanceof NetworkExhaustedError) {
          showNetworkFailedToast(() => void executeOrderInsert(phone), {
            failed: s.network_failed,
            retryBtn: s.network_retry_btn,
          });
        } else {
          throw err;
        }
      } finally {
        setSending(false);
      }
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
      deliverySlot,
      resolvedServiceMode,
      isAppointmentMode,
      isDeliveryMode,
      config.maxOrderMessageChars,
      s,
    ],
  );

  const send = useCallback(
    async (overridePhone?: string) => {
      const v = effectiveVendor;
      if (!v) return;
      const text = message.trim();
      if (!text) {
        toast.error(s.parchi_errNoOrder);
        return;
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
            2 * 60 * 60 * 1000
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

      setSending(true);
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

      // Keep sending=true through the insert gap; executeOrderInsert finally clears it.
      await executeOrderInsert(phone);
    },
    [
      effectiveVendor,
      message,
      onClose,
      executeOrderInsert,
      selectedAddressId,
      addresses,
      newAddress,
      appointmentDate,
      appointmentTime,
      appointmentLocation,
      appointmentTiming,
      isAppointmentMode,
      resolvedServiceMode,
      s,
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

  const getAvailableSlots = () => {
    const now = new Date();
    const hour = now.getHours();

    const all = [
      { value: "asap", label: s.parchi_slotAsapEmoji, alwaysShow: true },
      { value: "morning", label: s.parchi_slotMorningEmoji, cutoffHour: 11 },
      { value: "afternoon", label: s.parchi_slotAfternoonEmoji, cutoffHour: 15 },
      { value: "evening", label: s.parchi_slotEveningEmoji, cutoffHour: 19 },
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
            {effectiveVendor?.vendor_note && (
              <p className="text-xs text-muted-foreground mt-1">
                {s.parchi_vendorNotePrefix}
                {effectiveVendor.vendor_note}
              </p>
            )}
            <TrustWarningBanner
              tier={vendorBinaryTrustTier(effectiveVendor)}
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
                      onChange={(e) => setNewAddress(e.target.value)}
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
                      className={`rounded-xl border py-2.5 px-2 text-xs font-semibold transition-colors ${
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
                      className={`rounded-xl border py-2.5 px-2 text-xs font-semibold transition-colors ${
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
                      className={`rounded-xl border py-2.5 px-2 text-xs font-semibold transition-colors ${
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
                  <div className="flex flex-col min-h-0 max-h-[min(42vh,20rem)]">
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
                        className="w-full rounded-xl bg-brand/20 border border-brand text-brand py-2.5 text-sm font-semibold active:scale-[0.98]"
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
                  upiId={effectiveVendor.upi_id}
                  vendorPhone={effectiveVendor.phone}
                  qrUrl={(effectiveVendor as VendorWithQr).upi_qr_url}
                  qrPayeeId={(effectiveVendor as VendorWithQr).upi_qr_payee_id}
                />
              </div>
            )}

            </>
            )}
          </div>
          </div>
          {!trustBlock && (
            <div className="shrink-0 border-t border-surface-border bg-page-bg px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-2">
              {resolvedServiceMode === "appointment" ? (
                <p className="text-[11px] text-muted-foreground text-center">
                  {s.parchi_cancellationAppt}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground text-center">
                  {s.parchi_cancellationOrder}
                </p>
              )}
              <button
                type="button"
                data-testid="parchi-submit-btn"
                disabled={sending}
                onClick={() => void send()}
                className="w-full min-h-11 bg-brand text-white font-bold py-4 rounded-2xl text-base active:scale-[0.98] transition-transform disabled:opacity-60 disabled:pointer-events-none"
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
          className="bg-page-bg border-t border-surface-raised text-white rounded-t-2xl"
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
                className="mt-0.5 accent-brand"
              />
              {s.parchi_trust_low_confirmCheckbox}
            </label>
            <button
              type="button"
              disabled={!lowTrustConfirmed || sending}
              data-testid="parchi-low-trust-confirm"
              onClick={confirmLowTrustOrder}
              className="w-full rounded-xl bg-brand text-page-bg py-3.5 font-semibold disabled:opacity-50"
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
