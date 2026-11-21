import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type ConnectorReading,
  connectorOf,
  DisplayProbe,
  displayOf,
  parseEdid,
  readConnectors,
  screenOf,
} from './hardware';

const root = mkdtempSync(join(tmpdir(), 'desk-drm-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** John's DEV box (Incus, virtio-gpu): the EDID its `card1-Virtual-1` reports, QEMU's “QEMU Monitor” by maker RHT. */
const QEMU_EDID = Buffer.from(
  'AP///////wBJFDQSAAAAACoYAQSlIBR4Bu6Ro1RMmSYPUFQhCADhwNHA0QCpQLMAlQCBgIFA6ikAwFEgHDBAJkRARcsQAAAYAAAA9wAKAECCACggAAAAAAAAAAAA/QAyfR6g/wEKICAgICAgAAAA/ABRRU1VIE1vbml0b3IKAToCAwsARn1lYFkfYQAAABAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALw==',
  'base64',
);

/** A valid base block from `maker`, with a 0xFC name descriptor when `name` is given (and a range descriptor). */
function edid(maker: string, name: string | null): Uint8Array {
  const b = new Uint8Array(128);
  b.set([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]);
  const [x, y, z] = [...maker].map((c) => c.charCodeAt(0) - 64) as [number, number, number];
  const id = (x << 10) | (y << 5) | z;
  b[8] = id >> 8;
  b[9] = id & 0xff;
  b[18] = 1; // EDID 1.4
  b[19] = 4;
  // A detailed timing descriptor first, as real monitors have (a pixel clock: not a display descriptor).
  b[54] = 0x4d;
  b[55] = 0xd0;
  // A range limits descriptor (0xFD), then the name.
  b.set([0, 0, 0, 0xfd, 0, 0x32, 0x4b], 72);
  if (name) {
    const text = [...name.slice(0, 13)].map((c) => c.charCodeAt(0));
    const field = [...text, ...(text.length < 13 ? [0x0a] : [])];
    while (field.length < 13) field.push(0x20);
    b.set([0, 0, 0, 0xfc, 0, ...field], 90);
  }
  let sum = 0;
  for (let i = 0; i < 127; i++) sum += b[i] as number;
  b[127] = (256 - (sum % 256)) % 256;
  return b;
}

describe('the EDID (DK-16)', () => {
  it('reads the DEV box’s QEMU display: maker RHT, “QEMU Monitor”', () => {
    expect(parseEdid(QEMU_EDID)).toEqual({ maker: 'RHT', name: 'QEMU Monitor' });
  });

  it('reads a monitor’s maker and name, and a panel without a name', () => {
    expect(parseEdid(edid('DEL', 'DELL U2720Q'))).toEqual({ maker: 'DEL', name: 'DELL U2720Q' });
    expect(parseEdid(edid('BOE', null))).toEqual({ maker: 'BOE', name: null });
    // Thirteen characters fill the field without a line feed.
    expect(parseEdid(edid('SAM', 'Odyssey G9 49'))?.name).toBe('Odyssey G9 49');
  });

  it('has none for an empty file, a broken checksum or a wrong header', () => {
    expect(parseEdid(new Uint8Array())).toBeNull();
    const broken = edid('DEL', 'DELL U2720Q');
    broken[127] = ((broken[127] as number) + 1) % 256;
    expect(parseEdid(broken)).toBeNull();
    const header = edid('DEL', 'DELL U2720Q');
    header[0] = 1;
    header[127] = ((header[127] as number) - 1 + 256) % 256;
    expect(parseEdid(header)).toBeNull();
  });
});

describe('what counts as a real screen (DK-16)', () => {
  const reading = (over: Partial<ConnectorReading>): ConnectorReading => ({
    type: 'HDMI-A',
    connected: true,
    drivers: ['amdgpu'],
    vendor: '0x1002',
    edid: { maker: 'DEL', name: 'DELL U2720Q' },
    ...over,
  });

  it('a monitor on a real card is real, with its name', () => {
    expect(screenOf(reading({}))).toEqual({
      connected: true,
      real: true,
      builtIn: false,
      name: 'DELL U2720Q',
    });
  });

  it('a VM’s display is connected, not real', () => {
    const devBox = reading({
      type: 'Virtual',
      drivers: ['virtio-pci', 'virtio_gpu'],
      vendor: '0x1af4',
      edid: { maker: 'RHT', name: 'QEMU Monitor' },
    });
    expect(screenOf(devBox)).toEqual({ connected: true, real: false, builtIn: false, name: 'QEMU Monitor' });
    // Each sign alone is enough: the maker, the driver, the vendor.
    expect(screenOf(reading({ edid: { maker: 'RHT', name: null } })).real).toBe(false);
    expect(screenOf(reading({ drivers: ['bochs-drm'], vendor: null })).real).toBe(false);
    expect(screenOf(reading({ drivers: ['simple-framebuffer'], vendor: null })).real).toBe(false);
    expect(screenOf(reading({ drivers: [], vendor: '0x15ad' })).real).toBe(false);
  });

  it('a port with nothing that says what it is isn’t real; a laptop’s panel is, built in', () => {
    expect(screenOf(reading({ type: 'VGA', drivers: ['ast'], vendor: '0x1a03', edid: null })).real).toBe(
      false,
    );
    expect(screenOf(reading({ type: 'eDP', edid: { maker: 'BOE', name: null } }))).toEqual({
      connected: true,
      real: true,
      builtIn: true,
      name: null,
    });
    // A panel whose EDID can't be read is still the laptop's own screen.
    expect(screenOf(reading({ type: 'DSI', edid: null }))).toMatchObject({ real: true, builtIn: true });
    expect(screenOf(reading({ type: 'eDP', edid: null, drivers: ['virtio-pci'] })).real).toBe(false);
  });

  it('picks the screen that says most', () => {
    const panel = reading({ type: 'eDP', edid: { maker: 'BOE', name: null } });
    const monitor = reading({ type: 'DP' });
    const off = reading({ type: 'HDMI-A', connected: false });
    expect(displayOf([panel, monitor, off])).toMatchObject({
      real: true,
      builtIn: false,
      name: 'DELL U2720Q',
    });
    expect(displayOf([panel, off])).toMatchObject({ real: true, builtIn: true });
    expect(displayOf([off])).toEqual({ connected: false, real: false, builtIn: false, name: null });
    expect(displayOf([])).toMatchObject({ connected: false });
  });

  it('reads the connector’s type from its name', () => {
    expect(connectorOf('card1-eDP-1')).toEqual({ card: 'card1', type: 'eDP' });
    expect(connectorOf('card0-HDMI-A-1')).toEqual({ card: 'card0', type: 'HDMI-A' });
    expect(connectorOf('card1')).toBeNull();
    expect(connectorOf('renderD128')).toBeNull();
  });
});

/** A connector under `dir`: its status and EDID, and its card's driver (a symlink, as sysfs has it). */
function connector(dir: string, name: string, status: string, bytes: Uint8Array = new Uint8Array()) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'status'), `${status}\n`);
  writeFileSync(join(dir, name, 'edid'), bytes);
}

function card(dir: string, name: string, driver: string, vendor: string, virtio?: string) {
  const device = join(dir, name, 'device');
  mkdirSync(device, { recursive: true });
  const drivers = join(dir, 'bus', 'drivers');
  mkdirSync(join(drivers, driver), { recursive: true });
  symlinkSync(join(drivers, driver), join(device, 'driver'));
  writeFileSync(join(device, 'vendor'), `${vendor}\n`);
  if (virtio) {
    mkdirSync(join(device, 'virtio0'), { recursive: true });
    mkdirSync(join(drivers, virtio), { recursive: true });
    symlinkSync(join(drivers, virtio), join(device, 'virtio0', 'driver'));
  }
}

describe('the screen in sysfs (DK-S14, DK-16)', () => {
  it('reads John’s DEV box as connected and not real', async () => {
    const dir = join(root, 'devbox');
    card(dir, 'card1', 'virtio-pci', '0x1af4', 'virtio_gpu');
    connector(dir, 'card1-Virtual-1', 'connected', QEMU_EDID);
    const [read] = await readConnectors(dir);
    expect(read).toMatchObject({ type: 'Virtual', drivers: ['virtio-pci', 'virtio_gpu'], vendor: '0x1af4' });
    expect(displayOf(await readConnectors(dir))).toEqual({
      connected: true,
      real: false,
      builtIn: false,
      name: 'QEMU Monitor',
    });
  });

  it('reads a laptop with its panel and a monitor', async () => {
    const dir = join(root, 'laptop');
    card(dir, 'card1', 'amdgpu', '0x1002');
    connector(dir, 'card1-eDP-1', 'connected', edid('BOE', null));
    connector(dir, 'card1-DP-1', 'disconnected');
    connector(dir, 'card1-DP-2', 'connected', edid('DEL', 'DELL U2720Q'));
    mkdirSync(join(dir, 'renderD128'), { recursive: true });
    expect(displayOf(await readConnectors(dir))).toEqual({
      connected: true,
      real: true,
      builtIn: false,
      name: 'DELL U2720Q',
    });
  });

  it('reads it again after a minute', async () => {
    const dir = join(root, 'later');
    let now = 0;
    const probe = new DisplayProbe(dir, () => now);
    expect(await probe.connected()).toBe(false);
    card(dir, 'card0', 'i915', '0x8086');
    connector(dir, 'card0-HDMI-A-1', 'connected', edid('GSM', 'LG HDR 4K'));
    expect(await probe.display()).toMatchObject({ connected: false });
    now = 60_000;
    expect(await probe.display()).toEqual({ connected: true, real: true, builtIn: false, name: 'LG HDR 4K' });
  });
});
