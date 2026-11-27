import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { clientTranslator } from '@whombat/client/i18n';
import { describe, expect, it } from 'vitest';
import { placeLabel } from '../data/places';
import { tabWords } from '../data/shell';
import { memoryStore } from '../lib/kv';
import { statusWidgetPayload } from '../live/statusWidget';
import { boxLocale, deviceLocale, MOBILE_LANGUAGES, readBoxLocale, saveBoxLocale } from './locale';
import { mobileTranslator } from './translate';

const read = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');
const require = createRequire(import.meta.url);

describe('phone languages', () => {
  it('shows English, Dutch and pseudo copy with the same interpolation', () => {
    expect(tabWords('en-GB').Dashboard).toBe('Overview');
    expect(tabWords('nl-NL').Dashboard).toBe('Overzicht');
    expect(tabWords('pseudo').Dashboard).toMatch(/^\[.+\]$/);
    expect(mobileTranslator('pseudo').t('places.line.chat', { assistant: 'Neo' })).toContain('Neo');
    expect(placeLabel('chat', 1, false, 'nl')).toContain('1 ongelezen reactie');
    expect(placeLabel('chat', 2, false, 'nl')).toContain('2 ongelezen reacties');
  });

  it('uses the OS before box selection, the box default for no preference, and falls back safely', () => {
    expect(deviceLocale(() => 'nl-BE')).toBe('nl-BE');
    expect(deviceLocale(() => 'en_US')).toBe('en-US');
    expect(deviceLocale(() => 'fr-FR')).toBe('en-GB');
    expect(deviceLocale(() => 'en-XA')).toBe('pseudo');
    expect(
      deviceLocale(() => {
        throw new Error('No OS locale');
      }),
    ).toBe('en-GB');
    expect(boxLocale(null)).toBe('en-GB');
    expect(boxLocale('nl')).toBe('nl-NL');
    expect(boxLocale('fr-FR')).toBe('en-GB');
  });

  it('remembers the preference for the selected box only', async () => {
    const store = memoryStore();
    await saveBoxLocale(store, 'managed:org/box-1', 'nl-NL');
    await saveBoxLocale(store, 'managed:org/box-2', 'en-GB');
    expect(await readBoxLocale(store, 'managed:org/box-1')).toBe('nl-NL');
    expect(await readBoxLocale(store, 'managed:org/box-2')).toBe('en-GB');
    expect(await readBoxLocale(store, 'managed:other/box-1')).toBeNull();
  });

  it('puts the language picker in You and saves only the language preference', () => {
    expect(MOBILE_LANGUAGES).toEqual([
      { title: 'English', value: 'en-GB' },
      { title: 'Nederlands', value: 'nl-NL' },
    ]);
    expect(clientTranslator('nl-NL').t('settings.language.title')).toBe('Taal');
    expect(read('../settings/SettingsPages.tsx').split('function SettingsProfileScreen')[1]).toContain(
      '<LanguageSection',
    );
    const picker = read('../settings/LanguageSection.tsx');
    expect(picker).toContain('saveLocale(next)');
    expect(picker).toContain('language.dutchVoiceHint');
    expect(picker).not.toContain('setDutchVoice');
    expect(read('provider.tsx')).toMatch(/updatePreferences\(\{ body: \{ locale: next \} \}\)/);
  });

  it('carries Dutch widget status and locale to the native renderer', () => {
    const payload = statusWidgetPayload({
      overview: {
        summary: { needsYou: 0, problems: 0, working: 0 },
        needsYou: [],
        things: [],
        generatedAt: new Date(1_000).toISOString(),
      },
      applianceId: 'box',
      applianceName: null,
      burrowName: null,
      timeZone: 'Europe/Amsterdam',
      locale: 'nl-NL',
      now: 1_000,
    });
    expect(payload).toMatchObject({ status: 'Alles in orde', locale: 'nl-NL', updatedAt: 1_000 });
  });
});

describe('native permission resources', () => {
  it('gives Expo the same five permission keys in English and Dutch and keeps both Android languages', () => {
    const config = require('../../app.config.cjs') as {
      locales: Record<'en' | 'nl', string>;
      ios: { infoPlist: Record<string, unknown> };
    };
    const words = (tag: 'en' | 'nl') => require(join(import.meta.dirname, '../..', config.locales[tag])).ios;
    expect(Object.keys(words('nl'))).toEqual(Object.keys(words('en')));
    expect(Object.keys(words('nl'))).toHaveLength(5);
    expect(config.ios.infoPlist).toMatchObject(words('en'));
    expect(words('nl').NSMicrophoneUsageDescription).toContain('spraaktypen');
    expect(read('../../plugins/with-english-resources.cjs')).toContain(
      'resourceConfigurations += ["en", "nl"]',
    );
  });
});
