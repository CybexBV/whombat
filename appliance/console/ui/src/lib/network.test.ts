import { describe, expect, it } from 'vitest';
import {
  changeRunning,
  connectedVia,
  mayForget,
  needsPassword,
  parseChange,
  parseInstallerWifi,
  parseNetworkAnswer,
  parseNetworkSummary,
  parseScan,
  passphraseValid,
  sortNetworks,
  ssidValid,
} from './network';

const home = { ssid: 'Home', security: 'psk', signal: 4, saved: true, connected: true };

describe('names and passwords', () => {
  it('takes displayable names of at most 32 bytes', () => {
    for (const ok of ['Home', 'Lumio Guest', 'Café ☕', 'a'.repeat(32), 'é'.repeat(16)])
      expect(ssidValid(ok)).toBe(true);
    for (const bad of ['', 'é'.repeat(17), 'a​b', 'a‮b', 'a b', 'a\tb', 5, null])
      expect(ssidValid(bad)).toBe(false);
  });
  it('takes WPA passphrases', () => {
    expect(passphraseValid('12345678')).toBe(true);
    expect(passphraseValid('x'.repeat(63))).toBe(true);
    expect(passphraseValid(`${'aF0'.repeat(21)}a`)).toBe(true);
    for (const bad of ['1234567', 'x'.repeat(64), 'pässword', 'pass\nword'])
      expect(passphraseValid(bad)).toBe(false);
  });
});

describe('parsing', () => {
  it('reads the desk network answer and leaves out what it can’t show', () => {
    const a = parseNetworkAnswer({
      v: 1,
      mayChange: false,
      why: 'locked',
      network: {
        online: true,
        checkedAt: '2026-10-20T09:40:30Z',
        wired: [{ interface: 'eth0', connected: false }, { connected: true }],
        wifi: {
          interface: 'wlan0',
          state: 'connected',
          ssid: 'Home',
          signal: 3,
          address: '192.168.1.40',
          saved: [
            { ssid: 'Home', security: 'psk' },
            { ssid: 'Evil‮iwf', security: 'psk' },
            { ssid: 'X', security: 'wep' },
          ],
        },
        change: { id: 'c-0123abcd', kind: 'join', ssid: 'Office', phase: 'nope', deadline: '' },
      },
    });
    expect(a?.mayChange).toBe(false);
    expect(a?.network.wired).toHaveLength(1);
    expect(a?.network.wifi?.ssid).toBe('Home');
    expect(a?.network.wifi?.saved.map((s) => s.ssid)).toEqual(['Home']);
    expect(a?.network.change).toBeNull();
    expect(parseNetworkAnswer({ mayChange: true })).toBeNull();
  });
  it('reads a change with its failure and previous network', () => {
    const c = parseChange({
      id: 'c-0123abcd',
      kind: 'join',
      ssid: 'Office',
      phase: 'reverted',
      deadline: '2026-10-20T09:43:00Z',
      previous: 'Home',
      failure: 'no_internet',
    });
    expect(c).toMatchObject({ phase: 'reverted', previous: 'Home', failure: 'no_internet' });
    expect(parseChange({ id: 'c-1', kind: 'leave', ssid: 'A', phase: 'applying' })).toBeNull();
  });
  it('reads scans, the summary and the installer’s Wi-Fi', () => {
    const s = parseScan({
      v: 1,
      scan: {
        scannedAt: '2026-10-20T09:41:00Z',
        networks: [home, { ...home, ssid: 'Loud', signal: 9 }, { ...home, ssid: '\u0007' }],
      },
    });
    expect(s?.networks.map((n) => n.ssid)).toEqual(['Home']);
    expect(parseNetworkSummary({ online: true, via: 'wifi', ssid: 'Home' })).toEqual({
      online: true,
      via: 'wifi',
      ssid: 'Home',
      wifiMissing: null,
    });
    expect(parseNetworkSummary({ online: true, via: 'cable', ssid: 'Home' })?.ssid).toBeNull();
    expect(parseNetworkSummary({ online: false, via: 'none', wifiMissing: 'no_driver' })?.wifiMissing).toBe(
      'no_driver',
    );
    expect(parseNetworkSummary({ via: 'carrier pigeon' })).toBeNull();
    expect(parseInstallerWifi({ adapter: false })).toMatchObject({ wifiMissing: 'no_adapter', networks: [] });
    expect(parseInstallerWifi({ adapter: true, connected: 'Home', networks: [home] })).toMatchObject({
      wifiMissing: null,
      connected: 'Home',
    });
  });
});

describe('rules', () => {
  const net = (p: object) => ({ online: true, checkedAt: null, wired: [], wifi: null, change: null, ...p });
  it('a cable wins', () => {
    const wifi = { interface: 'wlan0', state: 'connected', ssid: 'Home', saved: [] } as const;
    expect(connectedVia(net({ wired: [{ interface: 'eth0', connected: true }], wifi }))).toBe('cable');
    expect(connectedVia(net({ wifi }))).toBe('wifi');
    expect(connectedVia(net({}))).toBe('none');
    // Forgetting the network the box depends on isn't offered; with a cable it is.
    expect(mayForget(net({ wifi }), 'Home')).toBe(false);
    expect(mayForget(net({ wifi, wired: [{ interface: 'eth0', connected: true }] }), 'Home')).toBe(true);
    expect(mayForget(net({ wifi }), 'Office')).toBe(true);
  });
  it('asks for a password only for secured networks the box hasn’t saved', () => {
    expect(needsPassword({ security: 'psk', saved: false })).toBe(true);
    expect(needsPassword({ security: 'psk', saved: true })).toBe(false);
    expect(needsPassword({ security: 'open', saved: false })).toBe(false);
  });
  it('lists the network in use first', () => {
    const list = sortNetworks([
      { ...home, ssid: 'A', connected: false },
      { ...home, ssid: 'B', connected: true },
    ] as never);
    expect(list.map((n) => n.ssid)).toEqual(['B', 'A']);
  });
  it('knows when a change still runs', () => {
    expect(['applying', 'confirming', 'reverting'].every((phase) => changeRunning({ phase } as never))).toBe(
      true,
    );
    expect(['committed', 'reverted', 'failed'].some((phase) => changeRunning({ phase } as never))).toBe(
      false,
    );
    expect(changeRunning(null)).toBe(false);
  });
});
