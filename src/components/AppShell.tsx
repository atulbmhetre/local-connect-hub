import { ReactNode } from "react";
import { APP_COLUMN_CLASS } from "@/lib/appColumn";
import { BottomNav } from "./BottomNav";

type Props = {
  children: ReactNode;
  /** @deprecated Theme is controlled globally via ThemeProvider / Settings. */
  theme?: "light" | "dark";
};

export const AppShell = ({ children }: Props) => {
  return (
    <div className="min-h-screen pb-24">
      <div className={`${APP_COLUMN_CLASS} px-5 pt-8`}>{children}</div>
      <BottomNav />
    </div>
  );
};
