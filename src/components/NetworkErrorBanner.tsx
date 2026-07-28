import { Loader2, WifiOff } from "lucide-react";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";

type NetworkErrorBannerProps = {
  status: "retrying" | "failed" | "timeout";
  onRetry?: () => void;
  className?: string;
  /** Override the default failed/timeout copy (e.g. radar categories). */
  message?: string;
};

export function NetworkErrorBanner({
  status,
  onRetry,
  className,
  message,
}: NetworkErrorBannerProps) {
  const { s } = useLanguage();

  if (status === "retrying") {
    return (
      <div
        className={cn(
          "mb-4 rounded-2xl bg-muted/60 border border-border p-4 flex gap-3 items-start",
          className,
        )}
        role="status"
      >
        <Loader2 className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5 animate-spin" aria-hidden />
        <p className="text-sm text-muted-foreground">{s.network_retrying}</p>
      </div>
    );
  }

  const body =
    message ??
    (status === "timeout" ? s.network_timeout : s.network_failed);

  return (
    <div
      className={cn(
        "mb-4 rounded-2xl bg-destructive/10 border border-destructive/30 p-4 flex gap-3 items-start",
        className,
      )}
      role="alert"
      data-network-status={status}
    >
      <WifiOff className="h-5 w-5 text-destructive shrink-0 mt-0.5" aria-hidden />
      <div className="min-w-0 flex-1 space-y-3">
        <p className="text-sm text-destructive">{body}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-xl bg-card border border-border px-4 py-2 text-sm font-semibold active:scale-[0.98]"
          >
            {s.network_retry_btn}
          </button>
        )}
      </div>
    </div>
  );
}
