import { Phone } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  emojiForVendorCategory,
  supabase,
  type Category,
  type Vendor,
} from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import { useLanguage } from "@/lib/language";

export type SavedVendorInfo = {
  nickname: string;
  category: string;
};

type NeighbourSheetProps = {
  vendor: Vendor | null;
  savedVendor: SavedVendorInfo | null;
  isOpen: boolean;
  onClose: () => void;
  onRemove: () => void;
  activeDeliveryOrder: boolean;
  activeAppointmentOrder: boolean;
  categories: Category[];
  onOpenParchi: (vendor: Vendor) => void;
  onOpenAiBridge: (vendor: Vendor) => void;
  onNavigateOrders: () => void;
};

export function NeighbourSheet({
  vendor,
  savedVendor: _savedVendor,
  isOpen,
  onClose,
  onRemove,
  activeDeliveryOrder,
  activeAppointmentOrder,
  categories,
  onOpenParchi,
  onOpenAiBridge,
  onNavigateOrders,
}: NeighbourSheetProps) {
  const { s } = useLanguage();

  const handleRemove = async () => {
    if (!vendor) return;
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    const { error } = await supabase.rpc("unsave_saved_vendor", {
      p_vendor_id: vendor.id,
      p_device_id: device_id,
      p_user_phone: userPhone ?? null,
    });
    if (error) {
      toast.error(s.couldNotRemove, { description: error.message });
      return;
    }
    try {
      sessionStorage.removeItem(`aaspaas:saved:${vendor.id}`);
    } catch {
      /* ignore */
    }
    onClose();
    onRemove();
    toast.success(s.removedFromNeighbourhood);
  };

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        className="bg-card border-t border-border rounded-t-2xl max-h-[85vh] overflow-y-auto"
      >
        {vendor && (
          <>
            <SheetHeader className="text-left space-y-3 pr-8">
              <div className="flex items-start gap-3">
                <div className="relative shrink-0">
                  <span
                    className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card ${
                      vendor.is_active ? "bg-brand" : "bg-muted-foreground/50"
                    }`}
                    aria-hidden
                  />
                  <div className="h-12 w-12 rounded-xl overflow-hidden bg-muted grid place-items-center">
                    {vendor.shop_photo_url ? (
                      <img src={vendor.shop_photo_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-2xl" aria-hidden>
                        {emojiForVendorCategory(vendor.category, categories)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <SheetTitle className="text-left font-display text-lg">{vendor.shop_name}</SheetTitle>
                  <p className="text-sm text-muted-foreground">{vendor.category}</p>
                  <p className="text-xs text-muted-foreground">
                    {vendor.is_active ? (
                      <span className="text-brand font-medium">{s.online}</span>
                    ) : (
                      <span>{s.offline}</span>
                    )}
                  </p>
                </div>
              </div>
              <SheetDescription className="sr-only">Choose how to contact this saved vendor</SheetDescription>
            </SheetHeader>

            <div className="mt-6 flex flex-col gap-2">
              {String(vendor.service_mode ?? "")
                .trim()
                .toLowerCase() === "delivery" ? (
                activeDeliveryOrder ? (
                  <>
                    <button
                      type="button"
                      className="w-full text-left text-sm text-muted-foreground underline underline-offset-2 py-1"
                      onClick={() => {
                        onClose();
                        onNavigateOrders();
                      }}
                    >
                      {s.yourActiveOrders}
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
                      onClick={() => {
                        onClose();
                        onOpenParchi(vendor);
                      }}
                    >
                      {s.sendNewOrder}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
                    onClick={() => {
                      onClose();
                      onOpenParchi(vendor);
                    }}
                  >
                    {s.sendOrder}
                  </button>
                )
              ) : String(vendor.service_mode ?? "")
                  .trim()
                  .toLowerCase() === "appointment" ? (
                <>
                  {activeAppointmentOrder ? (
                    <>
                      <button
                        type="button"
                        className="w-full text-left text-sm text-muted-foreground underline underline-offset-2 py-1"
                        onClick={() => {
                          onClose();
                          onNavigateOrders();
                        }}
                      >
                        {s.yourActiveBookings}
                      </button>
                      <button
                        type="button"
                        className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
                        onClick={() => {
                          onClose();
                          onOpenParchi(vendor);
                        }}
                      >
                        {s.bookAgain}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
                      onClick={() => {
                        onClose();
                        onOpenParchi(vendor);
                      }}
                    >
                      {s.bookService}
                    </button>
                  )}
                  <button
                    type="button"
                    className="w-full rounded-xl border border-border py-3 text-sm font-semibold text-muted-foreground"
                    onClick={onClose}
                  >
                    {s.cancel}
                  </button>
                  <button
                    type="button"
                    className="w-full py-2 text-xs font-medium text-destructive hover:underline"
                    onClick={() => void handleRemove()}
                  >
                    {s.removeFromNeighbourhood}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold flex items-center justify-center gap-2 active:scale-[0.98]"
                  onClick={() => {
                    onClose();
                    onOpenAiBridge(vendor);
                  }}
                >
                  <Phone className="h-4 w-4" />
                  {s.connectAiBridge}
                </button>
              )}
              {String(vendor.service_mode ?? "")
                .trim()
                .toLowerCase() !== "appointment" && (
                <>
                  <button
                    type="button"
                    className="w-full rounded-xl border border-border py-3 text-sm font-semibold text-muted-foreground"
                    onClick={onClose}
                  >
                    {s.cancel}
                  </button>
                  <button
                    type="button"
                    className="w-full py-2 text-xs font-medium text-destructive hover:underline"
                    onClick={() => void handleRemove()}
                  >
                    {s.removeFromNeighbourhood}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
