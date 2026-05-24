import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useLanguage } from "@/lib/language";

type Props = {
  vendorId: string;
  initialNote: string | null;
  onSaved: (newNote: string) => void;
};

export function VendorNoteEditor({ vendorId, initialNote, onSaved }: Props) {
  const { s } = useLanguage();
  const [note, setNote] = useState(initialNote ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setNote(initialNote ?? "");
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
    toast.success(s.vendor_note_saved);
  };

  return (
    <div className="space-y-1 mt-4">
      <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {s.vendor_note_customers}
      </label>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, 100))}
        rows={2}
        placeholder={s.vendor_note_edit_placeholder}
        className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
      />
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-muted-foreground">{note.length}/100</p>
        <button
          type="button"
          onClick={() => void saveNote()}
          disabled={saving}
          className="text-xs font-semibold text-brand hover:underline disabled:opacity-50"
        >
          {saving ? s.vendor_saving : s.vendor_save_note}
        </button>
      </div>
    </div>
  );
}
