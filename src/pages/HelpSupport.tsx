import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Star } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { SettingsPageHeader, SettingsCard } from "@/components/settings/SettingsSection";
import { getDeviceId } from "@/lib/deviceId";
import { useLanguage } from "@/lib/language";
import {
  invokeNotifyAdmin,
  invokeSendSupportEmail,
  type SupportContactCategory,
} from "@/lib/supabase";
import { getUserPhone } from "@/lib/userIdentity";
import { cn } from "@/lib/utils";

const CONTACT_CATEGORIES: SupportContactCategory[] = [
  "payment",
  "account",
  "order",
  "vendor",
  "other",
];

const FAQ_ITEMS = [
  { q: "help_faq_q_find_vendor", a: "help_faq_a_find_vendor" },
  { q: "help_faq_q_trust_badges", a: "help_faq_a_trust_badges" },
  { q: "help_faq_q_register_vendor", a: "help_faq_a_register_vendor" },
  { q: "help_faq_q_khata", a: "help_faq_a_khata" },
  { q: "help_faq_q_restore_account", a: "help_faq_a_restore_account" },
  { q: "help_faq_q_pay_vendor", a: "help_faq_a_pay_vendor" },
  { q: "help_faq_q_missing_category", a: "help_faq_a_missing_category" },
  { q: "help_faq_q_referrals", a: "help_faq_a_referrals" },
] as const;

function categoryLabel(
  s: ReturnType<typeof useLanguage>["s"],
  cat: SupportContactCategory,
): string {
  switch (cat) {
    case "payment":
      return s.help_contact_category_payment;
    case "account":
      return s.help_contact_category_account;
    case "order":
      return s.help_contact_category_order;
    case "vendor":
      return s.help_contact_category_vendor;
    default:
      return s.help_contact_category_other;
  }
}

const HelpSupport = () => {
  const navigate = useNavigate();
  const { s } = useLanguage();
  const userPhone = (getUserPhone() ?? "").replace(/[\s\-+]/g, "").trim();
  const vendorId = (localStorage.getItem("aaspaas:vendor_id") ?? "").trim();
  const deviceId = getDeviceId();

  const [feedbackRating, setFeedbackRating] = useState(0);
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [feedbackSending, setFeedbackSending] = useState(false);
  const feedbackLockRef = useRef(false);

  const [contactCategory, setContactCategory] = useState<SupportContactCategory | "">("");
  const [contactMessage, setContactMessage] = useState("");
  const [contactSending, setContactSending] = useState(false);
  const contactLockRef = useRef(false);

  const identityLines = useMemo(() => {
    const lines: string[] = [];
    if (userPhone) lines.push(`${s.help_contact_identity_phone}: ${userPhone}`);
    if (vendorId) lines.push(`${s.help_contact_identity_vendor}: ${vendorId}`);
    return lines;
  }, [s, userPhone, vendorId]);

  const submitFeedback = async () => {
    if (feedbackLockRef.current) return;
    const message = feedbackMessage.trim();
    if (message.length < 3) {
      toast.error(s.help_message_required);
      return;
    }
    feedbackLockRef.current = true;
    setFeedbackSending(true);
    try {
      const result = await invokeSendSupportEmail({
        kind: "feedback",
        message,
        rating: feedbackRating > 0 ? feedbackRating : null,
        user_phone: userPhone || null,
        vendor_id: vendorId || null,
        device_id: deviceId || null,
      });
      if (!result.ok) {
        toast.error(s.help_feedback_error);
        return;
      }
      setFeedbackMessage("");
      setFeedbackRating(0);
      toast.success(s.help_feedback_success);
    } finally {
      feedbackLockRef.current = false;
      setFeedbackSending(false);
    }
  };

  const submitContact = async () => {
    if (contactLockRef.current) return;
    if (!contactCategory) {
      toast.error(s.help_category_required);
      return;
    }
    const message = contactMessage.trim();
    if (message.length < 3) {
      toast.error(s.help_message_required);
      return;
    }
    contactLockRef.current = true;
    setContactSending(true);
    try {
      const result = await invokeSendSupportEmail({
        kind: "contact",
        category: contactCategory,
        message,
        user_phone: userPhone || null,
        vendor_id: vendorId || null,
        device_id: deviceId || null,
      });
      if (!result.ok) {
        toast.error(s.help_contact_error);
        return;
      }

      const catLabel = categoryLabel(s, contactCategory);
      const who = userPhone || vendorId || "unknown";
      const adminTitle = `Support: ${catLabel}`.slice(0, 100);
      const adminBody = `${who}: ${message}`.slice(0, 100);
      void invokeNotifyAdmin(adminTitle, adminBody, {
        type: "support_contact",
        route: "settings",
        route_params: {
          ...(userPhone ? { phone: userPhone } : {}),
          ...(vendorId ? { vendor_id: vendorId } : {}),
          category: contactCategory,
        },
      });

      setContactMessage("");
      setContactCategory("");
      toast.success(s.help_contact_success);
    } finally {
      contactLockRef.current = false;
      setContactSending(false);
    }
  };

  return (
    <AppShell>
      <div className="space-y-3 pb-24" data-testid="help-support-screen">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => navigate("/settings")}
            className="h-10 w-10 shrink-0 grid place-items-center rounded-full border border-surface-border bg-surface active:scale-95"
            aria-label={s.help_support_back}
            data-testid="help-support-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <SettingsPageHeader title={s.help_support_title} subtitle={s.help_support_subtitle} />
          </div>
        </div>

        <section className="space-y-2" data-testid="help-faq-section">
          <h2 className="text-xs font-bold uppercase tracking-widest text-brand">
            {s.help_faq_heading}
          </h2>
          <SettingsCard>
            <Accordion type="single" collapsible className="w-full px-4" data-testid="help-faq-accordion">
              {FAQ_ITEMS.map((item, idx) => (
                <AccordionItem key={item.q} value={item.q} data-testid={`help-faq-item-${idx}`}>
                  <AccordionTrigger
                    className="text-sm text-left font-medium text-foreground hover:no-underline"
                    data-testid={`help-faq-trigger-${idx}`}
                  >
                    {s[item.q]}
                  </AccordionTrigger>
                  <AccordionContent
                    className="text-sm text-muted-foreground leading-relaxed"
                    data-testid={`help-faq-content-${idx}`}
                  >
                    {s[item.a]}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </SettingsCard>
        </section>

        <section className="space-y-2" data-testid="help-feedback-section">
          <h2 className="text-xs font-bold uppercase tracking-widest text-brand">
            {s.help_feedback_heading}
          </h2>
          <p className="text-xs text-muted-foreground">{s.help_feedback_hint}</p>
          <SettingsCard>
            <div className="px-4 py-4 space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">{s.help_feedback_rating_label}</p>
                <div className="flex gap-1" data-testid="help-feedback-stars">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      data-testid={`help-feedback-star-${n}`}
                      aria-label={`${n}`}
                      onClick={() => setFeedbackRating((cur) => (cur === n ? 0 : n))}
                      className="p-1 active:scale-95"
                    >
                      <Star
                        className={cn(
                          "h-7 w-7",
                          n <= feedbackRating
                            ? "fill-amber-400 text-amber-400"
                            : "text-muted-foreground",
                        )}
                      />
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="help-feedback-message" className="text-sm font-medium text-foreground">
                  {s.help_feedback_message_label}
                </label>
                <textarea
                  id="help-feedback-message"
                  data-testid="help-feedback-message"
                  value={feedbackMessage}
                  onChange={(e) => setFeedbackMessage(e.target.value)}
                  rows={4}
                  maxLength={4000}
                  placeholder={s.help_feedback_message_placeholder}
                  className="w-full rounded-xl border border-surface-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground resize-none"
                />
              </div>
              <button
                type="button"
                data-testid="help-feedback-submit"
                disabled={feedbackSending}
                onClick={() => void submitFeedback()}
                className="w-full rounded-xl bg-brand text-page-bg h-12 text-sm font-semibold active:scale-[0.99] disabled:opacity-50"
              >
                {feedbackSending ? s.help_feedback_sending : s.help_feedback_submit}
              </button>
            </div>
          </SettingsCard>
        </section>

        <section className="space-y-2" data-testid="help-contact-section">
          <h2 className="text-xs font-bold uppercase tracking-widest text-brand">
            {s.help_contact_heading}
          </h2>
          <p className="text-xs text-muted-foreground">{s.help_contact_hint}</p>
          <SettingsCard>
            <div className="px-4 py-4 space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">{s.help_contact_category_label}</p>
                <div className="flex flex-wrap gap-2" data-testid="help-contact-categories">
                  {CONTACT_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      data-testid={`help-contact-category-${cat}`}
                      onClick={() => setContactCategory(cat)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-xs font-semibold active:scale-95",
                        contactCategory === cat
                          ? "border-brand bg-brand/10 text-brand"
                          : "border-surface-border text-foreground",
                      )}
                    >
                      {categoryLabel(s, cat)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-surface-border bg-muted/30 px-3 py-2.5 space-y-1">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {s.help_contact_identity_label}
                </p>
                {identityLines.length > 0 ? (
                  identityLines.map((line) => (
                    <p key={line} className="text-sm text-foreground tabular-nums break-all">
                      {line}
                    </p>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">{s.help_contact_identity_none}</p>
                )}
              </div>
              <div className="space-y-2">
                <label htmlFor="help-contact-message" className="text-sm font-medium text-foreground">
                  {s.help_contact_message_label}
                </label>
                <textarea
                  id="help-contact-message"
                  data-testid="help-contact-message"
                  value={contactMessage}
                  onChange={(e) => setContactMessage(e.target.value)}
                  rows={4}
                  maxLength={4000}
                  placeholder={s.help_contact_message_placeholder}
                  className="w-full rounded-xl border border-surface-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground resize-none"
                />
              </div>
              <button
                type="button"
                data-testid="help-contact-submit"
                disabled={contactSending}
                onClick={() => void submitContact()}
                className="w-full rounded-xl bg-brand text-page-bg h-12 text-sm font-semibold active:scale-[0.99] disabled:opacity-50"
              >
                {contactSending ? s.help_contact_sending : s.help_contact_submit}
              </button>
            </div>
          </SettingsCard>
        </section>
      </div>
    </AppShell>
  );
};

export default HelpSupport;
