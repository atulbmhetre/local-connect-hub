import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";
import { useCategoryLabel } from "@/lib/supabase";
import {
  resolveKhataTxBusinessChip,
  type KhataTxBusinessChip,
} from "@/lib/khataDisplay";

type Tx = {
  request_id?: string | null;
  category_label?: string | null;
  category_emoji?: string | null;
  payment_mode: string;
};

/** Radar-style chip: business label, or plain Payment / Refund (no false attribution). */
export function KhataTxSourceChip({
  tx,
  className,
}: {
  tx: Tx;
  className?: string;
}) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const chip = resolveKhataTxBusinessChip(tx);
  return <KhataTxSourceChipView chip={chip} getLabel={getLabel} s={s} className={className} />;
}

export function KhataTxSourceChipView({
  chip,
  getLabel,
  s,
  className,
}: {
  chip: KhataTxBusinessChip;
  getLabel: (label: string) => string;
  s: {
    khata_tx_payment: string;
    khata_tx_refund: string;
  };
  className?: string;
}) {
  if (chip.kind === "none") return null;

  const text =
    chip.kind === "business"
      ? getLabel(chip.label)
      : chip.kind === "payment"
        ? s.khata_tx_payment
        : s.khata_tx_refund;

  return (
    <span
      data-testid="khata-tx-source-chip"
      data-chip-kind={chip.kind}
      data-category-label={chip.kind === "business" ? chip.label : undefined}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] shrink-0",
        "border border-surface-border bg-surface text-muted-foreground font-medium",
        chip.kind === "business" && "border-brand/40 bg-brand/10 text-foreground",
        className,
      )}
    >
      {chip.kind === "business" ? (
        <>
          <span aria-hidden>{chip.emoji}</span>
          <span className="truncate max-w-[10rem]">{text}</span>
        </>
      ) : (
        <span>{text}</span>
      )}
    </span>
  );
}
