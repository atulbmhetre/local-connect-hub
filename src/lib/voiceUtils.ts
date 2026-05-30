export function getVoiceLang(): string {
  const voiceLang = localStorage.getItem("aaspaas:voice_lang");
  if (!voiceLang || voiceLang === "auto") return "en-IN";
  if (voiceLang === "en-IN" || voiceLang === "hi-IN" || voiceLang === "mr-IN") {
    return voiceLang;
  }
  return "en-IN";
}
