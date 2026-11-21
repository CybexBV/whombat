/**
 * The phone's NETWORK and Wi-Fi sheet logic (hardware-support-android.md AP-3251…AP-3261): which card NETWORK is, the
 * form's fields, checks and input per network, the sheet's head, following a change and where a refusal goes back to,
 * and the report's header for this phone. Facts, not sentences.
 */
import { type HostNetwork, NETWORK_TEXT, type NetworkChange, type WifiRowView } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import {
  cableConfirm,
  EMPTY_WIFI_FORM,
  hardwareReportAbout,
  networkCardKind,
  type WifiStep,
  wifiAfterChange,
  wifiFollowLine,
  wifiFormFields,
  wifiFormInput,
  wifiFormProblem,
  wifiSheetHead,
} from './machine';

const NAME = 'Burrow HQ';

const row = (over: Partial<WifiRowView> = {}): WifiRowView => ({
  ssid: 'Neighbours',
  security: 'psk',
  signal: 2,
  secured: true,
  saved: false,
  connected: false,
  meta: null,
  joinable: true,
  label: 'Neighbours, secured, good signal',
  ...over,
});

const change = (over: Partial<NetworkChange> = {}): NetworkChange => ({
  id: 'c-00000001',
  kind: 'join',
  ssid: 'Neighbours',
  phase: 'applying',
  deadline: '2026-10-20T09:24:00Z',
  previous: 'Home',
  ...over,
});

const form = (network: WifiRowView | null): Extract<WifiStep, { at: 'form' }> => ({ at: 'form', network });

describe('NETWORK’s card', () => {
  const idle = { network: null, reason: null, loading: true };
  it('is nothing without the ops or a manager, a skeleton first, then the rows or why not', () => {
    expect(networkCardKind(null, idle)).toBe('none');
    expect(networkCardKind({}, { ...idle, reason: 'not_managed' })).toBe('none');
    expect(networkCardKind({}, idle)).toBe('loading');
    expect(networkCardKind({}, { ...idle, reason: 'unavailable', loading: false })).toBe('unavailable');
    const network = { online: true, checkedAt: null, wired: [], wifi: null, change: null };
    expect(networkCardKind({}, { network, reason: null, loading: false })).toBe('rows');
  });
});

describe('the Wi-Fi sheet’s form', () => {
  it('asks for a password only for a secured network not saved here', () => {
    expect(wifiFormFields(form(row()), EMPTY_WIFI_FORM)).toEqual({
      name: false,
      password: true,
      savedNote: false,
    });
    expect(wifiFormFields(form(row({ saved: true })), EMPTY_WIFI_FORM)).toEqual({
      name: false,
      password: false,
      savedNote: true,
    });
    expect(wifiFormFields(form(row({ security: 'open', secured: false })), EMPTY_WIFI_FORM).password).toBe(
      false,
    );
    expect(wifiFormFields({ at: 'list' }, EMPTY_WIFI_FORM)).toEqual({
      name: false,
      password: false,
      savedNote: false,
    });
  });

  it('asks Other network… for a name, and a password unless its security is None', () => {
    expect(wifiFormFields(form(null), { security: 'psk' })).toMatchObject({ name: true, password: true });
    expect(wifiFormFields(form(null), { security: 'open' })).toMatchObject({ name: true, password: false });
  });

  it('checks the name before the password, and lets a good form through', () => {
    const other = form(null);
    expect(wifiFormProblem(other, { ...EMPTY_WIFI_FORM, password: 'long enough' })?.field).toBe('name');
    expect(wifiFormProblem(other, { ssid: 'Attic', security: 'psk', password: 'short' })?.field).toBe(
      'password',
    );
    expect(wifiFormProblem(other, { ssid: 'Attic', security: 'psk', password: 'attic-pass-1' })).toBeNull();
    expect(wifiFormProblem(form(row({ saved: true })), EMPTY_WIFI_FORM)).toBeNull();
  });

  it('sends the typed name trimmed and hidden, and the password only when it was asked for', () => {
    expect(wifiFormInput(form(null), { ssid: ' Attic ', security: 'psk', password: 'attic-pass-1' })).toEqual(
      { ssid: 'Attic', passphrase: 'attic-pass-1', hidden: true },
    );
    expect(wifiFormInput(form(null), { ssid: 'Shed', security: 'open', password: 'left over' })).toEqual({
      ssid: 'Shed',
      hidden: true,
    });
    expect(wifiFormInput(form(row({ saved: true })), { ...EMPTY_WIFI_FORM, password: 'stale' })).toEqual({
      ssid: 'Neighbours',
    });
    expect(
      wifiFormInput(form(row()), { ...EMPTY_WIFI_FORM, password: 'correct horse battery' }).passphrase,
    ).toBe('correct horse battery');
  });
});

describe('the Wi-Fi sheet’s head', () => {
  it('names the step: the list, a network, Other network…, and the change it follows', () => {
    expect(wifiSheetHead({ at: 'list' }, NAME).title).toBe(NETWORK_TEXT.dialog.title);
    expect(wifiSheetHead({ at: 'list' }, NAME).lead).toContain(NAME);
    expect(wifiSheetHead(form(row()), NAME)).toMatchObject({ title: 'Neighbours' });
    expect(wifiSheetHead(form(row()), NAME).lead).toContain(NAME);
    expect(wifiSheetHead(form(null), NAME).title).toBe(NETWORK_TEXT.dialog.otherTitle);
    expect(
      wifiSheetHead({ at: 'following', id: 'c-00000001', ssid: 'Attic', network: null }, NAME).title,
    ).toBe('Attic');
  });
});

describe('following a change', () => {
  const following: WifiStep = { at: 'following', id: 'c-00000001', ssid: 'Neighbours', network: row() };

  it('says Joining… until the change is known, then the shared line, running or not', () => {
    expect(wifiFollowLine(null, NAME)).toMatchObject({ title: NETWORK_TEXT.dialog.joining, running: true });
    // Joining: the guard's note is the sheet's lead, not the line's again.
    expect(wifiFollowLine(change(), NAME)).toMatchObject({ running: true, meta: null });
    expect(wifiFollowLine(change({ phase: 'confirming' }), NAME).meta).toContain(NAME);
    const joined = wifiFollowLine(change({ phase: 'committed' }), NAME);
    expect(joined.running).toBe(false);
    expect(joined.title).toContain('Neighbours');
    expect(joined.dot).toBe('ok');
    const back = wifiFollowLine(change({ phase: 'reverted', failure: 'no_internet' }), NAME);
    expect(back).toMatchObject({ running: false, dot: 'warn' });
    expect(back.meta).toContain('Home');
  });

  it('goes back to the form under the password when the password was wrong', () => {
    const back = wifiAfterChange(following, change({ phase: 'failed', failure: 'wrong_password' }), NAME);
    expect(back?.step).toEqual({ at: 'form', network: row() });
    expect(back?.problem?.field).toBe('password');
    expect(back?.note).toBeNull();
  });

  it('goes back to the form with why for another refusal', () => {
    const back = wifiAfterChange(following, change({ phase: 'failed', failure: 'not_found' }), NAME);
    expect(back?.problem).toBeNull();
    expect(back?.note).toContain('Neighbours');
  });

  it('stays while it runs, once it joined or went back, and for another change', () => {
    expect(wifiAfterChange(following, change(), NAME)).toBeNull();
    expect(wifiAfterChange(following, change({ phase: 'committed' }), NAME)).toBeNull();
    expect(
      wifiAfterChange(following, change({ phase: 'reverted', failure: 'no_internet' }), NAME),
    ).toBeNull();
    expect(
      wifiAfterChange(following, change({ id: 'c-00000002', phase: 'failed', failure: 'failed' }), NAME),
    ).toBeNull();
    expect(wifiAfterChange(form(row()), change({ phase: 'failed', failure: 'failed' }), NAME)).toBeNull();
  });
});

describe('the hardware report’s header', () => {
  it('names the Whombat, its version, this app and its build', () => {
    const about = hardwareReportAbout({
      burrow: NAME,
      app: '0.105.0',
      build: 105000,
      runtime: '0.112.1',
      platform: 'android',
    });
    expect(about.burrow).toBe(NAME);
    expect(about.version).toContain('Whombat 0.112.1');
    expect(about.version).toContain('Android app 0.105.0');
    expect(about.version).toContain('build 105000');
  });

  it('leaves out what it doesn’t know', () => {
    const about = hardwareReportAbout({
      burrow: NAME,
      app: '0.105.0',
      build: null,
      runtime: null,
      platform: 'ios',
    });
    expect(about.version).toBe('iOS app 0.105.0');
  });
});

describe('Use Wi-Fi only and the cable again, asked in an alert', () => {
  const network = (wifiAddress: string): HostNetwork => ({
    online: true,
    checkedAt: null,
    wired: [
      { interface: 'enp5s0', connected: true, address: '10.100.1.81', prefixLength: 24, plugged: true },
    ],
    wifi: {
      interface: 'wlan0',
      state: 'connected',
      ssid: 'Home',
      signal: 4,
      address: wifiAddress,
      prefixLength: 24,
      saved: [],
    },
    change: null,
    wifiOnly: false,
  });

  it('names the network, the guard, and the other-network note only when it applies', () => {
    const same = cableConfirm(network('10.100.1.97'), 'wifi', NAME);
    expect(same.title).toBe(NETWORK_TEXT.wifiOnlyDialog.title);
    expect(same.submit).toBe('Use Wi-Fi only');
    expect(same.message).toContain('“Home”');
    expect(same.message.split('\n\n')).toHaveLength(2);
    expect(cableConfirm(network('192.168.50.4'), 'wifi', NAME).message.split('\n\n')).toHaveLength(3);
  });

  it('asks the cable again with its own button', () => {
    const c = cableConfirm(network('10.100.1.97'), 'cable', NAME);
    expect(c.title).toBe('Use the cable again?');
    expect(c.submit).toBe('Use the cable');
    expect(c.message).toContain(NAME);
  });
});
