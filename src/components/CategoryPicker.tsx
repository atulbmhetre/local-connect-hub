import { type Category, useCategoryLabel } from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { Mic, X } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  onPick: (category: string) => void;
  onMic: () => void;
  categories: Category[];
};

export const CategoryPicker = ({ open, onClose, onPick, onMic, categories }: Props) => {
  const { s } = useLanguage();
  const getCategoryLabel = useCategoryLabel();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-foreground/60 backdrop-blur-sm grid place-items-end sm:place-items-center animate-fade-in">
      <div className="w-full sm:max-w-md bg-card rounded-t-3xl sm:rounded-3xl p-6 pb-8 shadow-card animate-fade-up">
        <div className="flex items-center justify-between mb-6">
          <div>
            <p className="text-xs uppercase tracking-widest text-muted-foreground">
              {s.category_picker_quick_help}
            </p>
            <h2 className="font-display text-2xl font-bold">{s.category_picker_title}</h2>
          </div>
          <button onClick={onClose} className="h-10 w-10 rounded-full bg-muted grid place-items-center">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => onPick(c.label)}
              className="aspect-square rounded-2xl bg-muted hover:bg-accent/30 active:scale-95 transition-all flex flex-col items-center justify-center gap-2 border border-border"
            >
              <span className="text-4xl">{c.emoji}</span>
              <span className="font-semibold text-sm text-center px-2 leading-tight">
                {getCategoryLabel(c.label)}
              </span>
            </button>
          ))}
        </div>

        <button
          onClick={onMic}
          className="mt-4 w-full rounded-2xl bg-gradient-sos text-primary-foreground py-4 flex items-center justify-center gap-2 font-semibold shadow-sos active:scale-[0.98]"
        >
          <Mic className="h-5 w-5" />
          {s.category_picker_speak_else}
        </button>
      </div>
    </div>
  );
};
