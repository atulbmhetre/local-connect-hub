import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import {
  fetchVendorBillCatalog,
  type BillCatalogMenuItem,
} from "@/lib/billMenuCatalog";

type Props = {
  vendorId: string;
  isOpen: boolean;
  onPick: (item: BillCatalogMenuItem) => void;
};

export function BillMenuCatalogPicker({ vendorId, isOpen, onPick }: Props) {
  const { s } = useLanguage();
  const [items, setItems] = useState<BillCatalogMenuItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!isOpen || !vendorId) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void fetchVendorBillCatalog(vendorId).then(({ items: rows, error }) => {
      if (cancelled) return;
      setItems(rows);
      setLoadFailed(error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, vendorId]);

  useEffect(() => {
    if (!isOpen) {
      setItems([]);
      setLoading(false);
      setLoadFailed(false);
    }
  }, [isOpen]);

  return (
    <div className="mb-3" data-testid="bill-menu-catalog">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
        {s.bill_catalogTitle}
      </p>
      {loading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p
          data-testid="bill-menu-catalog-empty"
          className="rounded-xl border border-dashed border-surface-border bg-surface/40 px-3 py-3 text-xs leading-snug text-muted-foreground"
        >
          {loadFailed ? s.bill_catalogLoadFailed : s.bill_catalogEmpty}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2 max-h-[min(28vh,11rem)] overflow-y-auto overscroll-contain pr-0.5">
          {items.map((item) => {
            const priceLabel =
              item.price > 0
                ? item.unit?.trim()
                  ? `₹${item.price}/${item.unit.trim()}`
                  : `₹${item.price}`
                : item.unit?.trim() || "";
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`bill-catalog-item-${item.id}`}
                onClick={() => onPick(item)}
                className={cn(
                  "rounded-xl border border-surface-border bg-surface px-3 py-2 text-left",
                  "active:border-brand active:bg-brand/10 transition-colors",
                  "min-w-[7.5rem] max-w-full",
                )}
              >
                <p className="text-sm font-medium text-foreground break-words leading-snug">
                  {item.name}
                </p>
                {priceLabel ? (
                  <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                    {priceLabel}
                  </p>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
