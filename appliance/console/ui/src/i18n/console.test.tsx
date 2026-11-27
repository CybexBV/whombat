import { FIXTURE_BOX_GRID } from '@whombat/screen/fixtures';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LINK_OFFER_TEXT } from '../../vendor/whombat-contracts/link-price';
import { BluetoothSheet } from '../bluetooth/BluetoothSheet';
import { Claimable } from '../console/Claim';
import { RemoteHelpChip, RemoteHelpLayer } from '../desk/RemoteHelp';
import { MonitorScreens } from '../desk/Screens';
import { Installer } from '../installer/Installer';
import { parseState } from '../lib/api';
import { pairingView } from '../lib/bluetoothCopy';
import type { Client } from '../lib/client';
import { reachNotes } from '../lib/console';
import { formatSize } from '../lib/installer';
import { WifiSheet } from '../wifi/WifiSheet';
import { EN, NL } from './catalog';
import { browserLocale } from './locale';
import { Translation } from './react';
import { translator } from './translate';

const now = Date.parse('2026-10-21T12:34:00Z');
const dutch = translator('nl-NL');
const client = {
  state: vi.fn<Client['state']>(),
  post: vi.fn<Client['post']>(),
  get: vi.fn<Client['get']>(),
  blob: vi.fn<Client['blob']>(),
} satisfies Client;
const noop = () => {};
const render = (screen: ReactNode, locale = dutch) =>
  renderToStaticMarkup(createElement(Translation.Provider, { value: locale }, screen));

describe('console catalog', () => {
  it('pairs every key and preserves the contract’s English Link price', () => {
    expect(Object.keys(NL).sort()).toEqual(Object.keys(EN).sort());
    expect(EN['installer.reachLinkPrice']).toBe(LINK_OFFER_TEXT);
  });

  it('resolves supported browser languages and uses English for an unknown owner locale', () => {
    expect(browserLocale(['fr-FR', 'nl-BE', 'en-US'])).toBe('nl-BE');
    expect(translator('fr-FR')('installer.language')).toBe('Language');
    expect(translator('en').locale).toBe('en-GB');
    expect(translator('nl').locale).toBe('nl-NL');
  });

  it('pluralizes, formats, and interpolates without modifying names in pseudo', () => {
    expect(dutch('installer.check.cores', { count: 1 })).toBe('1 kern');
    expect(dutch('installer.check.cores', { count: 2 })).toBe('2 kernen');
    expect(formatSize(1.8 * 1024 ** 4, dutch.locale)).toBe('1,8 TiB');
    expect(translator('pseudo')('bluetooth.ready', { name: 'MX Keys' })).toMatch(/^\[MX Keys.+·\]$/);
  });
});

describe('Dutch console screens', () => {
  it('renders the installer welcome and names the active language in each language', () => {
    const state = parseState({ mode: 'installer', locale: 'nl-NL' });
    if (state?.mode !== 'installer') throw new Error('expected installer state');
    expect(state.locale).toBe(dutch.locale);
    const welcome = createElement(Installer, { state, client, refresh: noop, onLocale: noop });
    const nl = render(welcome);
    expect(nl).toContain('Stel je Whombat in');
    expect(nl).toContain('>Taal</legend>');
    expect(nl).toContain('lang="en" aria-pressed="false">English');
    expect(nl).toContain('lang="nl" aria-pressed="true">Nederlands');
    const en = render(welcome, translator('en'));
    expect(en).toContain('Let’s set up your Whombat');
    expect(en).toContain('lang="en" aria-pressed="true">English');
  });

  it('keeps the claim code and QR address while translating their labels', () => {
    const state = parseState({
      mode: 'console',
      now: new Date(now).toISOString(),
      locale: 'nl-NL',
      claim: {
        state: 'claimable',
        code: 'KXQM',
        claimUrl: 'example.com/claim',
        qr: Array(21).fill('#'.repeat(21)),
      },
      reach: { link: { state: 'grace', graceEndsOn: '25 November', graceEndsAt: '2026-11-25' } },
    });
    if (state?.mode !== 'console' || !state.claim) throw new Error('expected claim state');
    expect(state.locale).toBe(dutch.locale);
    expect(reachNotes(state, dutch.locale)).toContainEqual({ kind: 'linkGrace', day: '25 november' });
    const claim = render(createElement(Claimable, { claim: state.claim, backoff: false, now }));
    expect(claim).toContain('Claim deze Whombat');
    expect(claim).toContain('KXQM');
    expect(claim).toContain('QR-code voor example.com/claim');
  });

  it('translates Wi-Fi and Bluetooth pairing while preserving the network and device names', () => {
    const wifi = render(
      createElement(WifiSheet, {
        client,
        onClose: noop,
        initial: { step: { kind: 'password', ssid: 'Example Wi-Fi', hidden: false } },
      }),
    );
    expect(wifi).toContain('Verbind met Example Wi-Fi');
    expect(wifi).toContain('Wachtwoord');
    const bt = render(
      createElement(BluetoothSheet, { client, onClose: noop, initial: { step: { kind: 'add' } } }),
    );
    expect(bt).toContain('Apparaat toevoegen');
    expect(bt).toContain('koppelstand');
    expect(
      pairingView(
        {
          id: 'example',
          name: 'MX Keys',
          phase: 'confirm',
          code: '123456',
          address: '00:00:5E:00:53:01',
          kind: 'keyboard',
          deadline: new Date(now).toISOString(),
        },
        dutch,
      ).title,
    ).toBe('Geeft MX Keys de code 123456 weer?');
  });

  it('renders the remote help status and stop control', () => {
    const view = render(
      <RemoteHelpLayer
        help={{ level: 'fix', until: null, connected: 'Support' }}
        offset={0}
        timeZone="Europe/Amsterdam"
        client={client}
        refresh={noop}
        held={false}
        initial={{ open: true }}
      >
        <RemoteHelpChip />
      </RemoteHelpLayer>,
    );
    expect(view).toContain('Hulp op afstand staat aan');
    expect(view).toContain('Support is verbonden');
    expect(view).toContain('Hulp op afstand stoppen');
  });

  it('passes the paired locale on to the vendored screen', () => {
    const state = parseState({
      mode: 'console',
      desk: {
        v: 1,
        now: new Date(now).toISOString(),
        paired: { person: { name: 'John' }, assistant: { name: 'Neo' }, locale: 'nl-NL' },
        lock: { state: 'locked' },
      },
    });
    if (state?.mode !== 'console') throw new Error('expected console state');
    const locale = state.desk?.paired?.locale;
    expect(locale).toBe('nl-NL');

    const view = render(
      createElement(MonitorScreens, {
        monitors: [
          {
            key: 'monitor',
            name: null,
            main: false,
            left: 0,
            top: 0,
            width: 1024,
            height: 768,
            logical: { width: 1024, height: 768 },
          },
        ],
        grids: [{ key: 'monitor', name: 'Monitor', grid: FIXTURE_BOX_GRID }],
        mode: 'screen',
        calm: null,
        name: 'Home',
        assistant: 'Neo',
        face: null,
        now,
        timeZone: 'Europe/Amsterdam',
        unlocked: false,
        onlyTime: true,
        loadImage: async () => '',
      }),
      translator(locale),
    );
    expect(view).toContain('lang="nl-NL"');
    expect(view).toContain('woensdag 21 oktober');
  });
});
