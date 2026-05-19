import { useCallback, useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { supabase } from "@/lib/supabase";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

type Props = {
  isOpen: boolean;
  shopName: string;
  serviceMode: string;
  vendorId: string;
  onDismiss: () => void;
};

export function RatingSheet({ isOpen, shopName, serviceMode, vendorId, onDismiss }: Props) {
  const [loading, setLoading] = useState<false | "rate" | "issue">(false);

  useEffect(() => {
    if (!isOpen) setLoading(false);
  }, [isOpen]);

  const mode = serviceMode.trim().toLowerCase();
  const isDelivery = mode === "delivery";
  const busy = loading !== false;

  const handleRate = useCallback(async () => {
    setLoading("rate");
    const rpc = isDelivery ? "increment_vendor_delivered" : "increment_vendor_helped";
    const { error } = await supabase.rpc(rpc, { p_vendor_id: vendorId });
    setLoading(false);
    if (error) {
      toast.error("Could not save rating");
    }
    onDismiss();
  }, [isDelivery, vendorId, onDismiss]);

  const handleIssue = useCallback(async () => {
    setLoading("issue");
    const { error } = await supabase.rpc("increment_vendor_issues", { p_vendor_id: vendorId });
    setLoading(false);
    if (error) {
      toast.error("Could not save feedback");
    }
    onDismiss();
  }, [vendorId, onDismiss]);

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !busy) return;
      }}
    >
      <SheetContent
        side="bottom"
        className="bg-[#0a0a0a] border-t border-[#1f1f1f] text-white rounded-t-2xl max-h-[85vh] overflow-y-auto"
      >
        <SheetHeader className="text-left space-y-1 pr-8">
          <SheetTitle className="text-white font-display">How was your order?</SheetTitle>
          <SheetDescription className="text-gray-400">{shopName}</SheetDescription>
        </SheetHeader>

        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleRate()}
            className="w-full rounded-xl bg-[#22C55E] text-[#0a0a0a] py-3.5 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-60"
          >
            {loading === "rate" ? <Loader2 className="h-5 w-5 animate-spin shrink-0" /> : null}
            {isDelivery ? "📦 Delivered on Time" : "✅ He Helped Me"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleIssue()}
            className="w-full rounded-xl border border-destructive/50 text-destructive bg-transparent py-3 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-60"
          >
            {loading === "issue" ? <Loader2 className="h-5 w-5 animate-spin shrink-0" /> : null}
            ⚠️ Had an issue
          </button>
          <p className="text-[11px] text-gray-500 text-center pt-1">
            Please share your feedback to dismiss
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
