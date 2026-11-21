import { describe, expect, it } from 'vitest';
import type { BluetoothPairing } from './bluetooth';
import { BLUETOOTH_KINDS } from './bluetooth';
import { BT, chipView, deviceLine, foundLabel, pairingView, refusalText } from './bluetoothCopy';

const pairing = (p: Partial<BluetoothPairing>): BluetoothPairing => ({
  id: 'p-0123abcd',
  address: '7C:C3:A1:5D:9B:14',
  name: 'Magic Keyboard',
  kind: 'keyboard',
  phase: 'pairing',
  deadline: '2026-10-20T09:42:30Z',
  ...p,
});

/** Every word the sheet shows, flattened (functions called with a name and a code). */
function allWords(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') out.push(String(v('Magic Keyboard', '482913')));
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(BT);
  return out;
}

describe('the Bluetooth words (BT-11)', () => {
  it('names every kind and uses curly quotes', () => {
    for (const k of BLUETOOTH_KINDS) expect(BT.kinds[k]).toBeTruthy();
    expect(BT.kinds.gamepad).toBe('Game controller');
    expect(BT.kinds.other).toBe('Device');
    for (const w of allWords()) expect(w).not.toMatch(/['"]/);
  });

  it('says how a paired device is', () => {
    expect(deviceLine({ connected: true, battery: 80 })).toMatch(/^Connected · Battery 80\s%$/);
    expect(deviceLine({ connected: true })).toBe('Connected');
    expect(deviceLine({ connected: false, battery: 80 })).toBe('Not connected');
    expect(
      foundLabel({
        address: 'D3:4C:91:7E:08:A2',
        name: 'MX Master 3S',
        kind: 'mouse',
        connected: false,
        signal: 4,
      }),
    ).toBe('MX Master 3S, mouse, strong signal');
  });

  it('tells a pairing phase by phase', () => {
    expect(pairingView(pairing({}))).toMatchObject({ running: true, title: 'Pairing with Magic Keyboard…' });
    expect(pairingView(pairing({ phase: 'connecting' })).running).toBe(true);
    const code = pairingView(pairing({ phase: 'code', code: '482913', typed: 2 })).title;
    expect(code).toContain('482913');
    expect(code).toContain('Magic Keyboard');
    expect(code).toContain('Enter');
    expect(pairingView(pairing({ phase: 'confirm', code: '731264' })).title).toMatch(
      /^Does Magic Keyboard.*731264\?$/,
    );
    expect(pairingView(pairing({ phase: 'done' }))).toMatchObject({
      running: false,
      tone: 'ok',
      title: 'Magic Keyboard is ready.',
    });
  });

  it('says why a pairing didn’t work, naming the device', () => {
    const v = (failure: BluetoothPairing['failure']) => pairingView(pairing({ phase: 'failed', failure }));
    expect(v('rejected').title).toContain('didn’t accept');
    expect(v('rejected').line).toContain('pairing mode');
    expect(v('timeout').title).toContain('in time');
    expect(v('not_found').title).toContain('nearby');
    expect(v('failed').title).toContain('didn’t work');
    expect(v('canceled').title).toContain('stopped');
    for (const f of ['rejected', 'timeout', 'not_found', 'canceled', 'failed'] as const) {
      expect(v(f).title).toContain('Magic Keyboard');
      expect(v(f).tone).toBe('bad');
    }
  });

  it('keeps the chip short', () => {
    expect(chipView({ missing: null, connected: [] })).toEqual({
      off: false,
      text: null,
      label: 'Bluetooth',
    });
    const one = chipView({ missing: null, connected: [{ name: 'Keychron K3', kind: 'keyboard' }] });
    expect(one.text).toBe('Keychron K3');
    expect(one.label).toContain('Connected');
    const two = chipView({
      missing: null,
      connected: [
        { name: 'Keychron K3', kind: 'keyboard' },
        { name: 'WH-1000XM5', kind: 'headphones' },
      ],
    });
    expect(two.text).toBe('2 devices');
    expect(two.label).toContain('WH-1000XM5');
    const off = chipView({ missing: 'disabled', connected: [] });
    expect(off.off).toBe(true);
    expect(off.label).toContain(BT.missing.disabled);
  });

  it('turns refusals into words', () => {
    expect(refusalText('locked')).toBe(BT.readOnly);
    expect(refusalText('busy')).toContain('Another device');
    expect(refusalText('not_paired')).toContain('isn’t paired');
    expect(refusalText('no_bluetooth')).toBe(BT.missing.disabled);
    expect(refusalText('weird')).toBe(BT.failed);
    expect(refusalText(null)).toBe(BT.failed);
  });
});
