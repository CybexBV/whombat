import { describe, expect, it } from 'vitest';
import type { HostNetwork, NetworkChange } from './network';
import {
  changeView,
  chipLabel,
  chipView,
  connectionLine,
  refusalText,
  rowMeta,
  signalText,
  WIFI,
} from './wifiCopy';

const net = (p: Partial<HostNetwork>): HostNetwork => ({
  online: true,
  checkedAt: null,
  wired: [],
  wifi: null,
  change: null,
  ...p,
});
const change = (p: Partial<NetworkChange>): NetworkChange => ({
  id: 'c-0123abcd',
  kind: 'join',
  ssid: 'Home',
  phase: 'applying',
  deadline: '2026-10-20T09:43:00Z',
  ...p,
});

describe('the Wi-Fi words (HD-11)', () => {
  it('names the connection as the app does', () => {
    expect(connectionLine(net({ wired: [{ interface: 'eth0', connected: true }] }))).toBe(
      'Cable · Connected',
    );
    expect(
      connectionLine(
        net({ wifi: { interface: 'wlan0', state: 'connected', ssid: 'Home', signal: 4, saved: [] } }),
      ),
    ).toBe('Wi-Fi · Home · Strong signal');
    expect(
      connectionLine(net({ wifi: { interface: 'wlan0', state: 'connecting', ssid: 'Home', saved: [] } })),
    ).toContain('Connecting to Home');
    expect(connectionLine(net({}))).toBe(WIFI.noNetwork);
    expect([4, 3, 2, 1, 0].map((s) => signalText(s as 0))).toEqual([
      'Strong signal',
      'Good signal',
      'Good signal',
      'Weak signal',
      'Weak signal',
    ]);
  });

  it('keeps the chip short and says when Whombat is out of reach', () => {
    expect(chipView({ online: true, via: 'wifi', ssid: 'Home', wifiMissing: null })).toEqual({
      icon: 'wifi',
      text: 'Home',
      warn: false,
    });
    expect(chipView({ online: false, via: 'cable', ssid: null, wifiMissing: null }).warn).toBe(true);
    expect(chipView({ online: false, via: 'none', ssid: null, wifiMissing: null }).text).toBe(WIFI.noNetwork);
    expect(chipLabel({ online: false, via: 'wifi', ssid: 'Home', wifiMissing: null })).toContain('Home');
    expect(chipLabel({ online: false, via: 'wifi', ssid: 'Home', wifiMissing: null })).toContain(
      WIFI.offline,
    );
  });

  it('says why a network can’t be joined, or that it is saved', () => {
    const n = { ssid: 'X', signal: 3, saved: false, connected: false } as const;
    expect(rowMeta({ ...n, security: 'enterprise' })).toContain('Company');
    expect(rowMeta({ ...n, security: 'psk', saved: true })).toBe('Saved');
    expect(rowMeta({ ...n, security: 'psk', connected: true })).toBe('Connected');
    expect(rowMeta({ ...n, security: 'open' })).toBeNull();
  });

  it('tells a change in HD-11’s words', () => {
    expect(changeView(change({})).running).toBe(true);
    expect(changeView(change({ phase: 'committed' }))).toMatchObject({ title: 'Joined Home', tone: 'ok' });
    const back = changeView(change({ phase: 'reverted', previous: 'Office', failure: 'no_internet' }));
    expect(back.line).toMatch(/Joined Home.*went back to Office/);
    expect(changeView(change({ phase: 'reverted', failure: 'no_internet' })).line).toContain('left it again');
    const wrong = changeView(change({ phase: 'failed', failure: 'wrong_password' }));
    expect(wrong.wrongPassword).toBe(true);
    expect(wrong.line).toBe('That password didn’t work.');
    expect(changeView(change({ phase: 'failed', failure: 'not_found' })).line).toContain('Home');
    expect(changeView(change({ kind: 'forget', phase: 'committed' })).title).toBe('Forgot Home');
    expect(changeView(change({ kind: 'forget', phase: 'reverted', failure: 'no_internet' })).title).toBe(
      'Kept Home',
    );
  });

  it('turns refusals into words', () => {
    expect(refusalText('busy')).toContain('still running');
    expect(refusalText('in_use')).toContain('cable');
    expect(refusalText('locked')).toBe(WIFI.failed);
    expect(refusalText(null)).toBe(WIFI.failed);
  });
});
