import { describe, expect, it } from 'vitest';
import {
  compareLocaleText,
  createTranslator,
  extractPlaceholders,
  formatLocaleBytes,
  formatLocaleCurrency,
  formatLocaleList,
  formatLocaleNumber,
  formatLocaleOf,
  formatLocalePercent,
  interpolate,
  LocaleTag,
  normalizeLocaleTag,
  parseLocaleNumber,
  pluralCategory,
  pseudoize,
  resolveDisplayLanguage,
  resolveLanguage,
  resolvePreferredLanguage,
  resolvePreferredLocale,
  safeLocaleOrNull,
  sourceHash,
  splitRichTemplate,
} from './index.js';

describe('locale resolution', () => {
  it('normalizes valid BCP-47 tags and rejects malformed ones', () => {
    expect(normalizeLocaleTag('nl')).toBe('nl-NL');
    expect(normalizeLocaleTag('nl_be')).toBe('nl-BE');
    expect(normalizeLocaleTag('en')).toBe('en-GB');
    expect(normalizeLocaleTag('en-us')).toBe('en-US');
    expect(normalizeLocaleTag('fr-FR')).toBe('fr-FR');
    expect(normalizeLocaleTag('')).toBeNull();
    expect(normalizeLocaleTag('not a locale!')).toBeNull();
    expect(LocaleTag.safeParse('nl-NL').success).toBe(true);
    expect(LocaleTag.safeParse('en-GB').success).toBe(true);
    expect(LocaleTag.safeParse('bad tag').success).toBe(false);
  });

  it('resolves language and formatting locale with safe fallback for unknown future tags', () => {
    expect(resolveLanguage('nl-NL')).toBe('nl');
    expect(resolveLanguage('nl-BE')).toBe('nl');
    expect(resolveLanguage('en-US')).toBe('en');
    expect(resolveLanguage('de-DE')).toBe('en');
    expect(resolveLanguage(null)).toBe('en');
    expect(resolveDisplayLanguage('pseudo')).toBe('pseudo');
    expect(resolveDisplayLanguage('nl-XA')).toBe('pseudo');
    expect(formatLocaleOf('en')).toBe('en-GB');
    expect(formatLocaleOf('nl')).toBe('nl-NL');
    expect(formatLocaleOf('nl-BE')).toBe('nl-BE');
    expect(formatLocaleOf('fr-FR')).toBe('fr-FR');
    expect(safeLocaleOrNull('de-DE')).toBe('de-DE');
    expect(safeLocaleOrNull(123)).toBeNull();
  });

  it('picks first supported preference from browser language lists', () => {
    expect(resolvePreferredLanguage(['fr-FR', 'nl-BE', 'en-US'])).toBe('nl');
    expect(resolvePreferredLanguage(['de-DE', 'en-GB', 'nl-NL'])).toBe('en');
    expect(resolvePreferredLanguage(['ja-JP'])).toBe('en');
    expect(resolvePreferredLocale(['fr-FR', 'nl-BE'])).toBe('nl-BE');
    expect(resolvePreferredLocale(['ja-JP'])).toBe('en-GB');
  });
});

describe('translation engine', () => {
  const catalogs = {
    en: {
      greeting: 'Hi {name}',
      items: { one: '{count} item', other: '{count} items' },
      onlyEnglish: 'Fallback text',
      rich: 'Open {link} to change {setting}',
    },
    nl: {
      greeting: 'Hoi {name}',
      items: { one: '{count} item', other: '{count} items' },
      rich: 'Open {link} om {setting} aan te passen',
    },
  } as const;

  it('translates strings, plurals, and falls back per key to English', () => {
    const nl = createTranslator(catalogs, 'nl-NL');
    expect(nl.language).toBe('nl');
    expect(nl.locale).toBe('nl-NL');
    expect(nl.t('greeting', { name: 'John' })).toBe('Hoi John');
    expect(nl.tp('items', 1)).toBe('1 item');
    expect(nl.tp('items', 5)).toBe('5 items');
    expect(nl.t('onlyEnglish')).toBe('Fallback text');
  });

  it('supports pseudo-localization without corrupting placeholders', () => {
    const pseudo = createTranslator(catalogs, 'pseudo');
    const out = pseudo.t('greeting', { name: 'John' });
    expect(out.startsWith('[')).toBe(true);
    expect(out.endsWith(']')).toBe(true);
    expect(out).toContain('John');
    expect(pseudoize('Hello {name} {{keep}}')).toContain('{name}');
    expect(pseudoize('Hello {name} {{keep}}')).toContain('{{keep}}');
  });

  it('splits rich templates, extracts placeholders, and computes deterministic source hashes', () => {
    expect(splitRichTemplate('Open {link} for {who}.')).toEqual([
      { type: 'text', value: 'Open ' },
      { type: 'slot', name: 'link' },
      { type: 'text', value: ' for ' },
      { type: 'slot', name: 'who' },
      { type: 'text', value: '.' },
    ]);
    expect(extractPlaceholders({ one: '{count} on {host}', other: '{count} on {host}' })).toEqual([
      'count',
      'host',
    ]);
    expect(sourceHash('Settings')).toBe(sourceHash('Settings'));
    expect(sourceHash('Settings')).not.toBe(sourceHash('Instellingen'));
    expect(pluralCategory('nl-NL', 1)).toBe('one');
    expect(pluralCategory('nl-NL', 2)).toBe('other');
    expect(interpolate('Hi {name}', { name: 'Mara' })).toBe('Hi Mara');
  });
});

describe('locale formatters', () => {
  it('formats numbers, percentages, bytes, currencies, lists and sorting per locale', () => {
    expect(formatLocaleNumber(1234.5, 'nl-NL')).toBe('1.234,5');
    expect(formatLocaleNumber(1234.5, 'en-GB')).toBe('1,234.5');
    expect(formatLocalePercent(85.5, 'nl-NL', 1)).toBe('85,5\u00a0%');
    expect(formatLocaleBytes(1536, 'nl-NL')).toBe('1,5 KB');
    expect(formatLocaleBytes(1536, 'en-GB')).toBe('1.5 KB');
    expect(formatLocaleCurrency(123456, 'EUR', 'nl-NL')).toBe('€1.234,56');
    expect(formatLocaleCurrency(2500, 'EUR', 'nl-NL', { trimWhole: true })).toBe('€25');
    expect(formatLocaleCurrency(123456, 'EUR', 'en-GB')).toBe('€1,234.56');
    expect(formatLocaleList(['Plex', 'UniFi'], 'nl-NL')).toBe('Plex en UniFi');
    expect(formatLocaleList(['Plex', 'UniFi'], 'en-GB')).toBe('Plex and UniFi');
    expect(compareLocaleText('a', 'b', 'nl-NL')).toBeLessThan(0);
  });

  it('parses both Dutch comma decimals and English dot decimals', () => {
    expect(parseLocaleNumber('90,5')).toBe(90.5);
    expect(parseLocaleNumber('90.5')).toBe(90.5);
    expect(parseLocaleNumber('1.234,56')).toBe(1234.56);
    expect(parseLocaleNumber('1,234.56')).toBe(1234.56);
    expect(parseLocaleNumber('−4,2')).toBe(-4.2);
    expect(parseLocaleNumber('')).toBeNull();
    expect(parseLocaleNumber('abc')).toBeNull();
  });
});
