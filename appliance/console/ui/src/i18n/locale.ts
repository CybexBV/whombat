export const DEFAULT_LOCALE = 'en-GB';
export type InstallerLocale = 'en-GB' | 'nl-NL';

export function localeTag(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 35 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value))
    return undefined;
  return value;
}

function language(tag: string): string {
  return tag.toLowerCase().split('-')[0] ?? '';
}

export function browserLocale(languages: readonly string[]): string {
  return (
    languages.map(localeTag).find((tag) => tag && ['en', 'nl'].includes(language(tag))) ?? DEFAULT_LOCALE
  );
}

export function resolveLocale(tag: string | undefined): string {
  if (tag === 'pseudo') return tag;
  if (tag && ['en', 'nl'].includes(language(tag))) {
    try {
      const [canonical] = Intl.getCanonicalLocales(tag);
      return canonical === 'en'
        ? DEFAULT_LOCALE
        : canonical === 'nl'
          ? 'nl-NL'
          : (canonical ?? DEFAULT_LOCALE);
    } catch {
      return DEFAULT_LOCALE;
    }
  }
  return DEFAULT_LOCALE;
}

export const formatLocale = (locale: string): string => (locale === 'pseudo' ? DEFAULT_LOCALE : locale);
export const isDutch = (locale: string): boolean => language(locale) === 'nl';
