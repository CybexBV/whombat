/**
 * The fake box (hardware-support-server.md HD-S08): what it answers is what the contract allows, and a change runs
 * through the guard's phases on the clock it is given — committed, failed with a wrong password, reverted without
 * internet — with the manager's refusals (`busy`, `no_wifi`, `in_use`, `not_saved`, 404 from an older one).
 */
import {
  HostHardwareResponse,
  NetworkStateResponse,
  WifiChangeResponse,
  WifiScanResponse,
} from '@whombat/control-contracts/local';
import { hostNetworkValid } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { FakeHost } from './fake-host';
import { ManagerCallError } from './ports';

const TIMINGS = { applyMs: 100, confirmMs: 200, keepMs: 1_000 };

function box() {
  let now = Date.parse('2026-10-20T12:00:00.000Z');
  const host = new FakeHost(() => now, TIMINGS);
  return {
    host,
    later: (ms: number) => {
      now += ms;
    },
    state: () => {
      const { network } = NetworkStateResponse.parse(host.networkState());
      // What the schema can't say holds in every state: the card's name while connecting, a failure when undone.
      if (!hostNetworkValid(network)) throw new Error(`not a valid network: ${JSON.stringify(network)}`);
      return network;
    },
    join: (ssid: string, passphrase?: string, hidden?: boolean) =>
      WifiChangeResponse.parse(
        host.wifiJoin({
          ssid,
          ...(passphrase ? { passphrase } : {}),
          ...(hidden ? { hidden } : {}),
          confirmTimeoutSec: 120,
        }),
      ).change,
  };
}

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ManagerCallError) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error('not refused');
};

describe('the fake box (HD-S08)', () => {
  it('reports a Z13-like machine within the contract, without serials or MAC addresses', () => {
    const { hardware } = HostHardwareResponse.parse(box().host.hostHardware());
    expect(hardware.machine).toMatchObject({ model: expect.stringContaining('Flow Z13'), virtual: false });
    const by = (id: string) => hardware.devices.find((d) => d.id === id);
    expect(by('14c3:7925')).toMatchObject({ kind: 'wifi', driver: 'mt7925e', status: 'ok' });
    expect(by('1002:1586')).toMatchObject({ kind: 'graphics', driver: 'amdgpu' });
    expect(by('0bda:8153')).toMatchObject({ kind: 'wired', bus: 'usb', driver: 'r8152' });
    expect(hardware.devices.find((d) => d.card === 'acppdmmach')).toMatchObject({ capture: 1, playback: 0 });
    expect(hardware.devices.some((d) => d.kind === 'battery')).toBe(true);
    expect(JSON.stringify(hardware)).not.toMatch(/serial|([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
  });

  it('scans strongest first, leaves hidden networks out and marks the saved and connected one', () => {
    const { scan } = WifiScanResponse.parse(box().host.wifiScan());
    expect(scan.networks.map((n) => n.ssid)).toEqual([
      'Home',
      'Lumio Corp',
      'Office',
      'Café Lumen',
      'OldRouter',
    ]);
    expect(scan.networks.find((n) => n.ssid === 'Office')).toMatchObject({ saved: true, connected: true });
    expect(scan.networks.find((n) => n.ssid === 'Lumio Corp')?.security).toBe('enterprise');
  });

  it('joins through applying → confirming → committed, and keeps the previous network’s name', () => {
    const b = box();
    const change = b.join('Home', 'correct-horse-42');
    expect(change).toMatchObject({ kind: 'join', ssid: 'Home', phase: 'applying', previous: 'Office' });
    expect(b.state().wifi?.state).toBe('connecting');
    b.later(100);
    expect(b.state().change?.phase).toBe('confirming');
    expect(b.state().wifi).toMatchObject({ state: 'connected', ssid: 'Home', signal: 4 });
    b.later(200);
    expect(b.state().change).toMatchObject({ id: change.id, phase: 'committed' });
    expect(b.state().wifi?.saved.map((s) => s.ssid)).toEqual(['Office', 'Home']);
    expect(b.host.joins).toEqual([{ ssid: 'Home', hidden: false, passphrase: true, confirmTimeoutSec: 120 }]);
    b.later(1_000);
    expect(b.state().change).toBeNull();
  });

  it('fails a wrong password at once and keeps nothing', () => {
    const b = box();
    b.join('Home', 'not-the-password');
    b.later(100);
    expect(b.state().change).toMatchObject({ phase: 'failed', failure: 'wrong_password' });
    expect(b.state().wifi).toMatchObject({ ssid: 'Office' });
    expect(b.state().wifi?.saved.map((s) => s.ssid)).toEqual(['Office']);
    expect(JSON.stringify(b.host.joins)).not.toContain('not-the-password');
  });

  it('goes back to the network it used when the new one doesn’t reach Whombat', () => {
    const b = box();
    b.host.cable.connected = false;
    expect(b.state().online).toBe(true);
    b.join('Café Lumen');
    b.later(100);
    expect(b.state()).toMatchObject({ online: false, change: { phase: 'confirming' } });
    b.later(200);
    expect(b.state().change).toMatchObject({ phase: 'reverting', failure: 'no_internet' });
    b.later(200);
    expect(b.state()).toMatchObject({
      online: true,
      wifi: { ssid: 'Office' },
      change: { phase: 'reverted', failure: 'no_internet', previous: 'Office' },
    });
    expect(b.state().wifi?.saved.map((s) => s.ssid)).toEqual(['Office']);
  });

  it('commits without confirming when the box couldn’t reach Whombat before', () => {
    const b = box();
    b.host.controlReachable = false;
    b.join('Home', 'correct-horse-42');
    b.later(100);
    expect(b.state().change?.phase).toBe('committed');
  });

  it('finds a hidden network only by name, and can’t join company or WEP networks', () => {
    const b = box();
    b.join('Attic', 'attic-pass-7');
    b.later(100);
    expect(b.state().change).toMatchObject({ phase: 'failed', failure: 'not_found' });
    b.join('Attic', 'attic-pass-7', true);
    b.later(300);
    expect(b.state().change).toMatchObject({ ssid: 'Attic', phase: 'committed' });
    b.join('Lumio Corp');
    b.later(100);
    expect(b.state().change).toMatchObject({ phase: 'failed', failure: 'failed' });
  });

  it('refuses a passphrase for an open network, and none for a secured one it doesn’t know', () => {
    const b = box();
    expect(refusal(() => b.join('Café Lumen', 'any-password'))).toEqual({
      status: 400,
      code: 'invalid_passphrase',
    });
    expect(refusal(() => b.join('Home'))).toEqual({ status: 400, code: 'invalid_passphrase' });
    expect(b.host.joins).toEqual([]);
    // A saved network needs none.
    b.join('Office');
    b.later(300);
    expect(b.state().change).toMatchObject({ ssid: 'Office', phase: 'committed' });
  });

  it('runs one change at a time', () => {
    const b = box();
    b.join('Home', 'correct-horse-42');
    expect(refusal(() => b.join('Attic', 'attic-pass-7', true))).toEqual({ status: 409, code: 'busy' });
    expect(refusal(() => b.host.wifiForget({ ssid: 'Office' }))).toEqual({ status: 409, code: 'busy' });
    b.later(300);
    expect(() => b.host.wifiForget({ ssid: 'Office' })).not.toThrow();
  });

  it('forgets a saved network, but not the only one the box reaches Whombat on', () => {
    const b = box();
    expect(refusal(() => b.host.wifiForget({ ssid: 'Home' }))).toEqual({ status: 404, code: 'not_saved' });
    b.host.cable.connected = false;
    expect(refusal(() => b.host.wifiForget({ ssid: 'Office' }))).toEqual({ status: 409, code: 'in_use' });
    b.host.cable.connected = true;
    const change = WifiChangeResponse.parse(b.host.wifiForget({ ssid: 'Office' })).change;
    expect(change).toMatchObject({ kind: 'forget', phase: 'applying' });
    b.later(100);
    expect(b.state()).toMatchObject({
      wifi: { state: 'disconnected', saved: [] },
      change: { phase: 'committed' },
    });
  });

  it('answers as a box without Wi-Fi and as a manager before 0.102', () => {
    const b = box();
    b.host.wifiMissing = 'no_driver';
    expect(b.state()).toMatchObject({ wifi: null, wifiMissing: 'no_driver' });
    expect(refusal(() => b.host.wifiScan())).toEqual({ status: 409, code: 'no_wifi' });
    expect(refusal(() => b.join('Home', 'correct-horse-42'))).toEqual({ status: 409, code: 'no_wifi' });
    b.host.older = true;
    expect(refusal(() => b.host.hostHardware())).toEqual({ status: 404, code: 'not_found' });
    expect(refusal(() => b.host.networkState())).toEqual({ status: 404, code: 'not_found' });
  });
});
