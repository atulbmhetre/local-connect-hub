import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";

export function ReferralRedirect() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    if (code) {
      try {
        localStorage.setItem("aaspaas:referral_code", code.toUpperCase());
      } catch {}
    }
    // Redirect to home
    navigate("/", { replace: true });
  }, [code, navigate]);

  return null;
}
