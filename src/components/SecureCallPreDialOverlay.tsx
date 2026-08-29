import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/language";

type Props = {
  /** predial = before initiate-call; ringing = after bridge accepted */
  phase: "predial" | "ringing";
};

/** Full-screen overlay shown before/during Exotel secure-call bridge setup. */
export function SecureCallPreDialOverlay({ phase }: Props) {
  const { s } = useLanguage();
  const title =
    phase === "predial" ? s.secure_call_predial_title : s.secure_call_phone_ringing;
  const body =
    phase === "predial" ? s.secure_call_predial_body : s.secure_call_phone_ringing_body;

  return (
    <div
      className="fixed inset-0 z-50 bg-page-bg/90 backdrop-blur-sm flex flex-col items-center justify-center gap-4 px-6 text-center"
      data-testid="secure-call-predial-overlay"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-10 w-10 animate-spin text-brand" aria-hidden />
      <p className="text-base font-semibold text-brand">{title}</p>
      <p className="text-sm text-muted-foreground leading-relaxed max-w-sm">{body}</p>
    </div>
  );
}
