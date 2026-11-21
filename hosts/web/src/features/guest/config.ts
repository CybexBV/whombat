// Pure helpers of the guest configuration tabs: the value an edit starts
// from (pending first, as Proxmox's own dialogs do), the review rows of a
// change, sizes, disk and NIC keys, boot order, tags, cloud-init SSH keys
// and IP configs. No React here (config.test.ts covers it).

import type { ConfigPatch, GuestConfig } from '../../api/manage';
import { t } from '../../lib/i18n';
import { editProps, formatProps, getProp, parseProps, type PropItem } from './props';

/** What the platform masks: shown as "set", never as a value. */
export const MASK = '**********';
export const SECRET_KEYS = new Set(['cipassword', 'password']);

/** The value an edit starts from: the pending one when a restart is due, else the current one. */
export function current(cfg: GuestConfig | undefined, key: string): string | undefined {
  if (!cfg) return undefined;
  if (cfg.pending && key in cfg.pending) return cfg.pending[key];
  if (cfg.pending_delete?.includes(key)) return undefined;
  return cfg.values[key];
}

/** The value of a row and what it becomes after the next restart. */
export interface RowValue {
  value: string | undefined;
  /** Set: the value after the restart ("" when it is removed then). */
  next?: string;
  removed?: boolean;
}

export function rowValue(cfg: GuestConfig, key: string): RowValue {
  const value = cfg.values[key];
  if (cfg.pending && key in cfg.pending) return { value, next: cfg.pending[key] };
  if (cfg.pending_delete?.includes(key)) return { value, next: '', removed: true };
  return { value };
}

/** Keys with a change waiting for a restart. */
export function pendingKeys(cfg: GuestConfig | undefined): string[] {
  if (!cfg) return [];
  return [...new Set([...Object.keys(cfg.pending ?? {}), ...(cfg.pending_delete ?? [])])].sort(keyOrder);
}

/** Natural order of config keys: scsi2 before scsi10. */
export function keyOrder(a: string, b: string): number {
  const ma = /^(\D+)(\d+)$/.exec(a);
  const mb = /^(\D+)(\d+)$/.exec(b);
  if (ma && mb && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]);
  return a.localeCompare(b);
}

/** A change without the digest (useConfigChange adds it). */
export type ConfigDraft = Omit<ConfigPatch, 'digest'>;

export interface ReviewRow {
  key: string;
  old?: string;
  new?: string;
  op: 'set' | 'delete' | 'revert';
}

/** `key: old → new` rows of a change against the loaded configuration; unchanged keys drop out. */
export function reviewRows(cfg: GuestConfig | undefined, d: ConfigDraft): ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const k of d.revert ?? []) {
    if (cfg?.pending && k in cfg.pending) rows.push({ key: k, old: cfg.pending[k], new: cfg.values[k], op: 'revert' });
    else if (cfg?.pending_delete?.includes(k)) rows.push({ key: k, old: '', new: cfg.values[k], op: 'revert' });
  }
  for (const [k, v] of Object.entries(d.set ?? {})) {
    const old = current(cfg, k);
    if (old === v && !SECRET_KEYS.has(k)) continue;
    rows.push({ key: k, old, new: v, op: 'set' });
  }
  for (const k of d.delete ?? []) {
    const old = current(cfg, k);
    if (old === undefined) continue;
    rows.push({ key: k, old, op: 'delete' });
  }
  return rows;
}

/** Drop keys whose value does not change, so a review only sends what differs. */
export function trimDraft(cfg: GuestConfig | undefined, d: ConfigDraft): ConfigDraft {
  const set: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.set ?? {})) if (current(cfg, k) !== v || SECRET_KEYS.has(k)) set[k] = v;
  const del = (d.delete ?? []).filter((k) => current(cfg, k) !== undefined);
  return {
    ...(Object.keys(set).length ? { set } : {}),
    ...(del.length ? { delete: del } : {}),
    ...(d.revert?.length ? { revert: d.revert } : {}),
    ...(d.confirm ? { confirm: true } : {}),
  };
}

/** A draft from key -> value; undefined removes the key (dropped by trimDraft when it is not set). */
export function draftOf(entries: Record<string, string | undefined>): ConfigDraft {
  const set: Record<string, string> = {};
  const del: string[] = [];
  for (const [k, v] of Object.entries(entries)) {
    if (v === undefined) del.push(k);
    else set[k] = v;
  }
  return { set, delete: del };
}

/** A flag as Proxmox stores it: the default is written by leaving the key out. */
export function flagValue(on: boolean, defaultOn = false): string | undefined {
  if (on === defaultOn) return undefined;
  return on ? '1' : '0';
}

export function isEmptyDraft(d: ConfigDraft): boolean {
  return !Object.keys(d.set ?? {}).length && !d.delete?.length && !d.revert?.length;
}

/** A displayable value: secrets as "set", empty as "(none)". */
export function shownValue(key: string, v: string | undefined): string {
  if (v === undefined || v === '') return t('(none)');
  if (SECRET_KEYS.has(key)) return t('(set)');
  return v;
}

// ---------------------------------------------------------------- sizes

const UNITS: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };

/** "64G", "709474K", "40GiB", "1.5T" -> bytes (Proxmox and Incus spellings), or undefined. */
export function parseSize(s: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTP]?)(?:i?B)?$/i.exec(s?.trim() ?? '');
  if (!m) return undefined;
  return Math.round(Number(m[1]) * UNITS[m[2]!.toUpperCase()]!);
}

/** Bytes as GiB / MiB / TiB with at most one decimal ("64 GiB", "4 MiB", "1.5 TiB"). */
export function formatSize(bytes: number | undefined): string {
  if (bytes == null) return '';
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ''));
  if (bytes >= 1024 ** 4) return `${fmt(bytes / 1024 ** 4)} TiB`;
  if (bytes >= 1024 ** 3) return `${fmt(bytes / 1024 ** 3)} GiB`;
  if (bytes >= 1024 ** 2) return `${fmt(bytes / 1024 ** 2)} MiB`;
  return `${fmt(bytes / 1024)} KiB`;
}

/** The size= of a disk value in bytes. */
export function diskSize(v: string | undefined): number | undefined {
  return parseSize(getProp(parseProps(v ?? ''), 'size'));
}

/** MiB as "16 GiB" or "512 MiB" (the hint under memory fields). */
export function mibText(mib: number): string {
  if (!Number.isFinite(mib)) return '';
  return mib >= 1024 ? `${Number.isInteger(mib / 1024) ? mib / 1024 : (mib / 1024).toFixed(2).replace(/0$/, '')} GiB` : `${mib} MiB`;
}

/** A number field's value and what is wrong with it (empty is fine when optional). */
export function checkNumber(s: string, o: { min?: number; max?: number; optional?: boolean; decimal?: boolean } = {}): { n: number | null; error: string | null } {
  const v = s.trim();
  if (!v) return { n: null, error: o.optional ? null : t('Required.') };
  if (!(o.decimal ? /^\d+(\.\d+)?$/ : /^\d+$/).test(v)) return { n: null, error: o.decimal ? t('Enter a number.') : t('Enter a whole number.') };
  const n = Number(v);
  if (o.min != null && n < o.min) return { n, error: t('At least {n}.', { n: o.min }) };
  if (o.max != null && n > o.max) return { n, error: t('At most {n}.', { n: o.max }) };
  return { n, error: null };
}

// ---------------------------------------------------------------- disks, NICs

export const VM_BUSES = { scsi: 31, virtio: 16, sata: 6, ide: 4 } as const;
export type VmBus = keyof typeof VM_BUSES;

/** The first free key of a bus ("scsi1"), counting pending keys as taken; null when the bus is full. */
export function freeKey(cfg: GuestConfig | undefined, prefix: string, max: number): string | null {
  const taken = new Set([...Object.keys(cfg?.values ?? {}), ...Object.keys(cfg?.pending ?? {})]);
  for (let i = 0; i < max; i++) if (!taken.has(`${prefix}${i}`)) return `${prefix}${i}`;
  return null;
}

/** Keys of a family in natural order ("net0", "net1", ...), including pending ones. */
export function keysOf(cfg: GuestConfig | undefined, re: RegExp): string[] {
  const all = new Set([...Object.keys(cfg?.values ?? {}), ...Object.keys(cfg?.pending ?? {})]);
  return [...all].filter((k) => re.test(k)).sort(keyOrder);
}

export const DISK_RE = /^(ide|sata|scsi|virtio)\d+$/;
export const isCdrom = (v: string | undefined): boolean => /(^|,)media=cdrom(,|$)/.test(v ?? '');
/** The volume of a disk value ("local-zfs:vm-100-disk-0", "none", "local:iso/x.iso"). */
export const diskFile = (v: string | undefined): string => (v ?? '').split(',')[0] ?? '';
/** The storage of a volume ("local-zfs"), or "". */
export const volumeStorage = (vol: string): string => (vol.includes(':') ? vol.slice(0, vol.indexOf(':')) : '');

export const NIC_MODELS = ['virtio', 'e1000', 'e1000e', 'rtl8139', 'vmxnet3'] as const;

/** A VM NIC's model and MAC: "virtio=BC:24:…" (or model= / macaddr=). */
export function nicModel(v: string | undefined): { model: string; mac: string } {
  const items = parseProps(v ?? '');
  const it = items[modelIndex(items)];
  if (it) return it.bare ? { model: it.value, mac: '' } : { model: it.key, mac: it.value };
  return { model: getProp(items, 'model') ?? '', mac: getProp(items, 'macaddr') ?? '' };
}

const isModel = (s: string) => (NIC_MODELS as readonly string[]).includes(s);
const modelIndex = (items: PropItem[]) => items.findIndex((x) => (x.bare ? isModel(x.value) : isModel(x.key)));

/** A VM NIC with another model, keeping the MAC and every other option. */
export function withNicModel(v: string, model: string): string {
  const items = parseProps(v);
  const i = modelIndex(items);
  // Without a MAC Proxmox generates one ("virtio,bridge=vmbr0").
  if (i < 0) return formatProps([{ key: model, value: model, bare: true }, ...items]);
  return formatProps(items.map((x, j) => (j !== i ? x : x.bare ? { key: model, value: model, bare: true } : { key: model, value: x.value })));
}

// ---------------------------------------------------------------- boot order

/** Devices of `boot: order=scsi0;ide2;net0` (legacy "cdn" values give []). */
export function bootOrder(v: string | undefined): string[] {
  const order = getProp(parseProps(v ?? ''), 'order');
  return order ? order.split(';').filter(Boolean) : [];
}

export function withBootOrder(v: string | undefined, order: string[]): string {
  const items = parseProps(v ?? '');
  // A legacy value ("cdn", or "c" with bootdisk) has no order=; the new syntax replaces it.
  const legacy = items.some((x) => x.bare || x.key === 'c' || x.key === 'd' || x.key === 'n');
  return editProps(legacy ? '' : (v ?? ''), { order: order.length ? order.join(';') : undefined });
}

// ---------------------------------------------------------------- tags

/** Proxmox tags ("k3s;prod"; older versions also wrote "," or spaces). */
export function parseTags(v: string | undefined): string[] {
  return (v ?? '').split(/[;,\s]+/).filter(Boolean);
}

export function formatTags(tags: string[]): string {
  return tags.join(';');
}

/** Proxmox's tag rule (pve-tag: [a-z0-9_][a-z0-9_+.-]*, any case). */
export function tagError(tag: string): string | null {
  return /^[a-z0-9_][a-z0-9_+.-]*$/i.test(tag) ? null : t('Tags start with a letter, digit or “_” and use letters, digits, “_”, “+”, “.” and “-”.');
}

// ---------------------------------------------------------------- cloud-init

/**
 * Proxmox keeps `sshkeys` URL-encoded (Perl's uri_escape: everything but
 * A-Z a-z 0-9 - . _ ~, so a space is %20 and a newline %0A).
 */
export function encodeSshKeys(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function decodeSshKeys(v: string | undefined): string {
  if (!v) return '';
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Non-empty, non-comment lines of an SSH key text. */
export function sshKeyLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** "ssh-ed25519 … admin@lab" -> "ssh-ed25519 admin@lab" (type and comment). */
export function sshKeyLabel(line: string): string {
  const parts = line.split(/\s+/);
  const i = parts.findIndex((p) => /^(ssh-|ecdsa-|sk-)/.test(p));
  if (i < 0) return line.length > 40 ? `${line.slice(0, 37)}…` : line;
  const comment = parts.slice(i + 2).join(' ');
  return comment ? `${parts[i]} ${comment}` : parts[i]!;
}

/** A cloud-init IP config ("ip=dhcp,ip6=auto,gw=…"). */
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

/** Back to a property string, keeping unknown items of `prev`. */
export function formatIpConfig(c: IpConfig, prev = ''): string {
  return editProps(prev, {
    ip: c.v4 === 'dhcp' ? 'dhcp' : c.v4 === 'static' ? c.ip.trim() : undefined,
    gw: c.v4 === 'static' && c.gw.trim() ? c.gw.trim() : undefined,
    ip6: c.v6 === 'none' ? undefined : c.v6 === 'static' ? c.ip6.trim() : c.v6,
    gw6: c.v6 === 'static' && c.gw6.trim() ? c.gw6.trim() : undefined,
  });
}

/** "10.0.0.5/24": an IPv4 address with a prefix length. */
export function cidr4Error(s: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(s.trim());
  if (!m || m.slice(1, 5).some((x) => Number(x) > 255) || Number(m[5]) > 32) return t('An IPv4 address with a prefix length, like 10.0.0.5/24.');
  return null;
}

export function ip4Error(s: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m || m.slice(1).some((x) => Number(x) > 255)) return t('An IPv4 address, like 10.0.0.1.');
  return null;
}

export function cidr6Error(s: string): string | null {
  return /^[0-9a-f:]+\/\d{1,3}$/i.test(s.trim()) && s.includes(':') ? null : t('An IPv6 address with a prefix length, like fd00::5/64.');
}
