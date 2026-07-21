import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { recordUserReferralDetailed } from "@/lib/referral";
import { getDeviceId } from "@/lib/deviceId";
import { useLanguage } from "@/lib/language";

export function ReferralRedirect() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { s } = useLanguage();

  useEffect(() => {
    void (async () => {
      if (code) {
        try {
          localStorage.setItem("aaspaas:referral_code", code.toUpperCase());
        } catch {
          /* ignore */
        }
      }

      const existingPhone = localStorage.getItem("aaspaas:user_phone")?.trim();
      if (existingPhone && code) {
        const outcome = await recordUserReferralDetailed(existingPhone, getDeviceId());
        if (outcome === "applied") {
          toast.success(s.referral_applied_existing_user);
        } else if (outcome === "error") {
          toast.error(s.referral_apply_failed);
        }
        // "not_applied" (invalid/duplicate code) stays silent — nothing actionable.
      }

      navigate("/", { replace: true });
    })();
  }, [code, navigate, s.referral_applied_existing_user, s.referral_apply_failed]);

  return (
    <div className="min-h-screen bg-page-bg flex flex-col items-center justify-center gap-3">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
      <p className="text-sm text-muted-foreground">{s.settings_loading}</p>
    </div>
  );
}
