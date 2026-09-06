import { ExternalLink, FileText } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useLanguage } from "@/lib/language";

/** Single canonical policy; legal text is not duplicated in the React bundle. */
export const CANONICAL_TERMS_OF_SERVICE_URL =
  "https://aaspaaspro.com/terms-of-service.html";

const TermsOfService = () => {
  const { s } = useLanguage();
  const location = useLocation();
  const returnTo =
    (location.state as { returnTo?: string } | null)?.returnTo === "/settings"
      ? "/settings"
      : "/";

  return (
    <main className="min-h-screen bg-background text-foreground px-5 py-8 grid place-items-center">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center space-y-5">
        <FileText className="mx-auto h-10 w-10 text-primary" aria-hidden />
        <div className="space-y-2">
          <h1 className="font-display text-xl font-bold">{s.terms_of_service_title}</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {s.terms_of_service_canonical_note}
          </p>
        </div>
        <a
          href={CANONICAL_TERMS_OF_SERVICE_URL}
          data-testid="terms-of-service-canonical-link"
          className="w-full rounded-xl bg-brand text-brand-foreground px-4 h-12 font-semibold flex items-center justify-center gap-2"
        >
          {s.terms_of_service_open}
          <ExternalLink className="h-4 w-4" aria-hidden />
        </a>
        <Link
          to={returnTo}
          data-testid="terms-of-service-back-link"
          className="inline-block text-sm text-primary underline"
        >
          {returnTo === "/settings" ? s.terms_of_service_back_to_settings : s.not_found_home}
        </Link>
      </div>
    </main>
  );
};

export default TermsOfService;
