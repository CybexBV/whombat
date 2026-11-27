import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceHash } from '../../packages/core/src/i18n/engine';
import { checkAllCatalogs, validateCatalogs } from './check';
import { lintLiterals } from './lint-literals';
import { parsePo, serializePo } from './po';
import { loadCatalogs } from './registry';

describe('i18n catalogs', () => {
  it('validates all 8 co-located catalogs for key, placeholder, CLDR plural and source-hash parity', async () => {
    const result = await checkAllCatalogs();
    expect(result.catalogCount).toBe(8);
    expect(result.totalKeys).toBeGreaterThan(5000);
    expect(result.errors).toEqual([]);
  });

  it('catches missing keys, placeholder mismatches, plural omissions and stale source hashes', () => {
    const res = validateCatalogs(
      [
        {
          name: 'sample',
          en: {
            greeting: 'Hello {name}',
            items: { one: '{n} item', other: '{n} items' },
            missing: 'Only in English',
          },
          locales: {
            nl: {
              greeting: 'Hallo {who}',
              items: { other: '{n} items' },
              extra: 'Alleen in Nederlands',
            },
          },
        },
      ],
      { 'sample:greeting': '000000000000' },
    );
    expect(res.errors.some((e) => e.includes('missing key'))).toBe(true);
    expect(res.errors.some((e) => e.includes('extra key'))).toBe(true);
    expect(res.errors.some((e) => e.includes('placeholders'))).toBe(true);
    expect(res.errors.some((e) => e.includes('missing plural form "one"'))).toBe(true);
    expect(res.errors.some((e) => e.includes('English source changed'))).toBe(true);
  });

  it('hashes each message once and catches orphan hashes', () => {
    const en = { item: 'Hello', items: { one: '{n} item', other: '{n} items' } };
    const nl = { item: 'Hallo', items: { one: '{n} stuk', other: '{n} stuks' } };
    const stored = {
      'sample:item': sourceHash(en.item),
      'sample:items': sourceHash(en.items),
      'sample:removed': sourceHash('Removed'),
      'removed:item': sourceHash('Removed too'),
    };
    const { errors } = validateCatalogs([{ name: 'sample', en, locales: { nl } }], stored);
    expect(errors).toEqual([
      expect.stringContaining('sample:removed: orphan key'),
      expect.stringContaining('removed:item: orphan key'),
    ]);
  });

  it('round-trips every catalog cleanly through PO export and import', async () => {
    for (const entry of await loadCatalogs()) {
      expect(parsePo(serializePo(entry, 'nl')), entry.name).toEqual(entry.locales.nl);
    }
  });

  it('round-trips messages with newlines, quotes and literal backslashes', () => {
    const en = {
      message: 'First line\nSecond line',
      items: { one: '{n} item\nClick to open', other: '{n} items\nClick to open' },
    };
    const nl = {
      message: 'Eerste regel\nTweede regel met "aanhalingstekens" en \\n',
      items: { one: '{n} stuk\nKlik om te openen', other: '{n} stuks\nKlik om te openen' },
    };
    expect(parsePo(serializePo({ name: 'sample', en, locales: { nl } }, 'nl'))).toEqual(nl);
  });

  it('collects gettext continuation lines for message IDs and translations', () => {
    const po = String.raw`msgid ""
msgstr ""
"Language: nl\n"

msgid ""
"First line\n"
"Second line"
msgstr ""
"Eerste regel\n"
"Tweede regel"

msgctxt ""
"sample."
"items"
msgid ""
"{n} item\n"
"Click to open"
msgid_plural ""
"{n} items\n"
"Click to open"
msgstr[0] ""
"{n} stuk\n"
"Klik om te openen"
msgstr[1] ""
"{n} stuks\n"
"Klik om te openen"
`;
    expect(parsePo(po.replaceAll('\n', '\r\n'))).toEqual({
      'First line\nSecond line': 'Eerste regel\nTweede regel',
      'sample.items': { one: '{n} stuk\nKlik om te openen', other: '{n} stuks\nKlik om te openen' },
    });
  });
});

describe('i18n literal lint', () => {
  it('requires a baseline and only permits literal counts at or below it', () => {
    const root = mkdtempSync(join(tmpdir(), 'literal-lint-'));
    const baselinePath = join(root, 'baseline.json');
    const scanDirs = ['src'];
    const opts = { root, baselinePath, scanDirs };
    const literal = '<span>This is visible copy</span>';
    try {
      mkdirSync(join(root, 'src'));
      const existing = join(root, 'src', 'existing.tsx');
      const added = join(root, 'src', 'added.tsx');
      writeFileSync(existing, literal);
      expect(lintLiterals(opts).errors).toEqual([expect.stringContaining('--update-baseline')]);
      expect(existsSync(baselinePath)).toBe(false);

      expect(lintLiterals({ ...opts, updateBaseline: true }).current).toEqual({ 'src/existing.tsx': 1 });
      expect(lintLiterals(opts).errors).toEqual([]);

      writeFileSync(existing, `${literal}\n${literal}`);
      writeFileSync(added, literal);
      expect(lintLiterals(opts).errors).toEqual([
        expect.stringContaining('src/added.tsx: 1 hardcoded string(s) (baseline 0)'),
        expect.stringContaining('src/existing.tsx: 2 hardcoded string(s) (baseline 1)'),
      ]);

      writeFileSync(existing, '<span>{text}</span>');
      rmSync(added);
      expect(lintLiterals(opts)).toEqual({ current: {}, errors: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds no regressions across the repository', () => {
    expect(lintLiterals().errors).toEqual([]);
  });
});
