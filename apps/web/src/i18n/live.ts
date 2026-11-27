/**
 * Words of the shared packages that are still English-only there, in the page's language. `liveWords` gives back an
 * object of the same shape whose strings are read from the web catalog at the moment they're used (`prefix.path`
 * keys, copied verbatim from the English source), and whose simple templates fill the catalog's `{placeholders}` with
 * their arguments. Anything without a key keeps the source's English. A language change draws the app's screens again
 * (`LanguageBoundary`), so every read picks the new language.
 */
import type { MessageVars } from '@whombat/core/i18n';
import { EN } from './en';
import {
  currentLocale,
  loadedDutch,
  type WebMessageKey,
  type WebTranslator,
  webTranslator,
} from './provider';

let cached: { tag: string; dutch: boolean; tr: WebTranslator } | null = null;

/** The web catalog's translator for the language the page shows now. */
export function liveTranslator(): WebTranslator {
  const tag = currentLocale() ?? 'en-GB';
  const dutch = loadedDutch() !== null;
  if (!cached || cached.tag !== tag || cached.dutch !== dutch)
    cached = { tag, dutch, tr: webTranslator(tag) };
  return cached.tr;
}

/** Translates a web catalog key in the page's language now (for code outside components). */
export function liveT(key: WebMessageKey, vars?: MessageVars): string {
  return liveTranslator().t(key, vars);
}

const hasKey = (key: string): key is WebMessageKey => Object.hasOwn(EN, key);

/**
 * The same words, read in the page's language. `params` names each template function's arguments in order, so
 * `(name) => \`Reply to ${name}…\`` reads the key's “Reply to {name}…”.
 */
export function liveWords<T extends object>(
  source: T,
  prefix: string,
  params: Readonly<Record<string, readonly string[]>> = {},
): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(source)) {
    const key = `${prefix}.${name}`;
    if (typeof value === 'string' && hasKey(key)) {
      Object.defineProperty(out, name, { enumerable: true, get: () => liveTranslator().t(key) });
    } else if (typeof value === 'function' && hasKey(key) && params[key]) {
      const names = params[key];
      out[name] = (...args: unknown[]) => {
        const vars: MessageVars = {};
        names.forEach((n, i) => {
          const arg = args[i];
          vars[n] = typeof arg === 'number' ? arg : String(arg);
        });
        return liveTranslator().t(key, vars);
      };
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = liveWords(value as object, key, params);
      Object.defineProperty(out, name, { enumerable: true, get: () => nested });
    } else {
      out[name] = value;
    }
  }
  return out as T;
}
