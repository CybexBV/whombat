/**
 * A guest's configuration as the editing screens need it (ported from Rackoon's `features/guest/config.ts`,
 * `hardwareDialogs.tsx` and `OptionsTab.tsx`; hosts/docs/MANAGE.md 2.4): the value an edit starts from (the
 * pending one first, as Proxmox's own dialogs do), what a row becomes after the next restart, the review step's
 * `key: old → new` rows, and the values each dialog writes — disks and their options, CD/DVD drives, EFI disk, TPM,
 * network devices, mount points, processors, display, machine, start order, hotplug, the guest agent, container
 * features, tags, cloud-init, DNS, high availability. Values are changed item by item (`props.ts`), so options
 * Whombat has no field for stay as they are. Pure; the web's dialogs and Android use the same rules.
 */
import type { HostGuestConfig } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { HOSTS_DASHBOARD_MORE_WORDS } from '../i18n/messages/connectionsHosts/dashboardMore';
import { editProps, formatProps, getProp, isOn, type PropItem, parseProps } from './props';

export * from './props';

type Cfg = HostGuestConfig | undefined;

/* Values and drafts --------------------------------------------------------------------------------- */

/** What a platform answers for a set secret. */
export const MASK = '**********';
/** What a platform masks: shown as “(set)”, never as a value. */
export const SECRET_KEYS = new Set(['cipassword', 'password']);

/** The value an edit starts from: the pending one when a restart is due, else the current one. */
export function currentValue(cfg: Cfg, key: string): string | undefined {
  if (!cfg) return undefined;
  if (cfg.pending && key in cfg.pending) return cfg.pending[key];
  if (cfg.pendingDelete?.includes(key)) return undefined;
  return cfg.values[key];
}

/** A row's value now and what it becomes after the next restart (`next` "" with `removed` when it goes then). */
export interface RowValue {
  value: string | undefined;
  next?: string;
  removed?: boolean;
}

export function rowValue(cfg: Cfg, key: string): RowValue {
  const value = cfg?.values[key];
  if (cfg?.pending && key in cfg.pending) return { value, next: cfg.pending[key] };
  if (cfg?.pendingDelete?.includes(key)) return { value, next: '', removed: true };
  return { value };
}

/** The values after the next restart: pending ones in, pending removals out. */
export function afterRestart(cfg: Cfg): Record<string, string> {
  const out = { ...(cfg?.values ?? {}), ...(cfg?.pending ?? {}) };
  for (const k of cfg?.pendingDelete ?? []) delete out[k];
  return out;
}

/** Whether any of `keys` changes at the next restart. */
export function pendingAny(cfg: Cfg, keys: readonly string[]): boolean {
  return keys.some((k) => (cfg?.pending && k in cfg.pending) || cfg?.pendingDelete?.includes(k));
}

/**
 * A row that reads several keys (processors: sockets, cores, type): its words after the next restart, or undefined
 * when none of them waits for one or the words stay the same.
 */
export function laterWords(
  cfg: Cfg,
  keys: readonly string[],
  words: (v: Record<string, string>) => string,
): string | undefined {
  if (!pendingAny(cfg, keys)) return undefined;
  const then = words(afterRestart(cfg));
  return then === words(cfg?.values ?? {}) ? undefined : then;
}

/** Natural order of config keys: scsi2 before scsi10. */
export function keyOrder(a: string, b: string): number {
  const ma = /^(\D+)(\d+)$/.exec(a);
  const mb = /^(\D+)(\d+)$/.exec(b);
  if (ma && mb && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]);
  return a.localeCompare(b);
}

/** Keys with a change waiting for a restart. */
export function pendingKeys(cfg: Cfg): string[] {
  if (!cfg) return [];
  return [...new Set([...Object.keys(cfg.pending ?? {}), ...(cfg.pendingDelete ?? [])])].sort(keyOrder);
}

/** Keys only the platform's own interface may change (shown with a lock). */
export function isRestricted(cfg: Cfg, key: string): boolean {
  return !!cfg?.restricted?.includes(key);
}

/** A change to a guest's configuration (`hosts.manage` `config.set` params, without the digest). */
export interface ConfigDraft {
  set?: Record<string, string>;
  delete?: string[];
  revert?: string[];
  /** Destroys data (an unused disk). */
  confirm?: boolean;
}

export interface ReviewRow {
  key: string;
  old?: string;
  new?: string;
  op: 'set' | 'delete' | 'revert';
}

/** The review step's rows against the loaded configuration; unchanged keys drop out. */
export function reviewRows(cfg: Cfg, d: ConfigDraft): ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const k of d.revert ?? []) {
    if (cfg?.pending && k in cfg.pending)
      rows.push({ key: k, old: cfg.pending[k], new: cfg.values[k], op: 'revert' });
    else if (cfg?.pendingDelete?.includes(k))
      rows.push({ key: k, old: '', new: cfg.values[k], op: 'revert' });
  }
  for (const [k, v] of Object.entries(d.set ?? {})) {
    const old = currentValue(cfg, k);
    if (old === v && !SECRET_KEYS.has(k)) continue;
    rows.push({ key: k, old, new: v, op: 'set' });
  }
  for (const k of d.delete ?? []) {
    const old = currentValue(cfg, k);
    if (old === undefined) continue;
    rows.push({ key: k, old, op: 'delete' });
  }
  return rows;
}

/** Only what differs, so a review sends nothing that is already so. */
export function trimDraft(cfg: Cfg, d: ConfigDraft): ConfigDraft {
  const set: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.set ?? {}))
    if (currentValue(cfg, k) !== v || SECRET_KEYS.has(k)) set[k] = v;
  const del = (d.delete ?? []).filter((k) => currentValue(cfg, k) !== undefined);
  return {
    ...(Object.keys(set).length ? { set } : {}),
    ...(del.length ? { delete: del } : {}),
    ...(d.revert?.length ? { revert: d.revert } : {}),
    ...(d.confirm ? { confirm: true } : {}),
  };
}

/** A draft from key → value; undefined removes the key. */
export function draftOf(entries: Record<string, string | undefined>): ConfigDraft {
  const set: Record<string, string> = {};
  const del: string[] = [];
  for (const [k, v] of Object.entries(entries)) {
    if (v === undefined) del.push(k);
    else set[k] = v;
  }
  return { set, delete: del };
}

export function isEmptyDraft(d: ConfigDraft): boolean {
  return !Object.keys(d.set ?? {}).length && !d.delete?.length && !d.revert?.length;
}

/** Incus removes a key that is set to “” (it has no pending values to revert). */
export function incusDraft(d: ConfigDraft): ConfigDraft {
  if (!d.delete?.length) return d;
  const { delete: del, ...rest } = d;
  return { ...rest, set: { ...d.set, ...Object.fromEntries(del.map((k) => [k, ''])) } };
}

/** A flag as Proxmox stores it: the default is written by leaving the key out. */
export function flagValue(on: boolean, defaultOn = false): string | undefined {
  if (on === defaultOn) return undefined;
  return on ? '1' : '0';
}

/** A value as the review shows it: secrets as “(set)”, empty as “(none)”. */
export function shownValue(key: string, v: string | undefined): string {
  if (v === undefined || v === '') return '(none)';
  if (SECRET_KEYS.has(key)) return '(set)';
  return v;
}

/* Sizes and numbers --------------------------------------------------------------------------------- */

const UNITS: Record<string, number> = {
  '': 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
  P: 1024 ** 5,
};

/** “64G”, “709474K”, “40GiB”, “1.5T” → bytes. */
export function parseSize(s: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTP]?)(?:i?B)?$/i.exec(s?.trim() ?? '');
  if (!m) return undefined;
  return Math.round(Number(m[1]) * (UNITS[(m[2] ?? '').toUpperCase()] ?? 1));
}

/** A disk value's size in bytes. */
export function diskSize(v: string | undefined): number | undefined {
  return parseSize(getProp(parseProps(v ?? ''), 'size'));
}

/** A guest setting's words in a locale (English when none is given). */
const words = (locale?: string | null) => clientTree(locale, HOSTS_DASHBOARD_MORE_WORDS).config;

/** A number field's value and what is wrong with it. */
export function checkNumber(
  s: string,
  o: { min?: number; max?: number; optional?: boolean; decimal?: boolean } = {},
  locale?: string | null,
): { n: number | null; error: string | null } {
  const w = words(locale);
  const v = s.trim();
  if (!v) return { n: null, error: o.optional ? null : w.fillIn };
  if (!(o.decimal ? /^\d+(\.\d+)?$/ : /^\d+$/).test(v))
    return { n: null, error: o.decimal ? w.number : w.wholeNumber };
  const n = Number(v);
  if (o.min != null && n < o.min) return { n, error: interpolate(w.atLeast, { n: o.min }) };
  if (o.max != null && n > o.max) return { n, error: interpolate(w.atMost, { n: o.max }) };
  return { n, error: null };
}

/* Disks --------------------------------------------------------------------------------------------- */

export const VM_BUSES = { scsi: 31, virtio: 16, sata: 6, ide: 4 } as const;
export type VmBus = keyof typeof VM_BUSES;
export const BUS_WORDS: Record<VmBus, string> = {
  scsi: 'SCSI',
  virtio: 'VirtIO Block',
  sata: 'SATA',
  ide: 'IDE',
};

export const DISK_RE = /^(ide|sata|scsi|virtio)\d+$/;
export const CT_DISK_RE = /^(rootfs|mp\d+)$/;
export const MP_RE = /^mp\d+$/;
export const NET_RE = /^net\d+$/;
export const UNUSED_RE = /^unused\d+$/;
export const IPCONFIG_RE = /^ipconfig\d+$/;
export const isCdrom = (v: string | undefined): boolean => /(^|,)media=cdrom(,|$)/.test(v ?? '');
/** The volume of a disk value (“local-zfs:vm-100-disk-0”, “none”, “local:iso/x.iso”). */
export const diskFile = (v: string | undefined): string => (v ?? '').split(',')[0] ?? '';
/** The storage of a volume (“local-zfs”), or “”. */
export const volumeStorage = (vol: string): string =>
  vol.includes(':') ? vol.slice(0, vol.indexOf(':')) : '';
/** The bus of a disk key (“scsi” of “scsi1”). */
export const busOf = (key: string): string => key.replace(/\d+$/, '');
/** A cloud-init drive (“local-zfs:vm-100-cloudinit”, “local:100/vm-100-cloudinit.qcow2”, a new “STORAGE:cloudinit”). */
export const isCloudInitDrive = (v: string | undefined): boolean =>
  /(^|[:/-])cloudinit(\.[a-z0-9]+)?$/i.test(diskFile(v));
/** A host path or bind mount (Proxmox only: never changed here). */
export const isBindMount = (v: string | undefined): boolean => diskFile(v).startsWith('/');

/** Keys of a family in natural order (“net0”, “net1”), pending ones included. */
export function keysOf(cfg: Cfg, re: RegExp): string[] {
  const all = new Set([...Object.keys(cfg?.values ?? {}), ...Object.keys(cfg?.pending ?? {})]);
  return [...all].filter((k) => re.test(k)).sort(keyOrder);
}

/** The first free key of a bus (“scsi1”), pending keys counted as taken. */
export function freeKey(cfg: Cfg, prefix: string, max: number): string | null {
  const taken = new Set([...Object.keys(cfg?.values ?? {}), ...Object.keys(cfg?.pending ?? {})]);
  for (let i = 0; i < max; i++) if (!taken.has(`${prefix}${i}`)) return `${prefix}${i}`;
  return null;
}

export interface DiskOpts {
  cache: string;
  discard: boolean;
  iothread: boolean;
  ssd: boolean;
  backup: boolean;
  replicate: boolean;
}

export const DISK_CACHES: readonly { value: string; label: string }[] = [
  { value: '', label: 'Default (no cache)' },
  { value: 'directsync', label: 'Direct sync' },
  { value: 'writethrough', label: 'Write through' },
  { value: 'writeback', label: 'Write back' },
  { value: 'unsafe', label: 'Write back (unsafe)' },
  { value: 'none', label: 'No cache' },
];

/** A new disk's options: an IO thread, in backups and replication. */
export const NEW_DISK: DiskOpts = {
  cache: '',
  discard: false,
  iothread: true,
  ssd: false,
  backup: true,
  replicate: true,
};

export function readDiskOpts(v: string | undefined): DiskOpts {
  const items = parseProps(v ?? '', 'file');
  return {
    cache: getProp(items, 'cache') ?? '',
    discard: getProp(items, 'discard') === 'on',
    iothread: isOn(getProp(items, 'iothread')),
    ssd: isOn(getProp(items, 'ssd')),
    backup: isOn(getProp(items, 'backup'), true),
    replicate: isOn(getProp(items, 'replicate'), true),
  };
}

/** What a bus offers: an IO thread on SCSI and VirtIO Block, SSD emulation on all but VirtIO Block. */
export function busOffers(bus: string): { iothread: boolean; ssd: boolean } {
  return { iothread: bus === 'scsi' || bus === 'virtio', ssd: bus !== 'virtio' };
}

/** Only the options that changed are written: what Proxmox accepted stays byte for byte otherwise. */
export function writeDiskOpts(v: string, o: DiskOpts, was: DiskOpts): string {
  const ch: Record<string, string | undefined> = {};
  if (o.cache !== was.cache) ch.cache = o.cache || undefined;
  if (o.discard !== was.discard) ch.discard = o.discard ? 'on' : undefined;
  if (o.iothread !== was.iothread) ch.iothread = flagValue(o.iothread);
  if (o.ssd !== was.ssd) ch.ssd = flagValue(o.ssd);
  if (o.backup !== was.backup) ch.backup = flagValue(o.backup, true);
  if (o.replicate !== was.replicate) ch.replicate = flagValue(o.replicate, true);
  return editProps(v, ch, 'file');
}

/** A new disk (`STORAGE:SIZE` in GiB) with the options its bus has. */
export function newDiskValue(storage: string, sizeGb: string, bus: string, o: DiskOpts): string {
  const offers = busOffers(bus);
  const eff = { ...o, iothread: o.iothread && offers.iothread, ssd: o.ssd && offers.ssd };
  return writeDiskOpts(`${storage}:${sizeGb.trim()}`, eff, { ...NEW_DISK, iothread: false });
}

const CACHE_WORDS: Record<string, string> = {
  directsync: 'direct sync',
  writethrough: 'write-through cache',
  writeback: 'write-back cache',
  unsafe: 'unsafe write-back cache',
  none: 'no cache',
};

const OPT_WORDS: Record<string, (v: string) => string | null> = {
  cache: (v) => CACHE_WORDS[v] ?? `cache ${v}`,
  discard: (v) => (v === 'on' ? 'discard' : null),
  iothread: (v) => (isOn(v) ? 'IO thread' : null),
  ssd: (v) => (isOn(v) ? 'SSD' : null),
  ro: (v) => (isOn(v) ? 'read-only' : null),
  backup: (v) => (isOn(v, true) ? null : 'left out of backups'),
  replicate: (v) => (isOn(v, true) ? null : 'not replicated'),
};

/** A disk's options in words (“IO thread · discard · left out of backups”); unknown ones as they are. */
export function diskOptsWords(v: string | undefined, skip: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const x of parseProps(v ?? '', 'file')) {
    if (x.bare || ['file', 'volume', 'size', 'media', ...skip].includes(x.key)) continue;
    const word = OPT_WORDS[x.key];
    if (!word) out.push(`${x.key}=${x.value}`);
    else {
      const w = word(x.value);
      if (w) out.push(w);
    }
  }
  return out;
}

/** An unused volume attached again: only its volume (Proxmox fills in the size). */
export const attachValue = (unused: string | undefined): string => diskFile(unused);

/** Why a disk can't move to another storage now, or null. */
export function moveBlocked(cfg: Cfg, key: string, locale?: string | null): string | null {
  if (!cfg?.running) return null;
  if (cfg.kind === 'container') return words(locale).moveStopped;
  if (key === 'tpmstate0') return words(locale).moveTpm;
  return null;
}

/* CD/DVD, cloud-init drive, EFI disk, TPM ------------------------------------------------------------ */

/** A new CD/DVD drive with an image (`local:iso/debian.iso`) or none. */
export const cdromValue = (file: string): string => `${file || 'none'},media=cdrom`;

/** The drive with another image; its old size goes (Proxmox fills in the new one). */
export function withCdromFile(v: string, file: string): string {
  const next = file || 'none';
  return editProps(v, { file: next, ...(next !== diskFile(v) ? { size: undefined } : {}) }, 'file');
}

/** What a drive holds, in words. */
export function discName(file: string, locale?: string | null): string {
  if (!file || file === 'none') return words(locale).noDisc;
  if (file === 'cdrom') return words(locale).ownDrive;
  return file.slice(file.lastIndexOf('/') + 1);
}

export const cloudInitDriveValue = (storage: string): string => `${storage}:cloudinit`;

export const efiDiskValue = (storage: string, preEnrolledKeys: boolean): string =>
  `${storage}:1,efitype=4m${preEnrolledKeys ? ',pre-enrolled-keys=1' : ''}`;

export const tpmValue = (storage: string, version: string): string => `${storage}:1,version=${version}`;

/* Network devices ----------------------------------------------------------------------------------- */

export const NIC_MODELS = ['virtio', 'e1000', 'e1000e', 'rtl8139', 'vmxnet3'] as const;
export const NIC_MODEL_WORDS: Record<string, string> = {
  virtio: 'VirtIO (fastest)',
  e1000: 'Intel E1000',
  e1000e: 'Intel E1000E',
  rtl8139: 'Realtek RTL8139',
  vmxnet3: 'VMware vmxnet3',
};
const isModel = (s: string) => (NIC_MODELS as readonly string[]).includes(s);
const modelIndex = (items: readonly PropItem[]) =>
  items.findIndex((x) => (x.bare ? isModel(x.value) : isModel(x.key)));

/** A VM NIC's model and MAC (“virtio=BC:24:…”, or model= / macaddr=). */
export function nicModel(v: string | undefined): { model: string; mac: string } {
  const items = parseProps(v ?? '');
  const it = items[modelIndex(items)];
  if (it) return it.bare ? { model: it.value, mac: '' } : { model: it.key, mac: it.value };
  return {
    model: getProp(items, 'model') ?? '',
    mac: getProp(items, 'macaddr') ?? getProp(items, 'hwaddr') ?? '',
  };
}

/** A VM NIC with another model, its MAC and other options kept. */
export function withNicModel(v: string, model: string): string {
  const items = parseProps(v);
  const i = modelIndex(items);
  if (i < 0) return formatProps([{ key: model, value: model, bare: true }, ...items]);
  return formatProps(
    items.map((x, j) =>
      j !== i ? x : x.bare ? { key: model, value: model, bare: true } : { key: model, value: x.value },
    ),
  );
}

/** A VM NIC with another MAC (empty: Proxmox makes one), the model and other options kept. */
export function withNicMac(v: string, mac: string): string {
  const items = parseProps(v);
  const i = modelIndex(items);
  if (i < 0) return editProps(v, { macaddr: mac || undefined });
  const it = items[i] as PropItem;
  const model = it.bare ? it.value : it.key;
  const next: PropItem = mac ? { key: model, value: mac } : { key: model, value: model, bare: true };
  return formatProps(items.map((x, j) => (j === i ? next : x)));
}

/** A network device's fields (VM: model and MAC; container: name, MAC and addresses). */
export interface NicFields {
  model: string;
  mac: string;
  name: string;
  bridge: string;
  tag: string;
  firewall: boolean;
  linkDown: boolean;
  rate: string;
  mtu: string;
  ip: IpConfig;
}

export function readNic(v: string | undefined, kind: 'vm' | 'container'): NicFields {
  const items = parseProps(v ?? '');
  const vm = kind === 'vm';
  const m = nicModel(v);
  return {
    model: vm ? m.model : '',
    mac: vm ? m.mac : (getProp(items, 'hwaddr') ?? ''),
    name: vm ? '' : (getProp(items, 'name') ?? ''),
    bridge: getProp(items, 'bridge') ?? '',
    tag: getProp(items, 'tag') ?? '',
    firewall: isOn(getProp(items, 'firewall')),
    linkDown: isOn(getProp(items, 'link_down')),
    rate: getProp(items, 'rate') ?? '',
    mtu: getProp(items, 'mtu') ?? '',
    ip: parseIpConfig(v),
  };
}

/** A new network device: VirtIO with the firewall on; a container's next “ethN” on DHCP. */
export function newNic(kind: 'vm' | 'container', key: string, bridge: string): NicFields {
  return {
    ...readNic('', kind),
    model: kind === 'vm' ? 'virtio' : '',
    name: kind === 'vm' ? '' : `eth${key.replace(/^net/, '')}`,
    bridge,
    firewall: true,
    ip: parseIpConfig('ip=dhcp'),
  };
}

const sameIp = (a: IpConfig, b: IpConfig) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A network device's value: `v` with only the changed fields written (`was` is what the dialog opened with). A new
 * one (`v` "") starts with the model (VM) or the name (container, `type=veth` last).
 */
export function writeNic(v: string, n: NicFields, was: NicFields, kind: 'vm' | 'container'): string {
  const vm = kind === 'vm';
  const fresh = !v;
  const mac = n.mac.trim();
  let out = v;
  if (vm) {
    if (fresh) out = mac ? `${n.model}=${mac}` : n.model;
    else {
      if (n.model !== was.model) out = withNicModel(out, n.model);
      if (mac !== was.mac) out = withNicMac(out, mac);
    }
  } else if (fresh) out = `name=${n.name.trim()}`;
  const ch: Record<string, string | undefined> = {};
  if (!vm && !fresh && n.name.trim() !== was.name) ch.name = n.name.trim();
  if (!vm && mac !== was.mac) ch.hwaddr = mac || undefined;
  if (n.bridge !== was.bridge) ch.bridge = n.bridge || undefined;
  if (n.tag.trim() !== was.tag) ch.tag = n.tag.trim() || undefined;
  if (n.firewall !== was.firewall) ch.firewall = flagValue(n.firewall);
  if (n.linkDown !== was.linkDown) ch.link_down = flagValue(n.linkDown);
  if (n.rate.trim() !== was.rate) ch.rate = n.rate.trim() || undefined;
  if (n.mtu.trim() !== was.mtu) ch.mtu = n.mtu.trim() || undefined;
  out = editProps(out, ch);
  if (!vm && (fresh || !sameIp(n.ip, was.ip))) out = formatIpConfig(n.ip, out);
  if (!vm && fresh) out = editProps(out, { type: 'veth' });
  return out;
}

/** What is wrong with a network device's fields, by field. */
export function nicErrors(
  n: NicFields,
  kind: 'vm' | 'container',
  locale?: string | null,
): Record<string, string | null> {
  return {
    tag: checkNumber(n.tag, { min: 1, max: 4094, optional: true }, locale).error,
    rate: checkNumber(n.rate, { min: 0, optional: true, decimal: true }, locale).error,
    mtu: checkNumber(n.mtu, { min: 576, max: 65_520, optional: true }, locale).error,
    mac: n.mac.trim() ? macError(n.mac.trim(), locale) : null,
    name:
      kind === 'container' && !/^[A-Za-z][A-Za-z0-9_.-]{0,14}$/.test(n.name.trim())
        ? words(locale).nicName
        : null,
    ...(kind === 'container' ? ipErrors(n.ip, locale) : {}),
  };
}

export function macError(s: string, locale?: string | null): string | null {
  const m = /^([0-9a-f]{2})(:[0-9a-f]{2}){5}$/i.exec(s);
  if (!m) return words(locale).mac;
  return Number.parseInt(m[1] ?? '0', 16) & 1 ? words(locale).macGroup : null;
}

/** A network device in words: model (or name), network, VLAN, addresses. */
export function nicWords(v: string | undefined, kind: 'vm' | 'container'): string {
  const items = parseProps(v ?? '');
  const tag = getProp(items, 'tag');
  const head = kind === 'vm' ? nicModel(v).model : getProp(items, 'name');
  return [head, getProp(items, 'bridge'), tag ? `VLAN ${tag}` : '', kind === 'vm' ? '' : ipWords(v)]
    .filter(Boolean)
    .join(' · ');
}

/** A network device's second line: MAC, firewall, disconnected, rate, MTU, gateway. */
export function nicDetails(v: string | undefined, kind: 'vm' | 'container'): string {
  const n = readNic(v, kind);
  return [
    n.mac,
    n.firewall ? 'firewall on' : '',
    n.linkDown ? 'disconnected' : '',
    n.rate ? `at most ${n.rate} MB/s` : '',
    n.mtu ? `MTU ${n.mtu}` : '',
    kind === 'container' && n.ip.gw ? `gateway ${n.ip.gw}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/* Addresses ----------------------------------------------------------------------------------------- */

export interface IpConfig {
  v4: 'dhcp' | 'static' | 'none';
  ip: string;
  gw: string;
  v6: 'auto' | 'dhcp' | 'static' | 'none';
  ip6: string;
  gw6: string;
}

export function parseIpConfig(v: string | undefined): IpConfig {
  const items = parseProps(v ?? '');
  const ip = getProp(items, 'ip') ?? '';
  const ip6 = getProp(items, 'ip6') ?? '';
  return {
    v4: ip === 'dhcp' ? 'dhcp' : ip ? 'static' : 'none',
    ip: ip === 'dhcp' ? '' : ip,
    gw: getProp(items, 'gw') ?? '',
    v6: ip6 === 'auto' ? 'auto' : ip6 === 'dhcp' ? 'dhcp' : ip6 ? 'static' : 'none',
    ip6: ip6 === 'auto' || ip6 === 'dhcp' ? '' : ip6,
    gw6: getProp(items, 'gw6') ?? '',
  };
}

/** Back to a property string, unknown items of `prev` kept. */
export function formatIpConfig(c: IpConfig, prev = ''): string {
  return editProps(prev, {
    ip: c.v4 === 'dhcp' ? 'dhcp' : c.v4 === 'static' ? c.ip.trim() : undefined,
    gw: c.v4 === 'static' && c.gw.trim() ? c.gw.trim() : undefined,
    ip6: c.v6 === 'none' ? undefined : c.v6 === 'static' ? c.ip6.trim() : c.v6,
    gw6: c.v6 === 'static' && c.gw6.trim() ? c.gw6.trim() : undefined,
  });
}

/** Addresses in words (“DHCP”, “10.0.0.5/24”, “IPv6 automatic”). */
export function ipWords(v: string | undefined): string {
  const c = parseIpConfig(v);
  const v4 = c.v4 === 'dhcp' ? 'DHCP' : c.v4 === 'static' ? c.ip : '';
  const v6 =
    c.v6 === 'auto' ? 'IPv6 automatic' : c.v6 === 'dhcp' ? 'IPv6 DHCP' : c.v6 === 'static' ? c.ip6 : '';
  return [v4, v6].filter(Boolean).join(', ');
}

export function cidr4Error(s: string, locale?: string | null): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(s.trim());
  if (!m || m.slice(1, 5).some((x) => Number(x) > 255) || Number(m[5]) > 32) return words(locale).cidr4;
  return null;
}

export function ip4Error(s: string, locale?: string | null): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m || m.slice(1).some((x) => Number(x) > 255)) return words(locale).ip4;
  return null;
}

/** An IPv6 address (one “::” at most, an IPv4 tail allowed). */
function isIp6(s: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(s) || !s.includes(':')) return false;
  const halves = s.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h ? h.split(':') : []));
  let count = groups.length;
  const last = groups[groups.length - 1];
  if (last?.includes('.')) {
    if (ip4Error(last)) return false;
    groups.pop();
    count += 1;
  }
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return false;
  return halves.length === 2 ? count <= 7 : count === 8;
}

export function ip6Error(s: string, locale?: string | null): string | null {
  return isIp6(s.trim()) ? null : words(locale).ip6;
}

export function cidr6Error(s: string, locale?: string | null): string | null {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(s.trim());
  if (!m || !isIp6(m[1] ?? '') || Number(m[2]) > 128) return words(locale).cidr6;
  return null;
}

/** What is wrong with the address fields of a container's network device or a cloud-init config. */
export function ipErrors(
  c: IpConfig,
  locale?: string | null,
): {
  ip: string | null;
  gw: string | null;
  ip6: string | null;
  gw6: string | null;
} {
  return {
    ip: c.v4 === 'static' ? cidr4Error(c.ip, locale) : null,
    gw: c.v4 === 'static' && c.gw.trim() ? ip4Error(c.gw, locale) : null,
    ip6: c.v6 === 'static' ? cidr6Error(c.ip6, locale) : null,
    gw6: c.v6 === 'static' && c.gw6.trim() ? ip6Error(c.gw6, locale) : null,
  };
}

/** DNS servers typed with spaces or commas. */
export const dnsServerList = (text: string): string[] =>
  text
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);

export function dnsServersError(text: string, locale?: string | null): string | null {
  const bad = dnsServerList(text).find((s) => ip4Error(s) && ip6Error(s));
  return bad ? interpolate(words(locale).dns, { value: bad }) : null;
}

export function domainError(text: string, locale?: string | null): string | null {
  return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?( [A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)*$/.test(
    text.trim(),
  )
    ? null
    : words(locale).domain;
}

/* Mount points (containers) ------------------------------------------------------------------------- */

export interface MountFields {
  path: string;
  backup: boolean;
  ro: boolean;
  replicate: boolean;
}

export function readMount(v: string | undefined): MountFields {
  const items = parseProps(v ?? '', 'volume');
  return {
    path: getProp(items, 'mp') ?? '',
    backup: isOn(getProp(items, 'backup')),
    ro: isOn(getProp(items, 'ro')),
    replicate: isOn(getProp(items, 'replicate'), true),
  };
}

/** A mount point with its changed fields written (`v` "": a new volume `STORAGE:SIZE`). */
export function writeMount(v: string, m: MountFields, was: MountFields): string {
  const ch: Record<string, string | undefined> = {};
  if (m.path.trim() !== was.path) ch.mp = m.path.trim();
  if (m.backup !== was.backup) ch.backup = flagValue(m.backup);
  if (m.ro !== was.ro) ch.ro = flagValue(m.ro);
  if (m.replicate !== was.replicate) ch.replicate = flagValue(m.replicate, true);
  return editProps(v, ch, 'volume');
}

export const NEW_MOUNT: MountFields = { path: '/mnt/data', backup: true, ro: false, replicate: true };

export function newMountValue(storage: string, sizeGb: string, m: MountFields): string {
  return writeMount(`${storage}:${sizeGb.trim()}`, m, {
    path: '',
    backup: false,
    ro: false,
    replicate: true,
  });
}

export function mountPathError(path: string, locale?: string | null): string | null {
  const p = path.trim();
  return /^\/[^\s,]+$/.test(p) && p !== '/' ? null : words(locale).mountPath;
}

/* Processors, display, machine ---------------------------------------------------------------------- */

/** A VM's CPU type (“host”, “x86-64-v2-AES”; “cputype=host,flags=+aes”), “” for Proxmox's default. */
export const cpuType = (v: string | undefined): string =>
  v ? (getProp(parseProps(v, 'cputype'), 'cputype') ?? '') : '';

/** The CPU value with another type, its flags kept; “” goes back to Proxmox's default. */
export function withCpuType(cur: string | undefined, type: string): string | undefined {
  if (!type) return undefined;
  return cur ? editProps(cur, { cputype: type }, 'cputype') : type;
}

/** A device's type (display, machine) in its value (“qxl,memory=32”). */
export const typeOf = (v: string | undefined): string =>
  v ? (getProp(parseProps(v, 'type'), 'type') ?? '') : '';

/** Another type, the value's other options kept; “” removes the key. */
export function withType(cur: string | undefined, type: string): string | undefined {
  if (!type) return undefined;
  return cur ? editProps(cur, { type }, 'type') : type;
}

export const VGA_TYPES: readonly { value: string; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'std', label: 'Standard VGA' },
  { value: 'vmware', label: 'VMware compatible' },
  { value: 'qxl', label: 'SPICE (qxl)' },
  { value: 'virtio', label: 'VirtIO GPU' },
  { value: 'virtio-gl', label: 'VirGL GPU' },
  { value: 'cirrus', label: 'Cirrus Logic' },
  { value: 'serial0', label: 'Serial terminal 0' },
  { value: 'none', label: 'None' },
];

/** The machine type: “q35”, a pinned version, or “” for the default (i440fx, “pc”). */
export function machineType(v: string | undefined): string {
  const t = typeOf(v);
  return t === 'pc' ? '' : t;
}

/** Another machine type; back to the default keeps other options as “pc,…”. */
export function withMachineType(cur: string | undefined, type: string): string | undefined {
  if (type) return withType(cur, type);
  const rest = parseProps(cur ?? '', 'type').filter((x) => x.key !== 'type');
  return rest.length ? editProps(cur ?? '', { type: 'pc' }, 'type') : undefined;
}

export const MACHINE_TYPES: readonly { value: string; label: string }[] = [
  { value: '', label: 'Default (i440fx)' },
  { value: 'q35', label: 'q35' },
];

export const SCSI_CONTROLLERS: readonly { value: string; label: string }[] = [
  { value: 'lsi', label: 'LSI 53C895A (default)' },
  { value: 'lsi53c810', label: 'LSI 53C810' },
  { value: 'virtio-scsi-pci', label: 'VirtIO SCSI' },
  { value: 'virtio-scsi-single', label: 'VirtIO SCSI single' },
  { value: 'megasas', label: 'MegaRAID SAS 8708EM2' },
  { value: 'pvscsi', label: 'VMware PVSCSI' },
];

export const BIOS_TYPES: readonly { value: string; label: string }[] = [
  { value: 'seabios', label: 'SeaBIOS (default)' },
  { value: 'ovmf', label: 'OVMF (UEFI)' },
];

/** An option's label, or the value itself when the list doesn't have it. */
export function optionLabel(
  opts: readonly { value: string; label: string }[],
  v: string | undefined,
  fallback = '',
): string {
  return opts.find((o) => o.value === (v ?? ''))?.label ?? v ?? fallback;
}

/* Options ------------------------------------------------------------------------------------------- */

export interface Startup {
  order: string;
  up: string;
  down: string;
}

export function readStartup(v: string | undefined): Startup {
  const items = parseProps(v ?? '');
  return {
    order: getProp(items, 'order') ?? '',
    up: getProp(items, 'up') ?? '',
    down: getProp(items, 'down') ?? '',
  };
}

/** The start order with empty fields left out; undefined when nothing is left. */
export function writeStartup(cur: string | undefined, s: Startup): string | undefined {
  const v = editProps(cur ?? '', {
    order: s.order.trim() || undefined,
    up: s.up.trim() || undefined,
    down: s.down.trim() || undefined,
  });
  return v || undefined;
}

export function startupWords(v: string | undefined): string {
  const s = readStartup(v);
  return [
    s.order ? `in turn ${s.order}` : 'in any order',
    s.up ? `then waits ${s.up} s` : '',
    s.down ? `shutdown timeout ${s.down} s` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export const HOTPLUG = ['disk', 'network', 'usb', 'memory', 'cpu'] as const;
export const HOTPLUG_DEFAULT: readonly string[] = ['network', 'disk', 'usb'];
export const HOTPLUG_WORDS: Record<(typeof HOTPLUG)[number], string> = {
  disk: 'Disks',
  network: 'Network devices',
  usb: 'USB',
  memory: 'Memory',
  cpu: 'Processors',
};

export function hotplugList(v: string | undefined): string[] {
  if (v === undefined || v === '1') return [...HOTPLUG_DEFAULT];
  if (v === '0' || v === '') return [];
  return v.split(',').filter(Boolean);
}

/** The hotplug value: undefined for Proxmox's default (disks, network, USB), “0” for none. */
export function formatHotplug(on: readonly string[]): string | undefined {
  const sorted = HOTPLUG.filter((k) => on.includes(k));
  const isDefault = sorted.length === HOTPLUG_DEFAULT.length && HOTPLUG_DEFAULT.every((k) => on.includes(k));
  if (isDefault) return undefined;
  return sorted.length ? sorted.join(',') : '0';
}

/** The QEMU guest agent: on, trim after a move or clone, its channel, freezing file systems for backups. */
export interface AgentOpts {
  enabled: boolean;
  fstrim: boolean;
  /** “” (VirtIO, the default) or “isa”. */
  type: string;
  freezeFs: boolean;
}

export function readAgent(v: string | undefined): AgentOpts {
  const items = parseProps(v ?? '', 'enabled');
  return {
    enabled: isOn(getProp(items, 'enabled')),
    fstrim: isOn(getProp(items, 'fstrim_cloned_disks')),
    type: getProp(items, 'type') ?? '',
    freezeFs: isOn(getProp(items, 'freeze-fs-on-backup'), true),
  };
}

/**
 * The agent value with what changed written and every other setting kept (“1,fstrim_cloned_disks=1” turned off is
 * “0,fstrim_cloned_disks=1”); undefined when only “off” would be left.
 */
export function writeAgent(cur: string | undefined, a: AgentOpts, was: AgentOpts): string | undefined {
  const ch: Record<string, string | undefined> = {};
  if (a.enabled !== was.enabled) ch.enabled = a.enabled ? '1' : '0';
  if (a.fstrim !== was.fstrim) ch.fstrim_cloned_disks = flagValue(a.fstrim);
  if (a.type !== was.type) ch.type = a.type || undefined;
  if (a.freezeFs !== was.freezeFs) ch['freeze-fs-on-backup'] = flagValue(a.freezeFs, true);
  const v = cur
    ? editProps(cur, ch, 'enabled')
    : formatProps([
        { key: 'enabled', value: a.enabled ? '1' : '0', bare: true },
        ...Object.entries(ch)
          .filter(([k, x]) => k !== 'enabled' && x !== undefined)
          .map(([key, value]) => ({ key, value: value as string })),
      ]);
  return v === '0' || v === 'enabled=0' || v === '' ? undefined : v;
}

export const CT_FEATURES = ['nesting', 'keyctl', 'fuse'] as const;
export type CtFeature = (typeof CT_FEATURES)[number];

export function readFeatures(v: string | undefined): Record<CtFeature, boolean> {
  const items = parseProps(v ?? '');
  return {
    nesting: isOn(getProp(items, 'nesting')),
    keyctl: isOn(getProp(items, 'keyctl')),
    fuse: isOn(getProp(items, 'fuse')),
  };
}

/** Container features with the changed ones written, others (`mount=nfs`) kept; undefined when none is left. */
export function writeFeatures(
  cur: string | undefined,
  f: Record<CtFeature, boolean>,
  was: Record<CtFeature, boolean>,
): string | undefined {
  const ch: Record<string, string | undefined> = {};
  for (const k of CT_FEATURES) if (f[k] !== was[k]) ch[k] = flagValue(f[k]);
  return editProps(cur ?? '', ch) || undefined;
}

export function featuresWords(v: string | undefined): string {
  const items = parseProps(v ?? '');
  const on = CT_FEATURES.filter((k) => isOn(getProp(items, k)));
  const other = items
    .filter((x) => !(CT_FEATURES as readonly string[]).includes(x.key))
    .map((x) => `${x.key}=${x.value}`);
  return [...on, ...other].join(', ') || 'None';
}

export const OS_TYPES: readonly { value: string; label: string }[] = [
  { value: 'l26', label: 'Linux (6.x – 2.6 kernel)' },
  { value: 'l24', label: 'Linux (2.4 kernel)' },
  { value: 'win11', label: 'Windows 11 / 2022 / 2025' },
  { value: 'win10', label: 'Windows 10 / 2016 / 2019' },
  { value: 'win8', label: 'Windows 8.x / 2012 / 2012 R2' },
  { value: 'win7', label: 'Windows 7 / 2008 R2' },
  { value: 'w2k8', label: 'Windows Vista / 2008' },
  { value: 'wxp', label: 'Windows XP / 2003' },
  { value: 'w2k', label: 'Windows 2000' },
  { value: 'solaris', label: 'Solaris' },
  { value: 'other', label: 'Other' },
];

export const CONSOLE_MODES: readonly { value: string; label: string }[] = [
  { value: 'tty', label: 'TTY (default)' },
  { value: 'console', label: '/dev/console' },
  { value: 'shell', label: 'Shell' },
];

/** Windows guests keep the clock in local time unless told otherwise (Proxmox's default by OS type). */
export const localTimeDefault = (ostype: string | undefined): boolean => /^(w|win)/.test(ostype ?? '');

/* Tags ---------------------------------------------------------------------------------------------- */

/** Proxmox tags (“k3s;prod”; older versions wrote “,” or spaces). */
export function parseTags(v: string | undefined): string[] {
  return (v ?? '').split(/[;,\s]+/).filter(Boolean);
}

export function formatTags(tags: readonly string[]): string {
  return tags.join(';');
}

/** Why a tag isn't valid, or null; passed straight to `Array.map`, the index it gets reads as English. */
export function tagError(tag: string, locale?: string | number | null): string | null {
  return /^[a-z0-9_][a-z0-9_+.-]*$/i.test(tag) ? null : words(typeof locale === 'string' ? locale : null).tag;
}

/** Tags typed into the chip editor added to `list` (duplicates ignoring case dropped), or why not. */
export function addTags(
  list: readonly string[],
  raw: string,
  locale?: string | null,
): { tags: string[]; error: string | null } {
  const next = parseTags(raw);
  const error = next.map((t) => tagError(t, locale)).find(Boolean) ?? null;
  if (error) return { tags: [...list], error };
  const out = [...list];
  for (const t of next) if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return { tags: out, error: null };
}

/* Cloud-init ---------------------------------------------------------------------------------------- */

/** Proxmox keeps `sshkeys` URL-encoded (a space is %20, a newline %0A). */
export function encodeSshKeys(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function decodeSshKeys(v: string | undefined): string {
  if (!v) return '';
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Key lines of an SSH key text (no blanks, no comments). */
export function sshKeyLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** “ssh-ed25519 AAAA… john@lab” → “ssh-ed25519 john@lab” (its type and comment). */
export function sshKeyLabel(line: string): string {
  const parts = line.split(/\s+/);
  const i = parts.findIndex((p) => /^(ssh-|ecdsa-|sk-)/.test(p));
  if (i < 0) return line.length > 40 ? `${line.slice(0, 37)}…` : line;
  const comment = parts.slice(i + 2).join(' ');
  return comment ? `${parts[i]} ${comment}` : (parts[i] ?? line);
}

const SSH_KEY_RE = /^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)\s+[A-Za-z0-9+/=]+(\s.*)?$/;

/** The first line that isn't an OpenSSH public key, in words. */
export function sshKeysError(text: string, locale?: string | null): string | null {
  const lines = sshKeyLines(text);
  const bad = lines.findIndex((l) => !SSH_KEY_RE.test(l));
  return bad < 0 ? null : interpolate(words(locale).sshKey, { line: bad + 1 });
}

/** Cloud-init addresses in words (“DHCP”, “10.0.0.5/24 via 10.0.0.1, IPv6 automatic”). */
export function ipConfigWords(v: string | undefined, locale?: string | null): string {
  const w = words(locale);
  if (!v) return w.notSet;
  const c = parseIpConfig(v);
  const via = (ip: string, gw: string) => (gw ? interpolate(w.via, { ip, gw }) : ip);
  const v4 = c.v4 === 'dhcp' ? 'DHCP' : c.v4 === 'static' ? via(c.ip, c.gw) : '';
  const v6 =
    c.v6 === 'auto' ? w.v6Auto : c.v6 === 'dhcp' ? w.v6Dhcp : c.v6 === 'static' ? via(c.ip6, c.gw6) : '';
  return [v4, v6].filter(Boolean).join(', ') || w.none;
}

/* Boot order ---------------------------------------------------------------------------------------- */

/** Devices of `boot: order=scsi0;ide2;net0`. */
export function bootOrder(v: string | undefined): string[] {
  const order = getProp(parseProps(v ?? ''), 'order');
  return order ? order.split(';').filter(Boolean) : [];
}

export function withBootOrder(v: string | undefined, order: readonly string[]): string {
  const items = parseProps(v ?? '');
  const legacy = items.some((x) => x.bare || x.key === 'c' || x.key === 'd' || x.key === 'n');
  return editProps(legacy ? '' : (v ?? ''), { order: order.length ? order.join(';') : undefined });
}

/* High availability (clusters) ---------------------------------------------------------------------- */

export type HaState = 'started' | 'stopped' | 'ignored' | 'disabled';

export const HA_STATES: readonly { value: HaState; label: string; hint: string }[] = [
  { value: 'started', label: 'Started', hint: 'Kept running, and restarted or moved when its server fails.' },
  { value: 'stopped', label: 'Stopped', hint: 'Kept stopped; it can still move to another server.' },
  { value: 'disabled', label: 'Disabled', hint: 'Stopped and left where it is.' },
  { value: 'ignored', label: 'Ignored', hint: 'Left alone, as if high availability were off.' },
];

export interface HaForm {
  state: HaState;
  maxRestart: string;
  maxRelocate: string;
  comment: string;
}

export interface HaNow {
  state: HaState;
  maxRestart?: number;
  maxRelocate?: number;
  comment?: string;
}

export function haForm(ha: HaNow | null | undefined): HaForm {
  return {
    state: ha?.state ?? 'started',
    maxRestart: String(ha?.maxRestart ?? 1),
    maxRelocate: String(ha?.maxRelocate ?? 1),
    comment: ha?.comment ?? '',
  };
}

export function haErrors(
  f: HaForm,
  locale?: string | null,
): { maxRestart: string | null; maxRelocate: string | null } {
  return {
    maxRestart: checkNumber(f.maxRestart, { min: 0, max: 10 }, locale).error,
    maxRelocate: checkNumber(f.maxRelocate, { min: 0, max: 10 }, locale).error,
  };
}

/** `ha.set` params (camelCase; Whombat's server sends `max_restart`, `max_relocate`). */
export function haParams(f: HaForm): Record<string, string | number> {
  return {
    state: f.state,
    maxRestart: Number(f.maxRestart),
    maxRelocate: Number(f.maxRelocate),
    ...(f.comment.trim() ? { comment: f.comment.trim() } : {}),
  };
}

/** The review of an HA change, as `key  old → new`. */
export function haReviewRows(ha: HaNow | null | undefined, f: HaForm): ReviewRow[] {
  const rows: [string, string | undefined, string][] = [
    ['state', ha?.state, f.state],
    ['max_restart', ha ? String(ha.maxRestart ?? 1) : undefined, String(Number(f.maxRestart))],
    ['max_relocate', ha ? String(ha.maxRelocate ?? 1) : undefined, String(Number(f.maxRelocate))],
    ['comment', ha?.comment || undefined, f.comment.trim()],
  ];
  return rows
    .filter(([, old, next]) => (old ?? '') !== next)
    .map(([key, old, next]) => ({ key, old, new: next, op: 'set' as const }));
}

/* Everything else ----------------------------------------------------------------------------------- */

const VM_SHOWN = [
  /^(memory|balloon|cores|sockets|vcpus|cpu|cpulimit|cpuunits|numa|bios|vga|machine|scsihw|efidisk0|tpmstate0|boot)$/,
  /^(name|onboot|startup|ostype|tablet|hotplug|acpi|kvm|localtime|freeze|agent|protection|description|tags)$/,
  DISK_RE,
  NET_RE,
  UNUSED_RE,
];
const CLOUD_INIT_SHOWN = [/^(ciuser|cipassword|sshkeys|nameserver|searchdomain|ciupgrade)$/, IPCONFIG_RE];
const CT_SHOWN = [
  /^(hostname|memory|swap|cores|cpulimit|cpuunits|rootfs|nameserver|searchdomain)$/,
  /^(onboot|startup|ostype|unprivileged|features|cmode|tty|timezone|protection|description|tags)$/,
  MP_RE,
  NET_RE,
  UNUSED_RE,
];
/** Proxmox's own bookkeeping. */
const NEVER_SHOWN = new Set(['meta', 'digest']);

/**
 * Keys no tab has a row for (PCI and USB passthrough, serial ports, `args`, SMBIOS, `lxc.*` …): shown as they are,
 * read-only. `cloudInit`: the guest has the Cloud-Init tab, which shows the cloud-init keys.
 */
export function otherKeys(cfg: Cfg, o: { cloudInit?: boolean } = {}): string[] {
  if (!cfg) return [];
  const shown = cfg.kind === 'vm' ? [...VM_SHOWN, ...(o.cloudInit ? CLOUD_INIT_SHOWN : [])] : CT_SHOWN;
  const all = new Set([...Object.keys(cfg.values), ...Object.keys(cfg.pending ?? {})]);
  return [...all].filter((k) => !NEVER_SHOWN.has(k) && !shown.some((re) => re.test(k))).sort(keyOrder);
}
