/**
 * BLUETOOTH and the Add a device sheet's pure part (bluetooth-android.md AP-3751, AP-3754…AP-3757): what the card is, the
 * list while the box looks and after, the pairing the sheet follows, the code's digits for TalkBack, and what closing
 * cancels.
 */
import {
  BLUETOOTH_TEXT,
  type BluetoothDevice,
  type BluetoothPairing,
  type BluetoothScan,
  type BluetoothState,
  bluetoothPairingView,
} from '@whombat/client';
import { describe, expect, it } from 'vitest';
import {
  bluetoothBackToList,
  bluetoothCancelOnClose,
  bluetoothCardKind,
  bluetoothDigitsLabel,
  bluetoothFollowed,
  bluetoothListView,
} from './bluetooth';

const NOW = Date.parse('2026-10-20T09:22:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const keychron: BluetoothDevice = {
  address: 'DC:2C:26:4B:1A:07',
  name: 'Keychron K3',
  kind: 'keyboard',
  connected: true,
  battery: 80,
};
const mouse: BluetoothDevice = {
  address: 'E4:C2:0A:3D:71:9B',
  name: 'MX Master 3S',
  kind: 'mouse',
  connected: false,
  signal: 4,
};
const speaker: BluetoothDevice = {
  address: 'B8:F6:53:0E:94:2D',
  name: 'JBL Flip 6',
  kind: 'speaker',
  connected: false,
  signal: 2,
};

const state = (patch: Partial<BluetoothState> = {}): BluetoothState => ({
  adapter: { name: 'Burrow HQ', powered: true },
  devices: [keychron],
  scan: null,
  pairing: null,
  ...patch,
});
const scan = (devices: BluetoothDevice[], untilMs = NOW + 30_000): BluetoothScan => ({
  until: iso(untilMs),
  devices,
});
const pairing = (patch: Partial<BluetoothPairing> = {}): BluetoothPairing => ({
  id: 'p-00000001',
  address: '28:6A:B8:F0:13:C4',
  name: 'Magic Keyboard',
  kind: 'keyboard',
  phase: 'pairing',
  deadline: iso(NOW + 90_000),
  ...patch,
});

describe('BLUETOOTH’s card', () => {
  it('is nothing without a Bluetooth service or an adapter, a skeleton until it answers, rows after', () => {
    const api = {};
    expect(bluetoothCardKind(null, { bluetooth: state(), reason: null })).toBe('none');
    expect(bluetoothCardKind(api, { bluetooth: null, reason: 'not_managed' })).toBe('none');
    expect(bluetoothCardKind(api, { bluetooth: null, reason: null })).toBe('loading');
    expect(bluetoothCardKind(api, { bluetooth: null, reason: 'unavailable' })).toBe('unavailable');
    expect(bluetoothCardKind(api, { bluetooth: state(), reason: null })).toBe('rows');
    const vm = state({ adapter: null, missing: 'no_adapter', devices: [] });
    expect(bluetoothCardKind(api, { bluetooth: vm, reason: null })).toBe('none');
    const off = state({ adapter: { name: 'Burrow HQ', powered: false }, missing: 'disabled' });
    expect(bluetoothCardKind(api, { bluetooth: off, reason: null })).toBe('rows');
  });
});

describe('the Add a device list', () => {
  it('looks while the request is out and while the scan runs, strongest first, the paired left out', () => {
    expect(bluetoothListView({ at: 'asking' }, state(), null, NOW)).toMatchObject({
      looking: true,
      rows: [],
      note: null,
      canLookAgain: false,
    });
    const found = scan([speaker, keychron, mouse]);
    const view = bluetoothListView({ at: 'asked' }, state({ scan: found }), found, NOW);
    expect(view.looking).toBe(true);
    expect(view.rows.map((r) => r.name)).toEqual(['MX Master 3S', 'JBL Flip 6']);
  });

  it('keeps what it found once the box stops looking, and says when it found nothing', () => {
    const found = scan([mouse], NOW - 1_000);
    const after = bluetoothListView({ at: 'asked' }, state(), found, NOW);
    expect(after).toMatchObject({ looking: false, note: null, canLookAgain: true });
    expect(after.rows.map((r) => r.address)).toEqual([mouse.address]);
    const empty = bluetoothListView({ at: 'asked' }, state(), scan([], NOW - 1_000), NOW);
    expect(empty.note).toBe(BLUETOOTH_TEXT.dialog.none);
  });

  it('says why it couldn’t look', () => {
    const view = bluetoothListView({ at: 'failed', note: 'Bluetooth is switched off.' }, state(), null, NOW);
    expect(view).toMatchObject({ looking: false, note: 'Bluetooth is switched off.', canLookAgain: true });
  });

  it('leaves out a device the box said went, until it looks again', () => {
    const found = scan([mouse, speaker]);
    const view = bluetoothListView({ at: 'asked' }, state({ scan: found }), found, NOW, [mouse.address]);
    expect(view.rows.map((r) => r.name)).toEqual(['JBL Flip 6']);
  });

  it('leaves a device out once it is paired', () => {
    const found = scan([mouse]);
    const paired = state({ devices: [keychron, { ...mouse, connected: true }], scan: found });
    expect(bluetoothListView({ at: 'asked' }, paired, found, NOW).rows).toEqual([]);
  });
});

describe('the pairing the sheet follows', () => {
  it('takes the box’s word on its own pairing, and keeps the last after the box forgets it', () => {
    const started = pairing();
    const typing = pairing({ phase: 'code', code: '482913', typed: 2 });
    expect(bluetoothFollowed(started, typing)).toBe(typing);
    expect(bluetoothFollowed(started, pairing({ id: 'p-00000002' }))).toBe(started);
    expect(bluetoothFollowed(started, null)).toBe(started);
  });

  it('reads the code as its digits and how many are typed', () => {
    const typing = bluetoothPairingView(pairing({ phase: 'code', code: '482913', typed: 2 }));
    expect(bluetoothDigitsLabel(typing)).toBe('4 8 2 9 1 3, 2 of 6 typed');
    const asking = bluetoothPairingView(pairing({ phase: 'confirm', code: '482913' }));
    expect(bluetoothDigitsLabel(asking)).toBe('4 8 2 9 1 3');
    expect(bluetoothDigitsLabel(bluetoothPairingView(pairing()))).toBeNull();
  });

  it('goes back to the list once a pairing answered No ended', () => {
    const asked = pairing({ phase: 'confirm', code: '482913' });
    const ended = pairing({ phase: 'failed', failure: 'canceled' });
    expect(bluetoothBackToList({ at: 'pairing', pairing: asked, declined: true }, asked)).toBe(false);
    expect(bluetoothBackToList({ at: 'pairing', pairing: asked, declined: true }, ended)).toBe(true);
    expect(bluetoothBackToList({ at: 'pairing', pairing: ended }, ended)).toBe(false);
    expect(bluetoothBackToList({ at: 'list' }, ended)).toBe(false);
  });

  it('cancels on closing only a pairing it started that still runs', () => {
    const started = pairing();
    expect(bluetoothCancelOnClose({ at: 'list' }, started)).toBeNull();
    expect(bluetoothCancelOnClose({ at: 'pairing', pairing: started }, null)).toBe(started.id);
    expect(
      bluetoothCancelOnClose(
        { at: 'pairing', pairing: started },
        pairing({ phase: 'confirm', code: '482913' }),
      ),
    ).toBe(started.id);
    expect(
      bluetoothCancelOnClose({ at: 'pairing', pairing: started }, pairing({ phase: 'done' })),
    ).toBeNull();
    expect(
      bluetoothCancelOnClose(
        { at: 'pairing', pairing: pairing({ phase: 'failed', failure: 'rejected' }) },
        null,
      ),
    ).toBeNull();
  });
});
