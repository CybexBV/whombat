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
    lines.push(`msgctxt ${JSON.stringify(key)}`);
    if (typeof src === 'string') {
      lines.push(`msgid ${JSON.stringify(src)}`);
      lines.push(`msgstr ${JSON.stringify(typeof dst === 'string' ? dst : '')}`);
    } else {
      const pSrc = src as PluralMessage;
      const pDst = typeof dst === 'object' && dst !== null ? (dst as PluralMessage) : undefined;
      lines.push(`msgid ${JSON.stringify(pSrc.one ?? pSrc.other)}`);
      lines.push(`msgid_plural ${JSON.stringify(pSrc.other)}`);
      lines.push(`msgstr[0] ${JSON.stringify(pDst?.one ?? '')}`);
      lines.push(`msgstr[1] ${JSON.stringify(pDst?.other ?? '')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Parses a gettext PO file into a catalog keyed by message context or, when absent, by message ID. */
export function parsePo(text: string): Catalog {
  const out = new Map<string, MessageValue>();
  const fields = new Map<string, string>();
  let active: string | undefined;
  const finish = () => {
    const key = fields.get('msgctxt') ?? fields.get('msgid');
    const singular = fields.get('msgstr');
    const one = fields.get('msgstr[0]');
    const other = fields.get('msgstr[1]');
    if (key && fields.has('msgid_plural') && other !== undefined) {
      out.set(key, { ...(one !== undefined ? { one } : {}), other });
    } else if (key && singular !== undefined) {
      out.set(key, singular);
    }
    fields.clear();
    active = undefined;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      finish();
      continue;
    }
    const [, field, value] = /^(msgctxt|msgid|msgid_plural|msgstr(?:\[[0-9]+\])?)\s+(".*")$/.exec(line) ?? [];
    if (field && value !== undefined) {
      if ((field === 'msgctxt' || field === 'msgid') && fields.has('msgid')) finish();
      active = field;
      fields.set(field, JSON.parse(value) as string);
    } else if (active && /^".*"$/.test(line)) {
      fields.set(active, (fields.get(active) ?? '') + (JSON.parse(line) as string));
    }
  }
  finish();
  return Object.fromEntries(out);
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
