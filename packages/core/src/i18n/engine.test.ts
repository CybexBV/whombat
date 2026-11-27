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
    for (const tag of [
      'en',
      'en-GB',
      'en-US',
      'nl',
      'nl-NL',
      'nl-BE',
      'zh-Hant-TW',
      'fr-FR',
      'ja-JP',
      'de-DE',
      'es-419',
    ]) {
      expect(LocaleTag.safeParse(tag).success, tag).toBe(true);
    }
    for (const tag of ['', 'bad tag', 'nl-NL-NL', 'en-GB-US', 'zh-Hant-Hant-TW']) {
      expect(LocaleTag.safeParse(tag).success, tag).toBe(false);
    }
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
    expect(formatLocaleOf('nl-NL-NL')).toBe('nl-NL');
    expect(formatLocaleOf('en-US')).toBe('en-US');
    expect(new Intl.DateTimeFormat(formatLocaleOf('nl-NL-NL')).resolvedOptions().locale).toBe('nl-NL');
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

  it.each(['fr-FR', 'ja-JP', 'de-DE'])('uses English formatting and plurals for %s', (tag) => {
    const tr = createTranslator({ en: { items: { one: '{n} item', other: '{n} items' } } }, tag);
    expect(tr.locale).toBe('en-GB');
    expect(tr.t('items', { n: 1 })).toBe('1 item');
    expect(tr.t('items', { n: 0 })).toBe('0 items');
  });

  it('interpolates only own properties', () => {
    const vars = { name: 'Mara' };
    Object.setPrototypeOf(vars, { inherited: 'hidden' });
    expect(interpolate('{name} {constructor} {inherited} {toString}', vars)).toBe(
      'Mara {constructor} {inherited} {toString}',
    );
  });

  it('supports pseudo-localization without corrupting placeholders', () => {
    const pseudo = createTranslator(catalogs, 'pseudo');
    const out = pseudo.t('greeting', { name: 'John' });
    expect(out.startsWith('[')).toBe(true);
    expect(out.endsWith(']')).toBe(true);
    expect(out).toContain('John');
    expect(pseudoize('Hello {name} {{keep}}')).toContain('{name}');
    expect(pseudoize('Hello {name} {{keep}}')).toContain('{{keep}}');
    expect(pseudoize('x'.repeat(40))).toHaveLength(52);
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
    expect(formatLocalePercent(85, 'en-GB')).toBe('85%');
    expect(formatLocalePercent(85.5, 'nl-NL', 1)).toBe('85,5%');
    expect(formatLocaleBytes(1536, 'nl-NL')).toBe('1,5 KB');
    expect(formatLocaleBytes(1536, 'en-GB')).toBe('1.5 KB');
    expect(formatLocaleCurrency(123456, 'EUR', 'nl-NL')).toBe('€1.234,56');
    expect(formatLocaleCurrency(2500, 'EUR', 'nl-NL', { trimWhole: true })).toBe('€25');
    expect(formatLocaleCurrency(123456, 'EUR', 'en-GB')).toBe('€1,234.56');
    expect(formatLocaleList(['Plex', 'UniFi'], 'nl-NL')).toBe('Plex en UniFi');
    expect(formatLocaleList(['Plex', 'UniFi'], 'en-GB')).toBe('Plex and UniFi');
    expect(formatLocaleList(['Plex', 'UniFi'], 'nl-BE', 'disjunction')).toBe('Plex of UniFi');
    expect(formatLocaleList(['Plex', 'UniFi'], 'pseudo')).toContain('Plex àñð UniFi');
    expect(compareLocaleText('a', 'b', 'nl-NL')).toBeLessThan(0);
  });

  it('parses both Dutch comma decimals and English dot decimals', () => {
    expect(parseLocaleNumber('90,5')).toBe(90.5);
    expect(parseLocaleNumber('90.5')).toBe(90.5);
    expect(parseLocaleNumber('1,000')).toBe(1000);
    expect(parseLocaleNumber('1,234')).toBe(1234);
    expect(parseLocaleNumber('1,234', 'nl-BE')).toBe(1.234);
    expect(parseLocaleNumber('1,5')).toBe(1.5);
    expect(parseLocaleNumber('1.234,56')).toBe(1234.56);
    expect(parseLocaleNumber('1,234.56')).toBe(1234.56);
    expect(parseLocaleNumber('−4,2')).toBe(-4.2);
    expect(parseLocaleNumber('')).toBeNull();
    expect(parseLocaleNumber('abc')).toBeNull();
  });
});
