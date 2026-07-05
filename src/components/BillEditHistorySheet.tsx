import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useLanguage } from "@/lib/language";
import {
  fetchBillEditAudit,
  formatBillEditAuditDate,
  type BillEditAuditRow,
} from "@/lib/billEdit";
import { cn } from "@/lib/utils";

type Props = {
  billId: string | null;
  isOpen: boolean;
  onClose: () => void;
};

export function BillEditHistorySheet({ billId, isOpen, onClose }: Props) {
  const { s } = useLanguage();
  const [rows, setRows] = useState<BillEditAuditRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !billId) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchBillEditAudit(billId).then((data) => {
      if (cancelled) return;
      setRows(data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, billId]);

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        className="rounded-t-2xl max-h-[85vh] flex flex-col"
        style={{ transform: "translateZ(0)", WebkitOverflowScrolling: "touch" }}
      >
        <SheetHeader className="text-left shrink-0">
          <SheetTitle>{s.bill_editHistoryTitle}</SheetTitle>
        </SheetHeader>
        <div className="mt-4 flex-1 min-h-0 overflow-y-auto space-y-2">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {s.bill_editHistoryEmpty}
            </p>
          ) : (
            rows.map((row) => (
              <div
                key={row.id}
                className="rounded-xl border border-surface-border bg-surface px-3 py-2.5 space-y-1"
              >
                <p className="text-xs text-muted-foreground">
                  {formatBillEditAuditDate(row.edited_at)}
                </p>
                <p className="text-sm font-bold tabular-nums text-foreground">
                  {s.bill_editHistoryAmounts
                    .replace("{old}", row.old_total.toFixed(2))
                    .replace("{new}", row.new_total.toFixed(2))}
                </p>
                {row.reason?.trim() ? (
                  <p
                    className={cn(
                      "text-sm leading-snug whitespace-pre-wrap break-words text-foreground",
                    )}
                  >
                    {row.reason.trim()}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    {s.bill_editHistoryNoReason}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
