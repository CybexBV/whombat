import {
  DEFAULT_LOCALE,
  LANGUAGE_DEFAULT_LOCALE,
  LANGUAGE_NATIVE_NAMES,
  normalizeLocaleTag,
  resolveDisplayLanguage,
  resolvePreferredLocale,
} from '@whombat/core/i18n';
import type { KeyValueStore } from '../lib/kv';

export function deviceLocale(read = () => Intl.DateTimeFormat().resolvedOptions().locale): string {
  try {
    const tag = read();
    return resolveDisplayLanguage(tag) === 'pseudo' ? 'pseudo' : resolvePreferredLocale([tag]);
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function boxLocale(tag: string | null | undefined): string {
  if (resolveDisplayLanguage(tag) === 'pseudo') return tag ?? DEFAULT_LOCALE;
  return resolvePreferredLocale([normalizeLocaleTag(tag)]);
}

function localeKey(scope: string): string {
  const encoded = Array.from(scope, (char) => char.codePointAt(0)?.toString(16));
  return `whombat.locale.${encoded.join('.')}`;
}

export async function readBoxLocale(store: KeyValueStore, scope: string): Promise<string | null> {
  const tag = await store.get(localeKey(scope)).catch(() => null);
  return tag === null ? null : boxLocale(tag);
}

export async function saveBoxLocale(store: KeyValueStore, scope: string, tag: string): Promise<void> {
  await store.set(localeKey(scope), tag).catch(() => {});
}

export const MOBILE_LANGUAGES = [
  { value: LANGUAGE_DEFAULT_LOCALE.en, title: LANGUAGE_NATIVE_NAMES.en },
  { value: LANGUAGE_DEFAULT_LOCALE.nl, title: LANGUAGE_NATIVE_NAMES.nl },
] as const;
