import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
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

export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
  const [lang, setLangState] = useState<Language>('en');
  const [localizationEnabled, setLocalizationEnabled] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'localization_enabled')
        .maybeSingle();

      if (cancelled) return;

      const enabled = data?.value?.trim().toLowerCase() !== 'false';
      setLocalizationEnabled(enabled);
      setLangState(enabled ? readStoredLanguage() : 'en');
      setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const setLang = (l: Language) => {
    if (!localizationEnabled) return;
    localStorage.setItem(STORAGE_KEY, l);
    setLangState(l);
  };

  const effectiveLang = ready ? lang : 'en';

  return (
    <LanguageContext.Provider
      value={{ lang: effectiveLang, setLang, s: strings[effectiveLang] }}
    >
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);
