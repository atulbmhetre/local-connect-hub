type Props = {
  label: string;
  previewUrl: string | null;
  onPick: (file: File) => void;
};

/** File input with optional preview — matches Local Feed announcement picker. */
export function FeedImagePicker({ label, previewUrl, onPick }: Props) {
  return (
    <div>
      <label className="block text-xs font-semibold text-muted-foreground mb-2">{label}</label>
      <input
        type="file"
        accept="image/*"
        className="text-sm w-full text-foreground"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
        }}
      />
      {previewUrl && (
        <img
          src={previewUrl}
          alt=""
          className="mt-3 w-full rounded-xl border border-border object-cover max-h-48"
        />
      )}
    </div>
  );
}
