/**
 * Validates every co-located i18n catalog in the repository:
 * - 100% EN <-> target key parity (missing or extra keys)
 * - Exact `{placeholder}` parity across strings and every plural form
 * - Complete CLDR plural categories per language via `Intl.PluralRules`
 * - No empty strings or leftover TODO markers
 * - Source-hash staleness check against `scripts/i18n/source-hashes.json`
 *
 * Usage:
 *   pnpm exec tsx scripts/i18n/check.ts
 *   pnpm exec tsx scripts/i18n/check.ts --update-hashes
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractPlaceholders,
  type MessageValue,
  type PluralCategory,
  type PluralMessage,
  type SupportedLanguage,
  sourceHash,
} from '../../packages/core/src/i18n/index';
import { type CatalogEntry, loadCatalogs } from './registry';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HASHES_FILE = resolve(HERE, 'source-hashes.json');

export interface CatalogCheckResult {
  errors: string[];
  totalKeys: number;
  catalogCount: number;
  hashes: Record<string, string>;
}

function requiredPluralCategories(lang: SupportedLanguage): readonly PluralCategory[] {
  try {
    const cats = new Intl.PluralRules(lang).resolvedOptions().pluralCategories as PluralCategory[];
    return cats.includes('other') ? cats : [...cats, 'other'];
  } catch {
    return ['one', 'other'];
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function checkMessageValue(
  label: string,
  enVal: MessageValue,
  trVal: MessageValue,
  lang: SupportedLanguage,
  errors: string[],
): void {
  const enIsPlural = typeof enVal === 'object' && enVal !== null;
  const trIsPlural = typeof trVal === 'object' && trVal !== null;
  if (enIsPlural !== trIsPlural) {
    errors.push(`${label}: plural/string mismatch between en and ${lang}`);
    return;
  }
  if (!enIsPlural) {
    const enStr = enVal as string;
    const trStr = trVal as string;
    if (!enStr.trim()) errors.push(`${label} [en]: empty message`);
    if (!trStr.trim()) errors.push(`${label} [${lang}]: empty translation`);
    if (/\bTODO\b/i.test(trStr)) errors.push(`${label} [${lang}]: contains TODO marker`);
    const enVars = extractPlaceholders(enStr);
    const trVars = extractPlaceholders(trStr);
    if (!sameSet(enVars, trVars)) {
      errors.push(`${label} [${lang}]: placeholders {${trVars.join(', ')}} != en {${enVars.join(', ')}}`);
    }
    return;
  }

  const enPlural = enVal as PluralMessage;
  const trPlural = trVal as PluralMessage;
  const enVars = extractPlaceholders(enPlural.other);
  const enCats = requiredPluralCategories('en');
  for (const cat of enCats) {
    const text = enPlural[cat];
    if (typeof text !== 'string' || !text.trim()) {
      errors.push(`${label} [en]: missing plural form "${cat}"`);
    }
  }
  const trCats = requiredPluralCategories(lang);
  for (const cat of trCats) {
    const text = trPlural[cat];
    if (typeof text !== 'string' || !text.trim()) {
      errors.push(`${label} [${lang}]: missing plural form "${cat}"`);
      continue;
    }
    if (/\bTODO\b/i.test(text)) errors.push(`${label} [${lang}.${cat}]: contains TODO marker`);
    const vars = extractPlaceholders(text);
    // Count placeholder (`n` / `count`) may be omitted in `one` ("1 item" vs "een item"), but no unknown placeholders allowed.
    for (const v of vars) {
      if (!enVars.includes(v)) {
        errors.push(`${label} [${lang}.${cat}]: unknown placeholder {${v}} not in en {${enVars.join(', ')}}`);
      }
    }
    if (cat === 'other' && !sameSet(enVars, vars)) {
      errors.push(`${label} [${lang}.other]: placeholders {${vars.join(', ')}} != en {${enVars.join(', ')}}`);
    }
  }
}

export function validateCatalogs(
  entries: readonly CatalogEntry[],
  storedHashes: Readonly<Record<string, string>> | null,
): CatalogCheckResult {
  const errors: string[] = [];
  const hashes: Record<string, string> = {};
  let totalKeys = 0;

  for (const entry of entries) {
    const enKeys = Object.keys(entry.en).sort();
    totalKeys += enKeys.length;
    for (const key of enKeys) {
      const enVal = entry.en[key];
      if (enVal === undefined) continue;
      const hashKey = `${entry.name}:${key}`;
      const currentHash = sourceHash(enVal);
      hashes[hashKey] = currentHash;
      if (storedHashes) {
        if (!Object.hasOwn(storedHashes, hashKey)) {
          errors.push(
            `${hashKey}: missing from scripts/i18n/source-hashes.json; run pnpm exec tsx scripts/i18n/check.ts --update-hashes`,
          );
        } else if (storedHashes[hashKey] !== currentHash) {
          errors.push(
            `${hashKey}: English source changed (stored ${storedHashes[hashKey]}, now ${currentHash}); review translations and run pnpm exec tsx scripts/i18n/check.ts --update-hashes`,
          );
        }
      }
    }

    for (const [lang, catalog] of Object.entries(entry.locales) as Array<
      [Exclude<SupportedLanguage, 'en'>, CatalogEntry['en']]
    >) {
      const trKeys = Object.keys(catalog).sort();
      const enSet = new Set(enKeys);
      const trSet = new Set(trKeys);
      for (const k of enKeys) {
        if (!trSet.has(k)) errors.push(`${entry.name}:${k} [${lang}]: missing key`);
      }
      for (const k of trKeys) {
        if (!enSet.has(k)) errors.push(`${entry.name}:${k} [${lang}]: extra key not present in en`);
      }
      for (const k of enKeys) {
        const enVal = entry.en[k];
        const trVal = catalog[k];
        if (enVal === undefined || trVal === undefined) continue;
        checkMessageValue(`${entry.name}:${k}`, enVal, trVal, lang, errors);
      }
    }
  }

  for (const key of Object.keys(storedHashes ?? {})) {
    if (!Object.hasOwn(hashes, key)) {
      errors.push(
        `${key}: orphan key in scripts/i18n/source-hashes.json; run pnpm exec tsx scripts/i18n/check.ts --update-hashes`,
      );
    }
  }

  return { errors, totalKeys, catalogCount: entries.length, hashes };
}

export async function checkAllCatalogs(
  options: { updateHashes?: boolean } = {},
): Promise<CatalogCheckResult> {
  const entries = await loadCatalogs();
  const stored: Record<string, string> | null =
    !options.updateHashes && existsSync(HASHES_FILE)
      ? (JSON.parse(readFileSync(HASHES_FILE, 'utf8')) as Record<string, string>)
      : null;
  const result = validateCatalogs(entries, stored);
  if (options.updateHashes) {
    const sorted = Object.fromEntries(Object.entries(result.hashes).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(HASHES_FILE, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const updateHashes = process.argv.includes('--update-hashes');
  const res = await checkAllCatalogs({ updateHashes });
  if (res.errors.length > 0) {
    console.error(`i18n check failed with ${res.errors.length} error(s):`);
    for (const e of res.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `i18n check ok: ${res.catalogCount} catalog(s), ${res.totalKeys} key(s)${updateHashes ? ' (hashes updated)' : ''}.`,
  );
}
