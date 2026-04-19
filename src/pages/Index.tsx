import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { SOSButton } from "@/components/SOSButton";
import { CategoryPicker } from "@/components/CategoryPicker";
import { Radar } from "@/components/Radar";
import { VendorCard } from "@/components/VendorCard";
import { supabase, type Vendor } from "@/lib/supabase";
import { Mic, Search, AlertCircle } from "lucide-react";
import { toast } from "sonner";

// Web Speech API typing
type SR = typeof window extends { SpeechRecognition: infer T } ? T : any;

const Index = () => {
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Vendor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);

  useEffect(() => {
    if (!localStorage.getItem("aaspaas:role")) {
      localStorage.setItem("aaspaas:role", "user");
    }
  }, []);

  const runSearch = async (term: string) => {
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      // small delay so the radar feels alive
      await new Promise((r) => setTimeout(r, 700));
      const { data, error } = await supabase
        .from("vendors")
        .select("*")
        .eq("is_active", true)
        .or(`category.ilike.%${term}%,shop_name.ilike.%${term}%,name.ilike.%${term}%`)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      setResults((data ?? []) as Vendor[]);
    } catch (e: any) {
      setError(e.message ?? "Connection Error");
    } finally {
      setSearching(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const term = query.trim();
    if (!term) {
      setPickerOpen(true);
      return;
    }
    runSearch(term);
  };

  const handleSOS = () => {
    if (query.trim()) runSearch(query.trim());
    else setPickerOpen(true);
  };

  const startVoice = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast.error("Voice not supported on this browser. Try Chrome on Android.");
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = "en-IN";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => setListening(true);
    rec.onerror = () => {
      setListening(false);
      toast.error("Couldn't hear that. Try again.");
    };
    rec.onend = () => setListening(false);
    rec.onresult = (ev: any) => {
      const transcript = ev.results[0][0].transcript;
      setQuery(transcript);
      setPickerOpen(false);
      runSearch(transcript);
    };
    recRef.current = rec;
    rec.start();
  };

  return (
    <AppShell>
      <header className="text-center mb-6 animate-fade-up">
        <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Aaspaas Pro</p>
        <h1 className="font-display text-3xl font-bold mt-1">Help, around you. Now.</h1>
        <p className="text-sm text-muted-foreground mt-1">
          The smart switchboard for your neighbourhood.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="relative mb-8">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Try "Gajar Halwa" or "Tyre"'
          className="w-full bg-card border border-border rounded-2xl pl-12 pr-14 py-4 text-base shadow-card focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <button
          type="button"
          onClick={startVoice}
          aria-label="Voice search"
          className={`absolute right-2 top-1/2 -translate-y-1/2 h-10 w-10 rounded-xl grid place-items-center transition-colors ${
            listening ? "bg-primary text-primary-foreground animate-pulse" : "bg-muted text-foreground"
          }`}
        >
          <Mic className="h-5 w-5" />
        </button>
      </form>

      <div className="flex justify-center mb-8">
        <SOSButton onClick={handleSOS} />
      </div>

      <p className="text-center text-xs text-muted-foreground -mt-4 mb-6">
        Empty SOS opens quick categories. Type or speak to filter.
      </p>

      {searching && <Radar />}

      {!searching && results && results.length > 0 && (
        <section className="space-y-3 pb-4">
          <h2 className="font-display text-xl font-bold">Available now</h2>
          {results.map((v) => (
            <VendorCard key={v.id} vendor={v} />
          ))}
        </section>
      )}

      {!searching && results && results.length === 0 && !error && (
        <div className="rounded-2xl border border-dashed border-border p-6 text-center">
          <p className="font-display text-lg font-semibold">No active professionals</p>
          <p className="text-sm text-muted-foreground mt-1">
            No one is "Ready to Help" for that right now. Try another category.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-2xl bg-destructive/10 border border-destructive/30 p-5 flex gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-destructive">Connection Error</p>
            <p className="text-sm text-muted-foreground mt-0.5 break-words">{error}</p>
          </div>
        </div>
      )}

      <CategoryPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(cat) => {
          setPickerOpen(false);
          setQuery(cat);
          runSearch(cat);
        }}
        onMic={startVoice}
      />
    </AppShell>
  );
};

export default Index;
