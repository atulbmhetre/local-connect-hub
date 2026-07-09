import { createContext, useContext, useEffect, useState } from 'react';
import { useAppConfig } from '@/hooks/useAppConfig';
import { type Language, strings } from './strings';

const STORAGE_KEY = 'aaspaas:language';

interface LanguageContextType {
  lang: Language;
  setLang: (l: Language) => void;
  s: typeof strings.en;
}

const LanguageContext = createContext<LanguageContextType>({
  lang: 'en',
  setLang: () => {},
  s: strings.en,
});

function readStoredLanguage(): Language {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'hi' || stored === 'mr' ? stored : 'en';
}

function resolveLanguage(
  candidate: Language,
  localizationEnabled: boolean,
  hindiEnabled: boolean,
  marathiEnabled: boolean,
): Language {
  if (!localizationEnabled) return 'en';
  if (candidate === 'hi' && !hindiEnabled) return 'en';
  if (candidate === 'mr' && !marathiEnabled) return 'en';
  return candidate;
}

export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
  const { config, loading } = useAppConfig();
  const [lang, setLangState] = useState<Language>('en');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (loading) return;

    const stored = readStoredLanguage();
    const resolved = resolveLanguage(
      stored,
      config.localizationEnabled,
      config.langHindiEnabled,
      config.langMarathiEnabled,
    );
    setLangState(resolved);
    if (config.localizationEnabled && resolved !== stored) {
      try {
        localStorage.setItem(STORAGE_KEY, resolved);
      } catch {
        /* ignore */
      }
    }
    setReady(true);
  }, [
    loading,
    config.localizationEnabled,
    config.langHindiEnabled,
    config.langMarathiEnabled,
  ]);

  useEffect(() => {
    if (!ready || loading) return;

    setLangState((prev) => {
      const next = resolveLanguage(
        prev,
        config.localizationEnabled,
        config.langHindiEnabled,
        config.langMarathiEnabled,
      );
      if (next !== prev) {
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  }, [
    ready,
    loading,
    config.localizationEnabled,
    config.langHindiEnabled,
    config.langMarathiEnabled,
  ]);

  const setLang = (l: Language) => {
    if (!config.localizationEnabled) return;
    if (l === 'hi' && !config.langHindiEnabled) return;
    if (l === 'mr' && !config.langMarathiEnabled) return;
    localStorage.setItem(STORAGE_KEY, l);
    setLangState(l);
  };

  const effectiveLang = ready ? lang : 'en';

  return (
    <LanguageContext.Provider
      value={{ lang: effectiveLang, setLang, s: strings[effectiveLang] as typeof strings.en }}
    >
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);
