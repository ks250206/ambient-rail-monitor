import { useSyncExternalStore } from 'react';

export type Locale = 'ja' | 'en';

const STORAGE_KEY = 'railflow:locale';
const listeners = new Set<() => void>();

function readInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'ja';
  try {
    const param = new URLSearchParams(window.location.search).get('lang');
    if (param === 'en' || param === 'ja') {
      window.localStorage.setItem(STORAGE_KEY, param);
      return param;
    }
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'ja') return saved;
  } catch {
    // Ignore storage access errors in restricted environments.
  }
  return 'ja';
}

let currentLocale: Locale = readInitialLocale();

function applyDocumentLocale(locale: Locale) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.documentElement.dataset.locale = locale;
}

applyDocumentLocale(currentLocale);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    const next = event.newValue === 'en' ? 'en' : 'ja';
    if (next === currentLocale) return;
    currentLocale = next;
    applyDocumentLocale(currentLocale);
    for (const listener of listeners) listener();
  });
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(next: Locale) {
  if (next === currentLocale) return;
  currentLocale = next;
  applyDocumentLocale(currentLocale);
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Ignore storage access errors.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLocale(): [Locale, (next: Locale) => void] {
  const locale = useSyncExternalStore<Locale>(subscribe, getLocale, () => 'ja');
  return [locale, setLocale];
}

export function pickText(locale: Locale, ja: string, en: string): string {
  return locale === 'en' ? en : ja;
}

export function useI18n() {
  const [locale, updateLocale] = useLocale();
  const pick = (ja: string, en: string) => (locale === 'en' ? en : ja);
  return { locale, setLocale: updateLocale, pick };
}
