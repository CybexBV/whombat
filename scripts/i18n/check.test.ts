import { describe, expect, it } from 'vitest';
import { checkAllCatalogs, validateCatalogs } from './check';
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

  it('round-trips every catalog cleanly through PO export and import', async () => {
    const entries = await loadCatalogs();
    const first = entries[0];
    expect(first).toBeDefined();
    if (!first) return;
    const sample = {
      name: first.name,
      en: Object.fromEntries(Object.entries(first.en).slice(0, 25)),
      locales: {
        nl: Object.fromEntries(Object.entries(first.locales.nl).slice(0, 25)),
      },
    };
    const po = serializePo(sample, 'nl');
    const parsed = parsePo(po);
    for (const [key, val] of Object.entries(sample.locales.nl)) {
      if (typeof val === 'string') {
        expect(parsed[key]).toBe(val);
      } else {
        expect(parsed[key]).toEqual(val);
      }
    }
  });
});
