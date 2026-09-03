import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { submitAppNotifyLead } from "@/lib/appNotifyLead";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";

const SUBMITTED_KEY = "aaspaas:app_notify_lead";

function readSubmitted(): boolean {
  try {
    return localStorage.getItem(SUBMITTED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSubmitted(): void {
  try {
    localStorage.setItem(SUBMITTED_KEY, "1");
  } catch {
    /* ignore quota / private mode */
  }
}

export function GetTheAppCard() {
  const { s } = useLanguage();
  const [contact, setContact] = useState("");
  const [submitted, setSubmitted] = useState(readSubmitted);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<"invalid" | "error" | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setError(null);
    const result = await submitAppNotifyLead(contact);
    setSending(false);
    if (result.ok === false) {
      setError(result.reason);
      return;
    }
    writeSubmitted();
    setSubmitted(true);
  };

  return (
    <div
      data-testid="get-the-app-card"
      className="sticky top-8 max-w-sm rounded-2xl border border-surface-border bg-surface p-5"
    >
      <h2 className="font-display text-lg font-bold text-foreground leading-tight">
        {s.get_app_heading}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground leading-snug">
        {s.get_app_subtext}
      </p>
      {submitted ? (
        <p
          data-testid="get-the-app-success"
          className="mt-4 text-sm text-foreground leading-snug"
        >
          {s.get_app_success}
        </p>
      ) : (
        <form className="mt-4 space-y-3" onSubmit={(e) => void onSubmit(e)}>
          <Input
            data-testid="get-the-app-contact"
            type="text"
            inputMode="email"
            autoComplete="email"
            value={contact}
            onChange={(e) => {
              setContact(e.target.value);
              if (error) setError(null);
            }}
            placeholder={s.get_app_placeholder}
            aria-label={s.get_app_placeholder}
            disabled={sending}
          />
          {error ? (
            <p
              data-testid="get-the-app-error"
              className="text-xs text-destructive leading-snug"
            >
              {error === "invalid" ? s.get_app_invalid : s.get_app_error}
            </p>
          ) : null}
          <Button
            type="submit"
            data-testid="get-the-app-submit"
            disabled={sending}
            className={cn(
              "w-full rounded-xl bg-brand font-semibold text-[#0b1f14]",
              "hover:bg-brand/90",
            )}
          >
            {s.get_app_notify}
          </Button>
        </form>
      )}
    </div>
  );
}
