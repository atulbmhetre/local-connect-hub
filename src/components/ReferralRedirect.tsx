import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { recordUserReferral } from "@/lib/referral";
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
        const applied = await recordUserReferral(existingPhone, getDeviceId());
        if (applied) {
          toast.success(s.referral_applied_existing_user);
        }
      }

      navigate("/", { replace: true });
    })();
  }, [code, navigate, s.referral_applied_existing_user]);

  return null;
}
