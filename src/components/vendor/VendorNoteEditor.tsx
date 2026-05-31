import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";

type Props = {
  vendorId: string;
  initialNote: string | null;
  onSaved: (newNote: string) => void;
  showLabel?: boolean;
  className?: string;
};

export function VendorNoteEditor({
  vendorId,
  initialNote,
  onSaved,
  showLabel = true,
  className,
}: Props) {
  const { s } = useLanguage();
  const [note, setNote] = useState(initialNote ?? "");
  const [saving, setSaving] = useState(false);
  const [noteChanged, setNoteChanged] = useState(false);

  useEffect(() => {
    setNote(initialNote ?? "");
    setNoteChanged(false);
  }, [initialNote]);

  const saveNote = async () => {
    setSaving(true);
    const trimmed = note.trim();
    const { error } = await supabase
      .from("vendors")
      .update({ vendor_note: trimmed || null })
      .eq("id", vendorId);
    setSaving(false);
    if (error) {
      toast.error(s.vendor_note_save_failed, { description: error.message });
      return;
    }
    onSaved(trimmed);
    setNoteChanged(false);
    toast.success(s.vendor_note_saved);
  };

  return (
    <div className={cn("space-y-1", showLabel && "mt-4", className)}>
      {showLabel && (
        <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {s.vendor_note_customers}
        </label>
      )}
      <textarea
        value={note}
        onChange={(e) => {
          setNote(e.target.value.slice(0, 100));
          setNoteChanged(true);
        }}
        rows={2}
        placeholder={s.vendor_note_edit_placeholder}
        className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
      />
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] text-muted-foreground">{note.length}/100</p>
        <button
          type="button"
          onClick={() => void saveNote()}
          disabled={!noteChanged || saving}
          className="text-xs font-semibold text-brand hover:underline disabled:opacity-50"
        >
          {saving ? s.vendor_saving : s.vendor_save_note}
        </button>
      </div>
    </div>
  );
}
