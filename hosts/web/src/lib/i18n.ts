// Translations. The English text is the key: t(text) returns the
// Dutch text from src/locales/nl.ts when the interface language is Dutch,
// else the English text itself (a missing translation falls back to
// English). {name} placeholders are filled from `vars`.
//
// The language is the one chosen in the account menu (stored per browser),
// else the browser's preference. Changing it reloads the page. Texts the
// hub writes (alert titles, hints, errors) stay English.

import { createElement, Fragment, type ReactNode } from 'react';
import { nl } from '../locales/nl';

export type Lang = 'en' | 'nl';

const KEY = 'rackoon-lang';
export const LANG_LABEL: Record<Lang, string> = { en: 'English', nl: 'Nederlands' };

function stored(): Lang | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'en' || v === 'nl' ? v : null;
  } catch {
    return null;
  }
}

function detect(): Lang {
  const s = stored();
  if (s) return s;
  const prefs = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
  for (const p of prefs) {
    const l = p.toLowerCase();
    if (l.startsWith('nl')) return 'nl';
    if (l.startsWith('en')) return 'en';
  }
  return 'en';
}

/** The interface language, fixed for the page's lifetime. */
export const LANG: Lang = detect();
/** BCP 47 locale for Intl formatters. */
export const LOCALE = LANG === 'nl' ? 'nl-NL' : 'en-US';

const catalog: Record<string, string> = LANG === 'nl' ? nl : {};

if (typeof document !== 'undefined') document.documentElement.lang = LANG;

/** The catalog text, else the English key without its `|context` marker. */
function lookup(text: string): string {
  return catalog[text] ?? text.replace(/\|\w+$/, '');
}

/**
 * Translate an English text; `{name}` placeholders are replaced from vars.
 * When one English text needs two Dutch texts, a key may end in a context
 * marker that never shows: t('Shut down|done') is "Afgesloten" in Dutch and
 * "Shut down" in English.
 */
export function t(text: string, vars?: Record<string, string | number>): string {
  const out = lookup(text);
  if (!vars) return out;
  return out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Count-dependent text: the `one` text when n is 1, else `many`; {n} is filled with n. */
export function tn(n: number, one: string, many: string, vars?: Record<string, string | number>): string {
  return t(n === 1 ? one : many, { n, ...vars });
}

/** Like t(), with React nodes (a link, <b>, <code>) for the placeholders: a sentence keeps its word order. */
export function tx(text: string, nodes: Record<string, ReactNode>): ReactNode {
  const out = lookup(text);
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of out.matchAll(/\{(\w+)\}/g)) {
    parts.push(out.slice(last, m.index));
    parts.push(m[1]! in nodes ? nodes[m[1]!] : m[0]);
    last = m.index + m[0].length;
  }
  parts.push(out.slice(last));
  return createElement(Fragment, null, ...parts.filter((p) => p !== ''));
}

/** Choose a language (null: follow the browser) and reload. */
export function setLang(l: Lang | null): void {
  try {
    if (l) localStorage.setItem(KEY, l);
    else localStorage.removeItem(KEY);
  } catch {
    // private mode: nothing to remember
  }
  window.location.reload();
}

/** The language after `l` in the account menu's cycle. */
export function nextLang(l: Lang): Lang {
  return l === 'en' ? 'nl' : 'en';
}
