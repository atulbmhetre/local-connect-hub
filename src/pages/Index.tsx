import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { SOSButton } from "@/components/SOSButton";
import { CategoryPicker } from "@/components/CategoryPicker";
import { Mic, Search } from "lucide-react";
import { toast } from "sonner";

// 6 essential emergency tiles shown when the search bar is empty.
const QUICK_ASSIST: { label: string; emoji: string }[] = [
  { label: "Tyre / Mechanic", emoji: "🛞" },
  { label: "Ambulance", emoji: "🚑" },
  { label: "Key Maker", emoji: "🔑" },
  { label: "Medical", emoji: "🩺" },
  { label: "Electrician", emoji: "💡" },
  { label: "Plumber", emoji: "🔧" },
];

const Index = () => {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);

  useEffect(() => {
    if (!localStorage.getItem("aaspaas:role")) {
      localStorage.setItem("aaspaas:role", "user");
    }
  }, []);

  // Navigate to the dedicated Radar screen with the search term in the URL.
  // Keeps Home as a pure entry point and lets Radar own all fetch/rank logic.
  const goToRadar = (term: string) => {
    const t = term.trim();
    navigate(t ? `/radar?q=${encodeURIComponent(t)}` : "/radar");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const term = query.trim();
    if (!term) {
      setPickerOpen(true);
      return;
    }
    goToRadar(term);
  };

  const handleSOS = () => {
    const term = query.trim();
    if (term) goToRadar(term);
    else goToRadar("");
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
      goToRadar(transcript);
    };
    recRef.current = rec;
    rec.start();
  };

  return (
    <AppShell theme="light">
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
          placeholder="Search for help (e.g., Mechanic, Ambulance, Key Maker)"
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

      <section className="mb-4 animate-fade-up">
          <p className="text-xs uppercase tracking-[0.25em] text-muted-foreground text-center mb-3">
            Quick Assist
          </p>
          <div className="grid grid-cols-3 gap-3">
            {QUICK_ASSIST.map((q) => (
              <button
                key={q.label}
                onClick={() => goToRadar(q.label)}
                className="aspect-square rounded-2xl bg-card hover:bg-muted active:scale-95 transition-all flex flex-col items-center justify-center gap-1.5 border border-border shadow-card"
              >
                <span className="text-3xl">{q.emoji}</span>
                <span className="font-semibold text-[11px] text-center px-1 leading-tight">
                  {q.label}
                </span>
              </button>
            ))}
          </div>
        </section>

      <CategoryPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(cat) => {
          setPickerOpen(false);
          goToRadar(cat);
        }}
        onMic={startVoice}
      />
    </AppShell>
  );
};

export default Index;
