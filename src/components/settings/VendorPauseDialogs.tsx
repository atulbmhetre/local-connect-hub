import { Link } from "react-router-dom";
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { StringBundle } from "@/lib/strings";
import {
  fillPauseTemplate,
  formatPauseAmount,
  shouldShowPauseLedgerNote,
  subscriptionPauseBlockMessage,
  type VendorPausePreflight,
} from "@/lib/vendorPauseUi";

const INCOMING_HREF = "/vendor#vendor-incoming-orders";

export function VendorPauseBlockedSheet({
  open,
  onOpenChange,
  kind,
  preflight,
  s,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "open_work" | "subscription";
  preflight: VendorPausePreflight | null;
  s: StringBundle;
}) {
  const counts = preflight?.open_work ?? { help: 0, delivery: 0, appointment: 0 };
  const rows: Array<{ key: "help" | "delivery" | "appointment"; label: string; count: number }> = [
    { key: "help", label: s.vendor_pause_open_work_help, count: counts.help },
    { key: "delivery", label: s.vendor_pause_open_work_delivery, count: counts.delivery },
    { key: "appointment", label: s.vendor_pause_open_work_appointment, count: counts.appointment },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl px-4 pb-8 pt-6"
        data-testid="vendor-pause-blocked-sheet"
      >
        <SheetHeader className="text-left space-y-2 pr-8">
          <SheetTitle data-testid="vendor-pause-blocked-title">
            {kind === "open_work"
              ? s.vendor_pause_open_work_title
              : s.vendor_pause_blocked_subscription}
          </SheetTitle>
        </SheetHeader>
        {kind === "open_work" ? (
          <div className="mt-4 space-y-3" data-testid="vendor-pause-open-work-body">
            <p className="text-sm text-foreground">{s.vendor_pause_open_work_serve}</p>
            <ul className="space-y-2">
              {rows
                .filter((row) => row.count > 0)
                .map((row) => (
                  <li key={row.key}>
                    <Link
                      to={INCOMING_HREF}
                      data-testid={`vendor-pause-open-work-link-${row.key}`}
                      className="flex items-center justify-between rounded-xl border border-border px-3 py-2.5 text-sm font-medium text-brand"
                      onClick={() => onOpenChange(false)}
                    >
                      <span>{row.label}</span>
                      <span data-testid={`vendor-pause-open-work-count-${row.key}`}>{row.count}</span>
                    </Link>
                  </li>
                ))}
            </ul>
          </div>
        ) : (
          <p className="mt-4 text-sm text-foreground" data-testid="vendor-pause-subscription-body">
            {subscriptionPauseBlockMessage(preflight?.subscription_status, s)}
          </p>
        )}
        <button
          type="button"
          className="mt-6 w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground"
          data-testid="vendor-pause-blocked-dismiss"
          onClick={() => onOpenChange(false)}
        >
          {s.vendor_pause_got_it}
        </button>
      </SheetContent>
    </Sheet>
  );
}

export function VendorPauseConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  confirming,
  preflight,
  s,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  confirming: boolean;
  preflight: VendorPausePreflight | null;
  s: StringBundle;
}) {
  const n = preflight?.pause_min_credit_days ?? 7;
  const note = fillPauseTemplate(s.vendor_pause_note, { N: n });
  const showLedger = preflight ? shouldShowPauseLedgerNote(preflight) : false;
  const ledger = showLedger && preflight
    ? fillPauseTemplate(s.vendor_pause_ledger_note, {
        amount: formatPauseAmount(preflight.khata.pending_amount),
        count: preflight.khata.customer_count,
      })
    : null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className="rounded-2xl border border-border bg-card"
        data-testid="vendor-pause-confirm-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{s.vendor_pause_confirm_title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground text-left">
              <p data-testid="vendor-pause-confirm-note">{note}</p>
              {ledger && (
                <p data-testid="vendor-pause-confirm-ledger">{ledger}</p>
              )}
              {preflight?.will_freeze_billing && (
                <p data-testid="vendor-pause-confirm-billing">{s.vendor_pause_billing_freeze}</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
          <AlertDialogCancel className="mt-0" data-testid="vendor-pause-confirm-cancel">
            {s.cancel}
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="vendor-pause-confirm-action"
            disabled={confirming}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {s.vendor_pause_confirm_action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
