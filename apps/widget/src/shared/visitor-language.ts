export type LanguagePreferences = Pick<Navigator, 'language' | 'languages'>;

export function supportedVisitorLanguage(value: string | null | undefined): string | undefined {
  const tag = value?.trim().replace(/_/g, '-').toLowerCase();
  if (tag === 'pseudo') return tag;
  if (!tag || !/^(en|nl)(-|$)/.test(tag)) return undefined;
  try {
    const [locale] = Intl.getCanonicalLocales(tag);
    return locale?.endsWith('-XA') ? 'pseudo' : locale;
  } catch {
    return undefined;
  }
}

export function browserLanguage(navigator: LanguagePreferences): string {
  for (const value of navigator.languages ?? []) {
    const tag = supportedVisitorLanguage(value);
    if (tag) return tag;
  }
  return supportedVisitorLanguage(navigator.language) ?? 'en';
}
