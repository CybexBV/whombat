/**
 * The box's screen as the runtime sees it (docs/decisions/desk-display.md DK-16; desk-display-server.md DK-S14,
 * DK-S27): every DRM connector (`/sys/class/drm/card<N>-<type>-<n>`) with its `status`, its card's driver and the EDID
 * the screen reports (`edid`). A connector is a *real* screen when it reads `connected`, its card isn't a virtual
 * machine's or a firmware framebuffer, and it has a valid EDID whose maker isn't a virtual display's (`RHT`, QEMU's) —
 * or it is a laptop's own panel (eDP, LVDS, DSI) on a real card, which a VM never has. `connected` alone is today's
 * `hasDisplay` (every VM has a connected virtual display). Read at most once a minute, so a monitor plugged in later
 * counts too; a box whose sysfs the runtime can't read has none.
 */
import { readdir, readFile, readlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DeskDisplay } from '@whombat/core';

export const DRM_DIR = '/sys/class/drm';
const FRESH_MS = 60_000;

export const NO_DISPLAY: DeskDisplay = { connected: false, real: false, builtIn: false, name: null };

/* EDID ------------------------------------------------------------------------------------------ */

const EDID_HEADER = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
const DESCRIPTORS = [54, 72, 90, 108];
const NAME_TAG = 0xfc;

/** What a screen's EDID base block says about it. */
export interface Edid {
  /** The PNP maker id (“DEL”, “RHT”). */
  maker: string;
  /** The monitor name descriptor (0xFC), trimmed; null without one. */
  name: string | null;
}

/**
 * The EDID's base block (the first 128 bytes): its fixed header, its checksum (all 128 bytes sum to 0 mod 256), the
 * maker's three letters from bytes 8–9 (five bits each, 1 = A) and the first monitor name descriptor (0xFC: 13 bytes of
 * text, ended by a line feed and padded with spaces). Null when there is no valid base block (an empty `edid`: nothing
 * plugged in, or a management port).
 */
export function parseEdid(bytes: Uint8Array): Edid | null {
  if (bytes.length < 128) return null;
  if (EDID_HEADER.some((b, i) => bytes[i] !== b)) return null;
  let sum = 0;
  for (let i = 0; i < 128; i++) sum += bytes[i] as number;
  if (sum % 256 !== 0) return null;
  const id = ((bytes[8] as number) << 8) | (bytes[9] as number);
  const letters = [(id >> 10) & 31, (id >> 5) & 31, id & 31];
  if (letters.some((l) => l < 1 || l > 26)) return null;
  const maker = String.fromCharCode(...letters.map((l) => 64 + l));
  let name: string | null = null;
  for (const at of DESCRIPTORS) {
    // A display descriptor: two zero bytes (no pixel clock), a reserved zero, then its tag.
    if (bytes[at] !== 0 || bytes[at + 1] !== 0 || bytes[at + 2] !== 0 || bytes[at + 3] !== NAME_TAG) continue;
    const raw = Array.from(bytes.subarray(at + 5, at + 18));
    const end = raw.indexOf(0x0a);
    const text = String.fromCharCode(
      ...(end < 0 ? raw : raw.slice(0, end)).filter((c) => c >= 0x20 && c < 0x7f),
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (text) {
      name = text.slice(0, 60);
      break;
    }
  }
  return { maker, name };
}

/** Makers of the virtual displays hypervisors show (QEMU's, which Proxmox and Incus use; VMware's; VirtualBox's). */
export const VIRTUAL_MAKERS = new Set(['RHT', 'VMW', 'VBX']);

/* The card and the connector ---------------------------------------------------------------------- */

/**
 * Drivers of virtual machines' graphics and of the firmware framebuffers (DK-16): the name of the card's driver (or of
 * the virtio device under it) starts with one of these.
 */
const VIRTUAL_DRIVERS = [
  'virtio',
  'bochs',
  'qxl',
  'vmwgfx',
  'vboxvideo',
  'hyperv',
  'cirrus',
  'simpledrm',
  'simple-framebuffer',
  'efidrm',
  'efi-framebuffer',
  'vesadrm',
  'vesa-framebuffer',
];

/** PCI vendors of virtual graphics: Red Hat's virtio and QXL, QEMU's standard VGA, VMware, VirtualBox, Hyper-V. */
const VIRTUAL_VENDORS = new Set(['0x1af4', '0x1b36', '0x1234', '0x15ad', '0x80ee', '0x1414']);

export function virtualDriver(name: string): boolean {
  const n = name.toLowerCase();
  return VIRTUAL_DRIVERS.some((d) => n.startsWith(d));
}

/** The connector types of a laptop's or tablet's own panel. */
const BUILT_IN_TYPES = new Set(['eDP', 'LVDS', 'DSI']);

/** `card1-eDP-1` → card `card1`, type `eDP`; `card0-HDMI-A-1` → `HDMI-A`. Null for anything else in the directory. */
export function connectorOf(entry: string): { card: string; type: string } | null {
  const m = /^(card\d+)-(.+)-\d+$/.exec(entry);
  return m ? { card: m[1] as string, type: m[2] as string } : null;
}

/** What one connector says. */
export interface ConnectorReading {
  type: string;
  connected: boolean;
  /** Its card's driver and the virtio device's under it, as named in sysfs; empty when unreadable. */
  drivers: string[];
  /** The card's PCI vendor (`0x1af4`), when it is a PCI device. */
  vendor: string | null;
  edid: Edid | null;
}

/** A connector as a screen (pure): connected, real (DK-16), built in, and its name. */
export function screenOf(c: ConnectorReading): DeskDisplay {
  if (!c.connected) return NO_DISPLAY;
  const builtIn = BUILT_IN_TYPES.has(c.type);
  const virtualCard =
    c.type === 'Virtual' ||
    c.drivers.some(virtualDriver) ||
    (c.vendor !== null && VIRTUAL_VENDORS.has(c.vendor));
  const realEdid = c.edid !== null && !VIRTUAL_MAKERS.has(c.edid.maker);
  return {
    connected: true,
    real: !virtualCard && (realEdid || builtIn),
    builtIn,
    // A virtual display's name too (“QEMU Monitor”): it says why the switch reads off.
    name: c.edid?.name ?? null,
  };
}

/**
 * The box's screen from its connectors (pure): connected when any is, and the one that says most — real before not,
 * a monitor before the built-in panel (on a laptop with a monitor plugged in, the monitor is what Settings names),
 * named before unnamed.
 */
export function displayOf(readings: ConnectorReading[]): DeskDisplay {
  const screens = readings.map(screenOf).filter((s) => s.connected);
  if (screens.length === 0) return NO_DISPLAY;
  const rank = (s: DeskDisplay) => (s.real ? 0 : 4) + (s.builtIn ? 2 : 0) + (s.name ? 0 : 1);
  return screens.sort((a, b) => rank(a) - rank(b))[0] as DeskDisplay;
}

async function text(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function linkName(path: string): Promise<string | null> {
  try {
    return basename(await readlink(path));
  } catch {
    return null;
  }
}

/** The card's driver (`card1/device/driver` → `virtio-pci`) and that of a virtio device under it (`virtio_gpu`). */
async function cardDrivers(dir: string, card: string): Promise<string[]> {
  const device = join(dir, card, 'device');
  const out: string[] = [];
  const own = await linkName(join(device, 'driver'));
  if (own) out.push(own);
  let entries: string[] = [];
  try {
    entries = await readdir(device);
  } catch {
    // no device directory
  }
  for (const e of entries.filter((n) => /^virtio\d+$/.test(n))) {
    const under = await linkName(join(device, e, 'driver'));
    if (under) out.push(under);
  }
  return out;
}

/** Reads every connector under `dir` (`/sys/class/drm`); none when it can't be read. */
export async function readConnectors(dir = DRM_DIR): Promise<ConnectorReading[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const cards = new Map<string, Promise<{ drivers: string[]; vendor: string | null }>>();
  const out: ConnectorReading[] = [];
  for (const name of names.sort()) {
    const conn = connectorOf(name);
    if (!conn) continue;
    const status = await text(join(dir, name, 'status'));
    if (status === null) continue;
    const connected = status === 'connected';
    let card = cards.get(conn.card);
    if (!card) {
      card = (async () => ({
        drivers: await cardDrivers(dir, conn.card),
        vendor: await text(join(dir, conn.card, 'device', 'vendor')),
      }))();
      cards.set(conn.card, card);
    }
    let edid: Edid | null = null;
    if (connected) {
      try {
        edid = parseEdid(new Uint8Array(await readFile(join(dir, name, 'edid'))));
      } catch {
        // no edid file
      }
    }
    out.push({ type: conn.type, connected, ...(await card), edid });
  }
  return out;
}

/** The screen, remembered for a minute (DK-16). */
export class DisplayProbe {
  #at = Number.NEGATIVE_INFINITY;
  #value: DeskDisplay = NO_DISPLAY;
  #reading: Promise<DeskDisplay> | null = null;

  constructor(
    private readonly dir = DRM_DIR,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The screen as last read within a minute, or read now (`fresh`: read now unless a read is going on). */
  async display(options: { fresh?: boolean } = {}): Promise<DeskDisplay> {
    if (!options.fresh && this.now() - this.#at < FRESH_MS) return this.#value;
    this.#reading ??= readConnectors(this.dir)
      .then(displayOf, () => NO_DISPLAY)
      .then((value) => {
        this.#value = value;
        this.#at = this.now();
        return value;
      })
      .finally(() => {
        this.#reading = null;
      });
    return this.#reading;
  }

  /** `hasDisplay`: a screen is connected. */
  async connected(): Promise<boolean> {
    return (await this.display()).connected;
  }
}
