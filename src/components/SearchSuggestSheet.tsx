import { useState } from "react";
import { type ClassifySearchCandidate, useCategoryLabel } from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { APP_COLUMN_CLASS } from "@/lib/appColumn";
import { desktopBottomSheetClass, desktopSheetOverlayClass } from "@/lib/desktopShell";
import { Input } from "@/components/ui/input";

/** Tier 1 shows the top candidates; "None of these" reveals the rest (≤10 total). */
export const SUGGEST_TIER1_COUNT = 5;

type Props = {
  open: boolean;
  /** The user's original free-text search, shown verbatim throughout. */
  searchText: string;
  candidates: ClassifySearchCandidate[];
  tier: 1 | 2;
  /** Both tiers rejected — show the rephrase input instead of candidates. */
  rephrasing: boolean;
  onPick: (candidate: ClassifySearchCandidate) => void;
  onNone: () => void;
  onRephrase: (text: string) => void;
  onClose: () => void;
};

export const SearchSuggestSheet = ({
  open,
  searchText,
  candidates,
  tier,
  rephrasing,
  onPick,
  onNone,
  onRephrase,
  onClose,
}: Props) => {
  const { s } = useLanguage();
  const getCategoryLabel = useCategoryLabel();
  const [rephraseText, setRephraseText] = useState("");
  if (!open) return null;

  const visible = tier === 1 ? candidates.slice(0, SUGGEST_TIER1_COUNT) : candidates;

  const submitRephrase = () => {
    const t = rephraseText.trim();
    if (!t) return;
    setRephraseText("");
    onRephrase(t);
  };

  return (
    <div
      data-testid="search-suggest-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="search-suggest-title"
      className={cn(
        "fixed inset-0 z-50 bg-foreground/60 backdrop-blur-sm grid place-items-end sm:place-items-center animate-fade-in",
        desktopSheetOverlayClass(),
      )}
    >
      <div
        className={cn(
          APP_COLUMN_CLASS,
          desktopBottomSheetClass(),
          "max-h-[90vh] overflow-y-auto bg-card rounded-t-3xl sm:rounded-3xl p-6 pb-8 shadow-card animate-fade-up",
        )}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">
              {s.home_suggest_you_searched}
            </p>
            <p
              data-testid="search-suggest-original-text"
              className="font-semibold text-sm text-foreground break-words"
            >
              “{searchText}”
            </p>
          </div>
          <button
            onClick={onClose}
            data-testid="search-suggest-close"
            className="h-10 w-10 rounded-full bg-muted grid place-items-center shrink-0 ml-3"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {rephrasing ? (
          <div>
            <p className="text-sm text-muted-foreground mb-3 leading-relaxed">
              {s.home_suggest_rephrase_prompt}
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitRephrase();
              }}
            >
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  data-testid="search-suggest-rephrase-input"
                  value={rephraseText}
                  onChange={(e) => setRephraseText(e.target.value)}
                  placeholder={s.home_suggest_rephrase_placeholder}
                  autoFocus
                  className="bg-muted/50 border-border pl-10 pr-3"
                />
              </div>
              <button
                type="submit"
                data-testid="search-suggest-rephrase-submit"
                className="mt-3 w-full rounded-2xl bg-gradient-sos text-primary-foreground h-12 flex items-center justify-center gap-2 font-semibold shadow-sos active:scale-[0.98]"
              >
                <Search className="h-5 w-5" />
                {s.home_suggest_rephrase_submit}
              </button>
            </form>
          </div>
        ) : (
          <>
            <h2 id="search-suggest-title" className="font-display text-xl font-bold mb-4">
              {s.home_suggest_title}
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {visible.map((c) => (
                <button
                  key={c.label}
                  data-testid="search-suggest-option"
                  onClick={() => onPick(c)}
                  className="rounded-2xl bg-muted hover:bg-accent/30 active:scale-95 transition-all flex flex-col items-center justify-center gap-2 border border-border py-4 px-2"
                >
                  <span className="text-3xl">{c.emoji}</span>
                  <span className="font-semibold text-sm text-center leading-tight">
                    {getCategoryLabel(c.label)}
                  </span>
                </button>
              ))}
            </div>
            <button
              data-testid="search-suggest-none"
              onClick={onNone}
              className="mt-4 w-full rounded-2xl bg-muted border border-border text-foreground h-12 font-semibold active:scale-[0.98]"
            >
              {s.home_suggest_none}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
