import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, ChevronDown, Loader2, MapPin, Mic } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { getVoiceLang } from "@/lib/voiceUtils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  supabase,
  invokeNotifyVendor,
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
};

export type ParchiPaymentOrder = {
  id: string;
  status: string;
  payment_status: "unpaid" | "claimed" | "confirmed" | "disputed";
  amount: number;
};

type VendorWithQr = Vendor & { upi_qr_url?: string | null };

type PaymentTab = "upi" | "mobile" | "qr";

const menuItemLabel = (item: VendorMenuItem) =>
  item.name?.trim() || item.description?.trim() || "Item";

type Props = {
  vendor: Vendor | null;
  vendorId?: string | null;
  serviceMode?: string | null;
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
  const [paymentTab, setPaymentTab] = useState<PaymentTab>("upi");
  const [payCountdown, setPayCountdown] = useState<number | null>(null);
  const [paymentUtr, setPaymentUtr] = useState("");
  const [utrSubmitting, setUtrSubmitting] = useState(false);
  const [localPaymentStatus, setLocalPaymentStatus] = useState<
    ParchiPaymentOrder["payment_status"] | undefined
  >(order?.payment_status);
  const [customerLat, setCustomerLat] = useState<number | null>(null);
  const [customerLng, setCustomerLng] = useState<number | null>(null);
  const [shareLocationEnabled, setShareLocationEnabled] = useState(false);
  const [locationPermissionBlocked, setLocationPermissionBlocked] = useState(false);
  const [locationCaptured, setLocationCaptured] = useState(false);
  useEffect(() => {
    if (vendor) lastVendor.current = vendor;
  }, [vendor]);

  useEffect(() => {
    setLocalPaymentStatus(order?.payment_status);
    setPaymentTab("upi");
    setPayCountdown(null);
    setPaymentUtr("");
  }, [order?.id, order?.payment_status]);

  useEffect(() => {
    if (payCountdown === null || payCountdown <= 0) return;
    const id = window.setInterval(() => {
      setPayCountdown((n) => (n === null || n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [payCountdown]);

  const resetFormFields = useCallback(() => {
    setMessage("");
    setAppointmentDate("");
    setAppointmentTime("");
    setAppointmentLocation("decide");
    setDeliverySlot("asap");
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

  useEffect(() => {
    if (!isOpen || !resolvedVendorId) return;
    setMenuExpanded(message.trim().length === 0);
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("vendor_menu_items")
        .select("id, name, description, price, unit, is_available")
        .eq("vendor_id", resolvedVendorId)
        .eq("is_available", true)
        .order("name", { ascending: true });
      if (cancelled) return;
      if (error || !data?.length) {
        setMenuItems([]);
        return;
      }
      setMenuItems(data as VendorMenuItem[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, resolvedVendorId, message]);

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
      effectiveVendor.service_mode === "delivery" ||
      (effectiveVendor.service_mode === "appointment" && appointmentLocation === "home");
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
  }, [isOpen, effectiveVendor?.service_mode, appointmentLocation]);

  useEffect(() => {
    if (
      effectiveVendor?.service_mode === "appointment" &&
      appointmentLocation !== "home" &&
      !shareLocationEnabled
    ) {
      setCustomerLat(null);
      setCustomerLng(null);
    }
  }, [appointmentLocation, effectiveVendor?.service_mode, shareLocationEnabled]);

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
        toast.error("Voice not available on this device");
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
      const text = message.trim();
      const needsAddress =
        effectiveVendor?.service_mode === "delivery" ||
        (effectiveVendor?.service_mode === "appointment" && appointmentLocation === "home");
      const finalAddress = needsAddress
        ? selectedAddressId
          ? (addresses.find((a) => a.id === selectedAddressId)?.address_text ?? "")
          : newAddress.trim()
        : null;
      const locationNote =
        effectiveVendor?.service_mode === "appointment"
          ? appointmentLocation === "home"
            ? s.parchi_locationComeToMe
            : appointmentLocation === "shop"
              ? s.parchi_locationVisitShop
              : s.parchi_locationTbd
          : "";
      const appointmentTimestamp =
        effectiveVendor?.service_mode === "appointment" && appointmentDate && appointmentTime
          ? new Date(`${appointmentDate}T${appointmentTime}:00`).toISOString()
          : null;
      const selectedSlot =
        effectiveVendor?.service_mode === "delivery" ? deliverySlot : null;

      if (effectiveVendor?.service_mode === "delivery") {
        const slotDeadline = getDeliverySlotDeadline(selectedSlot);
        if (slotDeadline != null && new Date(slotDeadline) < new Date()) {
          toast.error(s.parchi_slot_expired);
          return;
        }
      }

      if (effectiveVendor?.service_mode === "appointment") {
        if (appointmentTimestamp != null && new Date(appointmentTimestamp) < new Date()) {
          toast.error(s.parchi_appointment_expired);
          return;
        }
        if (
          effectiveVendor.is_active === false &&
          appointmentTimestamp != null &&
          new Date(appointmentTimestamp).getTime() - Date.now() < 2 * 60 * 60 * 1000
        ) {
          setOfflineApptError(true);
          return;
        }
      }

      setSending(true);
      const device_id = getDeviceId();
      try {
        const { data: insertedId, error } = await withNetworkRetry(
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
                  effectiveVendor?.service_mode === "delivery"
                    ? getDeliverySlotDeadline(selectedSlot)
                    : null,
                p_appointment_time: appointmentTimestamp,
                p_appointment_status: appointmentTimestamp ? "pending" : null,
                p_customer_latitude: customerLat ?? null,
                p_customer_longitude: customerLng ?? null,
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
          setSending(false);
          toast.error(s.parchi_errCouldNotSend, { description: error.message });
          return;
        }
        void upsertUser(phone);
        void incrementUserOrders(phone);
        const fullMessage = text.slice(0, config.maxOrderMessageChars) + locationNote;
        const notifyBody = fullMessage
          .replace(/\s*\[Come to my place\]/g, "")
          .replace(/\s*\[I'll visit your shop\]/g, "")
          .replace(/\s*\[Location TBD\]/g, "")
          .trim();
        void invokeNotifyVendor({
          vendor_id: v.id,
          category: v.category,
          message: notifyBody,
          type: "new_order",
          request_id: insertedId,
        });
        if (saveAddress && newAddress.trim()) {
          const { error: addrError } = await supabase.rpc("insert_user_address", {
            p_device_id: getDeviceId(),
            p_user_phone: getUserPhone() ?? null,
            p_label: "",
            p_address_text: newAddress.trim(),
            p_is_default: addresses.length === 0,
          });
          if (addrError) console.error("Address save failed:", addrError.message);
        }
        setSending(false);
        toast.success(
          v.service_mode === "appointment"
            ? s.parchi_toastBookingSuccess
            : s.parchi_toastOrderSuccess,
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
          setSending(false);
          showNetworkFailedToast(() => void executeOrderInsert(phone), {
            failed: s.network_failed,
            retryBtn: s.network_retry_btn,
          });
        } else {
          throw err;
        }
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
      deliverySlot,
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
        effectiveVendor?.service_mode === "delivery" ||
        (effectiveVendor?.service_mode === "appointment" && appointmentLocation === "home");
      const finalAddress = needsAddress
        ? selectedAddressId
          ? (addresses.find((a) => a.id === selectedAddressId)?.address_text ?? "")
          : newAddress.trim()
        : null;

      if (needsAddress && !finalAddress) {
        toast.error(s.parchi_errNoAddress);
        return;
      }
      if (effectiveVendor?.service_mode === "appointment") {
        if (!appointmentDate || !appointmentTime) {
          toast.error(s.parchi_errNoDateTime);
          return;
        }
        if (
          effectiveVendor.is_active === false &&
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
      const trust = await fetchUserTrust(phone);
      setSending(false);

      if (trust?.is_banned) {
        setTrustBlock("banned");
        return;
      }

      const score = trust?.trust_score;
      if (score != null && score >= 1 && score <= 24) {
        setTrustBlock("suspended");
        return;
      }

      if (score != null && score >= 25 && score <= 49) {
        if (effectiveVendor?.service_mode === "help") {
          toast.error("Help mode is currently unavailable for your account");
          onClose();
          return;
        }
        setPendingPhone(phone);
        setLowTrustConfirmed(false);
        setLowTrustSheetOpen(true);
        return;
      }

      if (score != null && score >= 50 && score <= 74) {
        setPendingPhone(phone);
        setMediumTrustDialogOpen(true);
        return;
      }

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

  const selectPaymentTab = (tab: PaymentTab) => {
    setPaymentTab(tab);
    setPayCountdown(null);
    setPaymentUtr("");
  };

  const amountInRupees = order?.amount ? (order.amount / 100).toFixed(2) : "0";

  const openUpiDeepLink = (pa: string) => {
    const v = effectiveVendor as VendorWithQr | null;
    if (!order || !v || !pa) return;
    const deepLink = `upi://pay?pa=${pa}&pn=${encodeURIComponent(v.shop_name)}&am=${amountInRupees}&tn=AaspaasOrder-${order.id}`;
    window.open(deepLink, "_blank");
    setPayCountdown(30);
  };

  const handlePayNowUpi = () => {
    const v = effectiveVendor as VendorWithQr | null;
    if (!v?.upi_id) return;
    openUpiDeepLink(v.upi_id);
  };

  const handlePayNowMobile = () => {
    const v = effectiveVendor as VendorWithQr | null;
    if (!v?.phone) return;
    openUpiDeepLink(`${v.phone}@upi`);
  };

  const handleSubmitPaymentUtr = async () => {
    const v = effectiveVendor as VendorWithQr | null;
    if (!order || !v) return;
    const trimmed = paymentUtr.trim();
    if (!trimmed) {
      toast.error(s.payment_utr_empty);
      return;
    }
    setUtrSubmitting(true);
    const { error } = await supabase.rpc("claim_customer_payment", {
      p_request_id: order.id,
      p_payment_utr: trimmed,
      p_device_id: getDeviceId(),
      p_user_phone: getUserPhone(),
    });
    if (error) {
      toast.error(error.message);
      setUtrSubmitting(false);
      return;
    }
    void invokeNotifyVendor({
      vendor_id: v.id,
      notification_title: "Payment Claimed",
      message: `Customer claims payment of ₹${amountInRupees} — UTR: ${trimmed}`,
      type: "payment_claimed",
      request_id: order.id,
    });
    setLocalPaymentStatus("claimed");
    setUtrSubmitting(false);
  };

  const showPaymentSection =
    order?.status === "fulfilled" && localPaymentStatus != null;
  const showPaymentPicker = localPaymentStatus === "unpaid";
  const showUtrInput =
    paymentTab === "qr" || (payCountdown !== null && payCountdown <= 0);
  const vendorQrUrl = (effectiveVendor as VendorWithQr | null)?.upi_qr_url?.trim() || "";

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
      (slot) => slot.alwaysShow || (slot.cutoffHour !== undefined && hour < slot.cutoffHour),
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
              {effectiveVendor?.service_mode === "appointment"
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
              {effectiveVendor?.service_mode === "appointment" ? (
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
          </div>

          <div className="mt-5 space-y-3 px-4">
            {effectiveVendor.is_active === false && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 leading-relaxed">
                {s.parchi_offline_banner}
              </div>
            )}
            {trustBlock === "banned" && (
              <div className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-6 text-sm text-center text-foreground leading-relaxed">
                🚫 Your account has been suspended. Please contact aaspaaspro.privacy@gmail.com
              </div>
            )}
            {trustBlock === "suspended" && (
              <div className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-6 text-sm text-center text-foreground leading-relaxed">
                ⛔ Orders temporarily unavailable. Please contact aaspaaspro.privacy@gmail.com
              </div>
            )}
            {!trustBlock && (
            <>
            {(effectiveVendor?.service_mode === "delivery" ||
              (effectiveVendor?.service_mode === "appointment" && appointmentLocation === "home")) && (
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

            {effectiveVendor?.service_mode === "appointment" && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">{s.parchi_whereQuestion}</p>
                  <div className="grid grid-cols-3 gap-2">
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
                {offlineApptError && (
                  <p className="text-xs text-amber-600 leading-snug">
                    {s.parchi_offline_appt_too_soon}
                  </p>
                )}
              </div>
            )}

            {effectiveVendor?.service_mode === "delivery" && (
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
                {effectiveVendor?.service_mode === "appointment"
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
                  effectiveVendor?.service_mode === "appointment"
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

            {effectiveVendor?.service_mode === "help" && (
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

            {showPaymentSection && (
              <div className="space-y-3 pt-1" data-testid="parchi-payment-section">
                {showPaymentPicker ? (
                  <>
                    <div className="flex border-b border-surface-border">
                      {(
                        [
                          { id: "upi" as const, label: "UPI ID" },
                          { id: "mobile" as const, label: "Mobile" },
                          { id: "qr" as const, label: "QR Code" },
                        ] as const
                      ).map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => selectPaymentTab(tab.id)}
                          className={cn(
                            "flex-1 pb-2 text-xs font-semibold transition-colors border-b-2 -mb-px",
                            paymentTab === tab.id
                              ? "border-brand text-foreground"
                              : "border-transparent text-muted-foreground",
                          )}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>

                    {paymentTab === "upi" && (
                      <div className="space-y-3">
                        {payCountdown === null && (
                          <button
                            type="button"
                            onClick={handlePayNowUpi}
                            className="w-full min-h-11 bg-brand text-white font-bold py-3 rounded-2xl text-sm active:scale-[0.98] transition-transform"
                          >
                            {s.payment_pay_now}
                          </button>
                        )}
                        {payCountdown !== null && payCountdown > 0 && (
                          <p className="text-sm text-muted-foreground text-center">
                            {s.payment_timer.replace("{n}", String(payCountdown))}
                          </p>
                        )}
                      </div>
                    )}

                    {paymentTab === "mobile" && (
                      <div className="space-y-3">
                        {payCountdown === null && (
                          <button
                            type="button"
                            onClick={handlePayNowMobile}
                            className="w-full min-h-11 bg-brand text-white font-bold py-3 rounded-2xl text-sm active:scale-[0.98] transition-transform"
                          >
                            {s.payment_pay_now}
                          </button>
                        )}
                        {payCountdown !== null && payCountdown > 0 && (
                          <p className="text-sm text-muted-foreground text-center">
                            {s.payment_timer.replace("{n}", String(payCountdown))}
                          </p>
                        )}
                      </div>
                    )}

                    {paymentTab === "qr" && (
                      <div className="space-y-3 text-center">
                        {!vendorQrUrl ? (
                          <p className="text-xs text-muted-foreground">
                            Vendor hasn&apos;t uploaded a QR code yet
                          </p>
                        ) : (
                          <>
                            <img
                              src={vendorQrUrl}
                              alt=""
                              className="mx-auto h-[200px] w-[200px] rounded-lg border border-surface-border object-contain"
                            />
                            <p className="text-sm text-foreground">
                              {s.payment_amount_label}{" "}
                              <span className="font-bold">₹{amountInRupees}</span>
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {s.payment_scan_instruction}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {s.payment_enter_amount.replace("{amount}", amountInRupees)}
                            </p>
                          </>
                        )}
                      </div>
                    )}

                    {showUtrInput && (paymentTab !== "qr" || vendorQrUrl) && (
                      <div className="space-y-2">
                        <label
                          htmlFor="parchi-payment-utr"
                          className="text-xs font-medium text-muted-foreground uppercase tracking-wide block"
                        >
                          {s.payment_enter_utr}
                        </label>
                        <input
                          id="parchi-payment-utr"
                          type="text"
                          value={paymentUtr}
                          onChange={(e) => setPaymentUtr(e.target.value)}
                          className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-brand/50"
                        />
                        <button
                          type="button"
                          disabled={utrSubmitting}
                          onClick={() => void handleSubmitPaymentUtr()}
                          className="w-full min-h-11 bg-brand text-white font-bold py-3 rounded-2xl text-sm active:scale-[0.98] transition-transform disabled:opacity-60"
                        >
                          {utrSubmitting ? "..." : s.payment_submit_utr}
                        </button>
                      </div>
                    )}
                  </>
                ) : localPaymentStatus === "claimed" ? (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" aria-hidden />
                    {s.payment_claimed}
                  </div>
                ) : localPaymentStatus === "confirmed" ? (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" aria-hidden />
                    {s.payment_confirmed}
                  </div>
                ) : localPaymentStatus === "disputed" ? (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden />
                    {s.payment_disputed}
                  </div>
                ) : null}
              </div>
            )}

            </>
            )}
          </div>
          </div>
          {!trustBlock && (
            <div className="shrink-0 border-t border-surface-border bg-page-bg px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-2">
              {effectiveVendor?.service_mode === "appointment" ? (
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
                  : effectiveVendor?.service_mode === "appointment"
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
