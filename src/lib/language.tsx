import { createContext, useContext, useEffect, useState } from 'react';
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

export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
  const [lang, setLangState] = useState<Language>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return (stored === 'hi' || stored === 'mr') ? stored : 'en';
  });

  const setLang = (l: Language) => {
    localStorage.setItem(STORAGE_KEY, l);
    setLangState(l);
  };

  return (
    <LanguageContext.Provider value={{ lang, setLang, s: strings[lang] }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);
