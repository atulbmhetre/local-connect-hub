import { Radar as RadarIcon } from "lucide-react";

export const Radar = ({ label = "Scanning your area..." }: { label?: string }) => (
  <div className="flex flex-col items-center gap-6 py-10">
    <div className="relative h-56 w-56">
      <div className="radar-sweep" />
      <div className="radar-ring" />
      <div className="radar-ring" style={{ animationDelay: "0.7s" }} />
      <div className="radar-ring" style={{ animationDelay: "1.4s" }} />
      <div className="absolute inset-0 grid place-items-center">
        <div className="h-16 w-16 rounded-full bg-gradient-sos grid place-items-center shadow-glow">
          <RadarIcon className="h-7 w-7 text-primary-foreground" />
        </div>
      </div>
    </div>
    <p className="text-sm font-medium text-muted-foreground tracking-wide uppercase">{label}</p>
  </div>
);
