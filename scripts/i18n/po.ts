/**
 * Translator export/import for Whombat's co-located catalogs (docs/decisions/i18n.md I18N-02).
 *
 * Exports every registered catalog to standard gettext `.po` (with `#: catalog:key` references,
 * `#. context` translator notes, and CLDR plural `msgid_plural` / `msgstr[n]`) and flat `.json`
 * so external translators never need to edit TypeScript.
 *
 * Usage:
 *   pnpm exec tsx scripts/i18n/po.ts export nl ./tmp/po
 *   pnpm exec tsx scripts/i18n/po.ts export-json nl ./tmp/json
 *   pnpm exec tsx scripts/i18n/po.ts parse ./tmp/po/web.po
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Catalog,
  MessageValue,
  PluralMessage,
  SupportedLanguage,
} from '../../packages/core/src/i18n/index';
import { type CatalogEntry, loadCatalogs } from './registry';

function escapePo(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function unescapePo(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

export function serializePo(entry: CatalogEntry, lang: Exclude<SupportedLanguage, 'en'>): string {
  const target = entry.locales[lang] ?? {};
  const lines: string[] = [
    'msgid ""',
    'msgstr ""',
    `"Project-Id-Version: Whombat (${entry.name})\\n"`,
    `"Language: ${lang}\\n"`,
    '"MIME-Version: 1.0\\n"',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    '"Content-Transfer-Encoding: 8bit\\n"',
    '"Plural-Forms: nplurals=2; plural=(n != 1);\\n"',
    '',
  ];

  for (const key of Object.keys(entry.en).sort()) {
    const src = entry.en[key];
    if (src === undefined) continue;
    const dst = target[key];
    const ctx = entry.context?.[key];
    if (ctx) lines.push(`#. ${ctx.replace(/\s+/g, ' ').trim()}`);
    lines.push(`#: ${entry.name}:${key}`);
    lines.push(`msgctxt "${escapePo(key)}"`);
    if (typeof src === 'string') {
      lines.push(`msgid "${escapePo(src)}"`);
      lines.push(`msgstr "${escapePo(typeof dst === 'string' ? dst : '')}"`);
    } else {
      const pSrc = src as PluralMessage;
      const pDst = typeof dst === 'object' && dst !== null ? (dst as PluralMessage) : undefined;
      lines.push(`msgid "${escapePo(pSrc.one ?? pSrc.other)}"`);
      lines.push(`msgid_plural "${escapePo(pSrc.other)}"`);
      lines.push(`msgstr[0] "${escapePo(pDst?.one ?? '')}"`);
      lines.push(`msgstr[1] "${escapePo(pDst?.other ?? '')}"`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Parses a `.po` file produced by `serializePo` back into a declarative Catalog map. */
export function parsePo(text: string): Catalog {
  const out: Record<string, MessageValue> = {};
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    let key: string | null = null;
    let singular: string | null = null;
    let plural0: string | null = null;
    let plural1: string | null = null;
    let hasPlural = false;
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      const mCtx = /^msgctxt "(.*)"$/.exec(line);
      if (mCtx?.[1] !== undefined) key = unescapePo(mCtx[1]);
      if (line.startsWith('msgid_plural ')) hasPlural = true;
      const mStr = /^msgstr "(.*)"$/.exec(line);
      if (mStr?.[1] !== undefined) singular = unescapePo(mStr[1]);
      const m0 = /^msgstr\[0\] "(.*)"$/.exec(line);
      if (m0?.[1] !== undefined) plural0 = unescapePo(m0[1]);
      const m1 = /^msgstr\[1\] "(.*)"$/.exec(line);
      if (m1?.[1] !== undefined) plural1 = unescapePo(m1[1]);
    }
    if (!key) continue;
    if (hasPlural && plural1 !== null) {
      out[key] = { ...(plural0 !== null ? { one: plural0 } : {}), other: plural1 };
    } else if (singular !== null) {
      out[key] = singular;
    }
  }
  return out;
}

export function serializeFlatJson(entry: CatalogEntry, lang: Exclude<SupportedLanguage, 'en'>): string {
  const target = entry.locales[lang] ?? {};
  const bundle: Record<string, { en: MessageValue; translation: MessageValue | null; context?: string }> = {};
  for (const key of Object.keys(entry.en).sort()) {
    const src = entry.en[key];
    if (src === undefined) continue;
    const ctx = entry.context?.[key];
    bundle[key] = {
      en: src,
      translation: target[key] ?? null,
      ...(ctx ? { context: ctx } : {}),
    };
  }
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  if (cmd === 'export' || cmd === 'export-json') {
    const lang = (arg1 ?? 'nl') as Exclude<SupportedLanguage, 'en'>;
    const outDir = resolve(arg2 ?? `.tmp-i18n-${lang}`);
    mkdirSync(outDir, { recursive: true });
    const entries = await loadCatalogs();
    for (const entry of entries) {
      const ext = cmd === 'export' ? 'po' : 'json';
      const content = cmd === 'export' ? serializePo(entry, lang) : serializeFlatJson(entry, lang);
      writeFileSync(join(outDir, `${entry.name}.${ext}`), content, 'utf8');
    }
    console.log(`Exported ${entries.length} catalog(s) for "${lang}" to ${outDir}`);
  } else if (cmd === 'parse' && arg1) {
    const parsed = parsePo(readFileSync(resolve(arg1), 'utf8'));
    console.log(JSON.stringify(parsed, null, 2));
  } else {
    console.error('Usage: po.ts export <lang> <outDir> | export-json <lang> <outDir> | parse <file.po>');
    process.exit(1);
  }
}
