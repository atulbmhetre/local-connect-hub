import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { UpiPaymentPanel } from "@/components/payment/UpiPaymentPanel";
import { useLanguage } from "@/lib/language";

export interface PaymentSheetProps {
  open: boolean;
  onClose: () => void;
  order: {
    id: string;
    status: string;
    payment_status: string;
    amountRupees: number;
  };
  vendor: {
    vendor_id: string;
    shop_name: string;
    upi_id: string;
    phone: string;
    upi_qr_url: string | null;
    upi_qr_payee_id: string | null;
  };
}

export function PaymentSheet({ open, onClose, order, vendor }: PaymentSheetProps) {
  const { s } = useLanguage();

  const handleOpenChange = (next: boolean) => {
    if (!next) onClose();
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        data-testid="payment-sheet"
        side="bottom"
        className="bg-page-bg border-t border-surface-border rounded-t-2xl max-h-[90vh] flex flex-col [&>button]:text-muted-foreground"
        style={{
          transform: "translateZ(0)",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{s.payment_pay_now}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="pt-2">
            <UpiPaymentPanel
              idPrefix="payment-sheet"
              orderId={order.id}
              paymentStatus={order.payment_status}
              amountRupees={order.amountRupees}
              vendorId={vendor.vendor_id}
              shopName={vendor.shop_name}
              upiId={vendor.upi_id}
              vendorPhone={vendor.phone}
              qrUrl={vendor.upi_qr_url}
              qrPayeeId={vendor.upi_qr_payee_id}
              header={
                <div>
                  <p className="text-sm font-semibold text-foreground">{s.payment_pay_now}</p>
                  <p className="text-sm text-muted-foreground mt-1">{vendor.shop_name}</p>
                  <p className="text-xl font-bold text-foreground mt-2">
                    ₹{order.amountRupees.toFixed(2)}
                  </p>
                </div>
              }
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
