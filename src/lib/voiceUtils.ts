export function getVoiceLang(): string {
  const lang = localStorage.getItem("aaspaas:lang") ?? "en";
  const map: Record<string, string> = {
    en: "en-IN",
    hi: "hi-IN",
    mr: "mr-IN",
  };
  return map[lang] ?? "en-IN";
}
