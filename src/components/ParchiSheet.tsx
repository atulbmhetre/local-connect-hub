import { useCallback, useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { supabase, type Vendor } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone, isPhoneKnown, migrateUserPhone } from "@/lib/userIdentity";
import { PhoneEntrySheet } from "@/components/PhoneEntrySheet";
import { toast } from "sonner";

const MAX_LEN = 200;

const SLOT_LABELS: Record<string, string> = {
  asap: "As soon as possible",
  morning: "Morning (before 12pm)",
  afternoon: "Afternoon (12–4pm)",
  evening: "Evening (after 4pm)",
  tomorrow: "Tomorrow",
};

type Props = {
  vendor: Vendor | null;
  isOpen: boolean;
  onClose: () => void;
  /** After successful order send; e.g. refresh radar resolution button visibility. */
  onOrderSent?: () => void;
};

type SavedAddress = {
  id: string;
  label: string;
  address_text: string;
  is_default: boolean;
};

export function ParchiSheet({ vendor, isOpen, onClose, onOrderSent }: Props) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [phoneSheetOpen, setPhoneSheetOpen] = useState(false);
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [newAddress, setNewAddress] = useState("");
  const [saveAddress, setSaveAddress] = useState(false);
  const [addressLoading, setAddressLoading] = useState(false);
  const [appointmentDate, setAppointmentDate] = useState("");
  const [appointmentTime, setAppointmentTime] = useState("");
  const [appointmentLocation, setAppointmentLocation] = useState<"home" | "shop" | "decide">("decide");
  const [deliverySlot, setDeliverySlot] = useState<string>("asap");
  const lastVendor = useRef<Vendor | null>(null);
  useEffect(() => {
    if (vendor) lastVendor.current = vendor;
  }, [vendor]);
  const effectiveVendor = vendor ?? lastVendor.current;

  useEffect(() => {
    if (!isOpen) return;
    const mode = effectiveVendor?.service_mode;
    const loadForAddress =
      mode === "delivery" || (mode === "appointment" && appointmentLocation === "home");
    if (!loadForAddress) return;

    let cancelled = false;
    const loadAddresses = async () => {
      setAddressLoading(true);
      const deviceId = getDeviceId();
      const userPhone = getUserPhone();
      let query = supabase
        .from("user_addresses")
        .select("id, label, address_text, is_default");
      if (userPhone != null) {
        query = query.or(`device_id.eq.${deviceId},user_phone.eq.${userPhone}`);
      } else {
        query = query.eq("device_id", deviceId);
      }
      const { data, error } = await query;
      if (cancelled) return;
      if (error) {
        setAddresses([]);
        setSelectedAddressId(null);
      } else {
        const list = (data ?? []) as SavedAddress[];
        setAddresses(list);
        const defaultAddr = list.find((a) => a.is_default);
        setSelectedAddressId(defaultAddr?.id ?? null);
      }
      setAddressLoading(false);
    };
    void loadAddresses();
    return () => {
      cancelled = true;
    };
  }, [isOpen, effectiveVendor?.service_mode, effectiveVendor?.id, appointmentLocation]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setMessage("");
        setSending(false);
        setSelectedAddressId(null);
        setNewAddress("");
        setSaveAddress(false);
        setAddresses([]);
        setAppointmentDate("");
        setAppointmentTime("");
        setAppointmentLocation("decide");
        setDeliverySlot("asap");
        onClose();
      }
    },
    [onClose],
  );

  const send = useCallback(
    async (overridePhone?: string) => {
      const v = effectiveVendor;
      if (!v) return;
      const text = message.trim();
      if (!text) {
        toast.error("Please type your order.");
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
        toast.error("Please add a delivery address.");
        return;
      }
      if (effectiveVendor?.service_mode === "appointment") {
        if (!appointmentDate || !appointmentTime) {
          toast.error("Please select appointment date and time.");
          return;
        }
      }
      if (overridePhone == null && !isPhoneKnown()) {
        setPhoneSheetOpen(true);
        return;
      }
      const phone = overridePhone ?? getUserPhone()!;
      const locationNote =
        effectiveVendor?.service_mode === "appointment"
          ? appointmentLocation === "home"
            ? " [Come to my place]"
            : appointmentLocation === "shop"
              ? " [I'll visit your shop]"
              : " [Location TBD]"
          : "";
      const deliverySlotNote =
        effectiveVendor?.service_mode === "delivery"
          ? ` [Deliver: ${SLOT_LABELS[deliverySlot] ?? "As soon as possible"}]`
          : "";
      const appointmentTimestamp =
        effectiveVendor?.service_mode === "appointment" && appointmentDate && appointmentTime
          ? new Date(`${appointmentDate}T${appointmentTime}:00`).toISOString()
          : null;
      setSending(true);
      const device_id = getDeviceId();
      const { error } = await supabase.from("requests").insert({
        device_id,
        vendor_id: v.id,
        message: text.slice(0, MAX_LEN) + locationNote + deliverySlotNote,
        status: "sent",
        user_phone: phone,
        device_id_log: device_id,
        delivery_address: finalAddress,
        appointment_time: appointmentTimestamp,
        appointment_status: appointmentTimestamp ? "pending" : null,
      });
      if (error) {
        setSending(false);
        toast.error("Could not send order", { description: error.message });
        return;
      }
      if (saveAddress && newAddress.trim()) {
        await supabase.from("user_addresses").insert({
          device_id: getDeviceId(),
          user_phone: getUserPhone() ?? null,
          label: "Home",
          address_text: newAddress.trim(),
          is_default: addresses.length === 0,
        });
      }
      setSending(false);
      toast.success(
        v.service_mode === "appointment"
          ? `📅 Booking requested with ${v.shop_name}!`
          : `✅ Order sent to ${v.shop_name}! They will see it shortly.`,
      );
      try {
        sessionStorage.setItem(`aaspaas:parchi:${v.id}`, "1");
      } catch {
        /* ignore */
      }
      setMessage("");
      onOrderSent?.();
      onClose();
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
      appointmentDate,
      appointmentTime,
      appointmentLocation,
      deliverySlot,
    ],
  );

  if (!effectiveVendor) return null;

  const online = effectiveVendor.is_active === true;
  const len = message.length;

  const getAvailableSlots = () => {
    const now = new Date();
    const hour = now.getHours();

    const all = [
      { value: "asap", label: "🚀 As soon as possible", alwaysShow: true },
      { value: "morning", label: "🌅 Morning (before 12pm)", cutoffHour: 11 },
      { value: "afternoon", label: "🌞 Afternoon (12–4pm)", cutoffHour: 15 },
      { value: "evening", label: "🌆 Evening (after 4pm)", cutoffHour: 19 },
      { value: "tomorrow", label: "📅 Tomorrow", alwaysShow: true },
    ];

    return all.filter(
      (slot) => slot.alwaysShow || (slot.cutoffHour !== undefined && hour < slot.cutoffHour),
    );
  };

  return (
    <>
      <Sheet open={isOpen} onOpenChange={handleOpenChange}>
        <SheetContent
          side="bottom"
          className="bg-[#0a0a0a] border-t border-[#1f1f1f] text-white rounded-t-2xl max-h-[90vh] overflow-y-auto [&>button]:text-gray-400"
        >
          <SheetHeader className="text-left space-y-2 pr-8">
            <SheetTitle className="text-white font-display text-lg">
              {effectiveVendor?.service_mode === "appointment"
                ? `Book with ${effectiveVendor.shop_name}`
                : `Order to ${effectiveVendor.shop_name}`}
            </SheetTitle>
            <SheetDescription className="text-sm text-gray-400 text-left">
              {effectiveVendor?.service_mode === "appointment" ? (
                online ? (
                  <>🟢 Online — will confirm your booking shortly</>
                ) : (
                  <>⚫ Offline — will confirm when they return</>
                )
              ) : online ? (
                <>🟢 Online — will see this shortly</>
              ) : (
                <>⚫ Offline — will see when they return</>
              )}
            </SheetDescription>
            {effectiveVendor?.vendor_note && (
              <div className="mt-2 rounded-xl border border-[#22C55E]/30 bg-[#22C55E]/5 px-3 py-2 text-[11px] text-[#22C55E]">
                📌 {effectiveVendor.vendor_note}
              </div>
            )}
          </SheetHeader>

          <div className="mt-5 space-y-3">
            {(effectiveVendor?.service_mode === "delivery" ||
              (effectiveVendor?.service_mode === "appointment" && appointmentLocation === "home")) && (
              <div className="space-y-2">
                <p className="text-xs text-gray-400 flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> Delivery Address
                </p>

                {addressLoading && (
                  <p className="text-xs text-gray-500">Loading addresses...</p>
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
                            ? "border-[#22C55E] bg-[#22C55E]/10 text-white"
                            : "border-[#2a2a2a] bg-[#141414] text-gray-300"
                        }`}
                      >
                        <span className="font-semibold">{addr.label}</span>
                        <span className="text-gray-400 ml-2">{addr.address_text}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setSelectedAddressId(null)}
                      className={`w-full text-left rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                        selectedAddressId === null
                          ? "border-[#22C55E] bg-[#22C55E]/10 text-white"
                          : "border-[#2a2a2a] bg-[#141414] text-gray-400"
                      }`}
                    >
                      + Use a different address
                    </button>
                  </div>
                )}

                {!addressLoading && selectedAddressId === null && (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={newAddress}
                      onChange={(e) => setNewAddress(e.target.value)}
                      placeholder="e.g. Flat 4B, Green Park, Near Water Tank"
                      className="w-full rounded-xl border border-[#2a2a2a] bg-[#141414] px-3 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#22C55E]/50"
                    />
                    <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={saveAddress}
                        onChange={(e) => setSaveAddress(e.target.checked)}
                        className="accent-[#22C55E]"
                      />
                      Save this address for next time
                    </label>
                  </div>
                )}
              </div>
            )}

            {effectiveVendor?.service_mode === "appointment" && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">📍 Where?</p>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => setAppointmentLocation("home")}
                      className={`rounded-xl border py-2.5 px-2 text-xs font-semibold transition-colors ${
                        appointmentLocation === "home"
                          ? "border-blue-500 bg-blue-500/10 text-blue-400"
                          : "border-[#2a2a2a] bg-[#141414] text-gray-400"
                      }`}
                    >
                      🏠 Come to me
                    </button>
                    <button
                      type="button"
                      onClick={() => setAppointmentLocation("shop")}
                      className={`rounded-xl border py-2.5 px-2 text-xs font-semibold transition-colors ${
                        appointmentLocation === "shop"
                          ? "border-purple-500 bg-purple-500/10 text-purple-400"
                          : "border-[#2a2a2a] bg-[#141414] text-gray-400"
                      }`}
                    >
                      🏪 I'll visit
                    </button>
                    <button
                      type="button"
                      onClick={() => setAppointmentLocation("decide")}
                      className={`rounded-xl border py-2.5 px-2 text-xs font-semibold transition-colors ${
                        appointmentLocation === "decide"
                          ? "border-gray-500 bg-gray-500/10 text-gray-300"
                          : "border-[#2a2a2a] bg-[#141414] text-gray-400"
                      }`}
                    >
                      📞 Decide later
                    </button>
                  </div>
                </div>
                <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">
                  📅 When do you need them?
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-xs text-gray-500">Date</label>
                    <input
                      type="date"
                      value={appointmentDate}
                      min={new Date().toISOString().split("T")[0]}
                      onChange={(e) => setAppointmentDate(e.target.value)}
                      className="w-full rounded-xl border border-[#2a2a2a] bg-[#141414] px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#22C55E]/50"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-gray-500">Time</label>
                    <input
                      type="time"
                      value={appointmentTime}
                      onChange={(e) => setAppointmentTime(e.target.value)}
                      className="w-full rounded-xl border border-[#2a2a2a] bg-[#141414] px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#22C55E]/50"
                    />
                  </div>
                </div>
              </div>
            )}

            {effectiveVendor?.service_mode === "delivery" && (
              <div className="space-y-2">
                <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">
                  🕐 When do you need it?
                </p>
                <select
                  value={deliverySlot}
                  onChange={(e) => setDeliverySlot(e.target.value)}
                  className="w-full rounded-xl border border-[#2a2a2a] bg-[#141414] px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#22C55E]/50"
                >
                  {getAvailableSlots().map((slot) => (
                    <option key={slot.value} value={slot.value}>
                      {slot.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <label className="sr-only" htmlFor="parchi-message">
              Your order
            </label>
            <textarea
              id="parchi-message"
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, MAX_LEN))}
              rows={5}
              placeholder={
                effectiveVendor?.service_mode === "appointment"
                  ? "Any special notes?\ne.g. Full facial, 2 people, ground floor"
                  : "Type your order...\ne.g. 1kg atta, 2 soaps, Colgate toothpaste"
              }
              className="w-full resize-none rounded-xl border border-[#2a2a2a] bg-[#141414] px-3 py-3 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#22C55E]/50"
            />
            <div className="flex justify-end text-xs text-gray-500 tabular-nums">
              {len} / {MAX_LEN}
            </div>

            {effectiveVendor?.service_mode === "appointment" ? (
              <p className="text-[11px] text-muted-foreground text-center">
                ℹ️ Free cancellation before your booking day. Same-day changes need a quick call first.
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground text-center">
                ℹ️ You can cancel this order only if the vendor hasn't seen it yet.
              </p>
            )}

            <button
              type="button"
              disabled={sending}
              onClick={() => void send()}
              className="w-full rounded-xl bg-[#22C55E] text-[#0a0a0a] py-3.5 font-semibold active:scale-[0.98] transition-transform disabled:opacity-60 disabled:pointer-events-none"
            >
              {effectiveVendor?.service_mode === "appointment"
                ? "📅 Confirm Booking"
                : "📋 Send Order"}
            </button>
            <button
              type="button"
              disabled={sending}
              onClick={() => handleOpenChange(false)}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-400 transition-colors"
            >
              Cancel
            </button>
          </div>
        </SheetContent>
      </Sheet>
      <PhoneEntrySheet
        isOpen={phoneSheetOpen}
        onClose={() => setPhoneSheetOpen(false)}
        onConfirmed={async (phone) => {
          setPhoneSheetOpen(false);
          await migrateUserPhone(phone, getDeviceId());
          void send(phone);
        }}
      />
    </>
  );
}
