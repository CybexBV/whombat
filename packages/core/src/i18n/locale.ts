/** Languages Whombat ships UI and assistant translations for. */
export const SUPPORTED_LANGUAGES = ['en', 'nl'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export type SupportedLanguage = Language;

/** Languages the runtime engine can render, including the dev/QA pseudo-locale. */
export type DisplayLanguage = Language | 'pseudo';

/**
 * BCP-47 locale tag (`en-GB`, `nl-NL`, `nl`, `de-DE`). Anchored pure-ASCII regex matching the
 * cross-language contract subset so Go and JSON Schema validate it identically.
 */
export const LOCALE_TAG_RE = /^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?$/;

/** Whether a tag is a valid BCP-47 tag of the contract's subset (2–35 characters, `LOCALE_TAG_RE`). */
export function isLocaleTag(tag: string): boolean {
  return tag.length >= 2 && tag.length <= 35 && LOCALE_TAG_RE.test(tag);
}

export const DEFAULT_LANGUAGE: Language = 'en';
export const DEFAULT_LOCALE = 'en-GB';

/** Default BCP-47 formatting locale for each supported language (en-GB keeps day-first dates). */
export const LANGUAGE_DEFAULT_LOCALE: Record<Language, string> = {
  en: 'en-GB',
  nl: 'nl-NL',
};

/** Self-names shown in language pickers regardless of the active UI language. */
export const LANGUAGE_NATIVE_NAMES: Record<Language, string> = {
  en: 'English',
  nl: 'Nederlands',
};

/** Normalizes a raw BCP-47 tag (e.g. `nl_nl` -> `nl-NL`, `en` -> `en-GB`), or null when invalid. */
export function normalizeLocaleTag(tag: string | null | undefined): string | null {
  if (typeof tag !== 'string' || !tag) return null;
  const trimmed = tag.trim().replace(/_/g, '-');
  if (!trimmed || !LOCALE_TAG_RE.test(trimmed)) return null;
  const parts = trimmed.split('-');
  const lang = (parts[0] ?? '').toLowerCase();
  if (parts.length === 1) {
    if (isSupportedLanguage(lang)) return LANGUAGE_DEFAULT_LOCALE[lang];
    return lang;
  }
  const normalized = [
    lang,
    ...parts.slice(1).map((sub, idx) => {
      if (sub.length === 4 && idx === 0) return sub.charAt(0).toUpperCase() + sub.slice(1).toLowerCase();
      if (sub.length === 2) return sub.toUpperCase();
      return sub.toLowerCase();
    }),
  ].join('-');
  return isLocaleTag(normalized) ? normalized : null;
}

function isSupportedLanguage(primary: string | undefined): primary is Language {
  return SUPPORTED_LANGUAGES.some((language) => language === primary);
}

/** Resolves any BCP-47 locale tag to a supported Whombat language (`en` or `nl`). */
export function resolveLanguage(tag: string | null | undefined): Language {
  if (typeof tag !== 'string' || !tag) return DEFAULT_LANGUAGE;
  const primary = tag.trim().replace(/_/g, '-').split('-')[0]?.toLowerCase();
  return isSupportedLanguage(primary) ? primary : DEFAULT_LANGUAGE;
}

/** Resolves a tag including the dev/QA `'pseudo'` locale (`pseudo` or `en-XA` / `nl-XA`). */
export function resolveDisplayLanguage(tag: string | null | undefined): DisplayLanguage {
  if (typeof tag !== 'string' || !tag) return DEFAULT_LANGUAGE;
  const clean = tag.trim().replace(/_/g, '-').toLowerCase();
  if (clean === 'pseudo' || clean.endsWith('-xa')) return 'pseudo';
  return resolveLanguage(clean);
}

/** Picks the first supported language from an ordered preference list (e.g. `navigator.languages`). */
export function resolvePreferredLanguage(tags: readonly (string | null | undefined)[]): Language {
  for (const raw of tags) {
    if (typeof raw !== 'string' || !raw) continue;
    const primary = raw.trim().replace(/_/g, '-').split('-')[0]?.toLowerCase();
    if (isSupportedLanguage(primary)) return primary;
  }
  return DEFAULT_LANGUAGE;
}

/** Picks the best BCP-47 locale tag from an ordered preference list. */
export function resolvePreferredLocale(tags: readonly (string | null | undefined)[]): string {
  for (const raw of tags) {
    if (typeof raw !== 'string' || !raw) continue;
    const primary = raw.trim().replace(/_/g, '-').split('-')[0]?.toLowerCase();
    if (isSupportedLanguage(primary)) return normalizeLocaleTag(raw) ?? LANGUAGE_DEFAULT_LOCALE[primary];
  }
  return DEFAULT_LOCALE;
}

/** Returns the BCP-47 locale used for Intl number/date formatting (en-GB for English, nl-NL for Dutch). */
export function formatLocaleOf(tag: string | null | undefined): string {
  if (typeof tag !== 'string' || !tag) return DEFAULT_LOCALE;
  const clean = tag.trim().replace(/_/g, '-');
  if (clean.toLowerCase() === 'pseudo' || clean.toLowerCase().endsWith('-xa')) return DEFAULT_LOCALE;
  const lang = resolveLanguage(clean);
  const fallback = LANGUAGE_DEFAULT_LOCALE[lang];
  if ((clean.split('-')[0] ?? '').toLowerCase() !== lang) return fallback;
  const candidate = normalizeLocaleTag(clean);
  if (!candidate) return fallback;
  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? fallback;
  } catch {
    return fallback;
  }
}

/** Safely parses a possibly-unknown locale tag from persisted/restored data without rejecting the record. */
export function safeLocaleOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return normalizeLocaleTag(raw);
}
