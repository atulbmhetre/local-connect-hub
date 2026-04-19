import { Siren } from "lucide-react";

export const SOSButton = ({ onClick }: { onClick: () => void }) => (
  <button
    onClick={onClick}
    aria-label="Emergency SOS"
    className="sos-pulse relative h-44 w-44 rounded-full bg-gradient-sos shadow-sos active:scale-95 transition-transform grid place-items-center"
  >
    <div className="flex flex-col items-center gap-1 text-primary-foreground">
      <Siren className="h-12 w-12" strokeWidth={2.5} />
      <span className="font-display text-3xl font-bold tracking-wider">SOS</span>
      <span className="text-[10px] uppercase tracking-[0.2em] opacity-90">Tap for help</span>
    </div>
  </button>
);
