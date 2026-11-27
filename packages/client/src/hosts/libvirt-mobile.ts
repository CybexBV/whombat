/**
 * A QEMU/KVM virtual machine (libvirt) and a QEMU/KVM server on the phone (Whombat incus-unraid.md IU-13; app
 * docs/decisions/incus-unraid-mobile.md AP-1642…AP-1646): the VM's five tabs and header line, its Settings read in
 * groups (processors, memory, CD/DVD, disks, network, options, firmware) with the everyday edits — vCPUs, memory,
 * start with the server, notes and the CD/DVD's ISO — and their review, the checks of Clone, Rename and a restore as
 * new, its backups' rows, and the server's facts, pools, networks and hints. Libvirt's configuration keys are the
 * contracts' PVE-like ones (`vcpus`, `memory_mb`, `autostart`, `description`, `cdrom<N>`, …). Pure: times come in as
 * arguments. A VM of an Unraid server gets all of it too.
 */
import type {
  HostBackupVolume,
  HostGuest,
  HostGuestConfig,
  HostGuestDetail,
  HostHint,
  HostLibvirtDetail,
} from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { HOSTS_LIBVIRT_WORDS } from '../i18n/messages/connectionsHosts/libvirt';
import { type ConfigDraft, currentValue, getProp, keysOf, parseProps, reviewRows, trimDraft } from './config';
import { DASH, formatBytesBinary, formatRelativeDay, mibText } from './format';
import { hintGuest, type IncusPhoneTab, poolTone } from './incus-mobile';
import { isLibvirtServer, libvirtNameError } from './libvirt';

/** The web's checks, one source (stream WQ's `libvirt.ts`). */
export { isLibvirtServer, libvirtNameError };

const words = (locale?: string | null) => clientTree(locale, HOSTS_LIBVIRT_WORDS);
const has = <T extends object>(o: T, k: string): k is Extract<keyof T, string> => Object.hasOwn(o, k);

/* Tabs and header ------------------------------------------------------------------------------------------------- */

/** A libvirt VM's tabs on the phone (IU-13): the Incus instance's five while Manage is on, else the Summary. */
export function phoneLibvirtTabs(g: Pick<HostGuestDetail, 'manageable'>): IncusPhoneTab[] {
  return g.manageable ? ['summary', 'settings', 'snapshots', 'backups', 'tasks'] : ['summary'];
}

/** “kvm-lab”: the server; “QEMU/KVM VM” is the mark's words (`guestKind`, less-is-more.md AP-1810). */
export function libvirtHeadLine(g: Pick<HostGuest, 'node' | 'serverId'>): string {
  return g.node ?? g.serverId;
}

/* Values in words ------------------------------------------------------------------------------------------------- */

/** The file name of a path or `pool/volume`. */
const fileName = (s: string) => s.split('/').pop() ?? s;

/** A libvirt key in words (“vCPUs”, “CD/DVD (cdrom0)”). */
export function libvirtKeyLabel(key: string, locale?: string | null): string {
  const w = words(locale);
  if (/^cdrom\d+$/.test(key)) return interpolate(w.keyCdrom, { key });
  if (/^disk\d+$/.test(key)) return interpolate(w.keyDisk, { key });
  if (/^net\d+$/.test(key)) return interpolate(w.keyNet, { key });
  return has(w.keys, key) ? w.keys[key] : key;
}

/** A libvirt value as the phone shows it. */
export function libvirtValueWords(key: string, v: string | undefined, locale?: string | null): string {
  const w = words(locale);
  const s = v?.trim() ?? '';
  if (/^cdrom\d+$/.test(key)) {
    const src = getProp(parseProps(s), 'source');
    return !src || src === 'empty' ? w.values.empty : fileName(src);
  }
  switch (key) {
    case 'memory_mb':
    case 'memory_max_mb':
      return /^\d+$/.test(s) ? mibText(Number(s)) : s || DASH;
    case 'vcpus':
    case 'vcpus_max':
      return /^\d+$/.test(s) ? w.values.vcpus(Number(s)) : s || DASH;
    case 'autostart':
      return s === '1' ? w.values.yes : w.values.no;
    case 'cpu_mode':
      return has(w.cpuModes, s) ? w.cpuModes[s] : s.startsWith('custom:') ? s.slice(7) : s || DASH;
    case 'on_poweroff':
    case 'on_reboot':
    case 'on_crash':
      return has(w.on, s) ? w.on[s] : s || DASH;
    case 'boot': {
      const boot = w.boot;
      return (
        s
          .split(',')
          .filter(Boolean)
          .map((b) => (b !== 'joiner' && has(boot, b) ? boot[b] : b))
          .join(boot.joiner) || DASH
      );
    }
    case 'firmware':
      return s === 'uefi' ? 'UEFI' : s === 'bios' ? 'BIOS' : s || DASH;
    case 'secure_boot':
    case 'tpm':
      return s === '1' || s === 'true' ? w.values.on : w.values.off;
    case 'description':
      return s || w.values.none;
    default:
      return s || w.values.unset;
  }
}

/* Settings (read) ------------------------------------------------------------------------------------------------- */

export type LibvirtEditKind = 'vcpus' | 'memory' | 'autostart' | 'description' | 'cdrom';

export interface LibvirtSettingRow {
  id: string;
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
  edit?: LibvirtEditKind;
  /** The CD/DVD drive an ISO edit changes (`cdrom0`). */
  key?: string;
  locked?: boolean;
}

export interface LibvirtSettingGroup {
  id: 'processors' | 'memory' | 'cdrom' | 'disks' | 'network' | 'options' | 'firmware';
  title: string;
  rows: LibvirtSettingRow[];
}

/** Under a key only virt-manager or the VM's XML changes. */
export const LIBVIRT_LOCKED = words('en').locked;
/** The line and link at the bottom of a VM's Settings, in a locale (English when none is given). */
export function libvirtWebOnly(locale?: string | null): string {
  return words(locale).webOnly;
}
/** The line and link at the bottom of a VM's Settings (IU-13). */
export const LIBVIRT_WEB_ONLY = libvirtWebOnly('en');

/**
 * A libvirt VM's configuration in the phone's groups, read as it is (a change waiting for the next start after an
 * arrow), the everyday edits marked and what libvirt keeps to its XML locked.
 */
export function libvirtSettingGroups(cfg: HostGuestConfig, locale?: string | null): LibvirtSettingGroup[] {
  const all = words(locale);
  const w = all.settings;
  const v = (k: string) => currentValue(cfg, k);
  const restricted = new Set(cfg.restricted ?? []);
  const later = (k: string) =>
    cfg.pending && k in cfg.pending
      ? interpolate(w.later, { value: libvirtValueWords(k, cfg.pending[k], locale) })
      : '';
  const row = (id: string, key: string, edit?: LibvirtEditKind, extra: Partial<LibvirtSettingRow> = {}) => {
    const out: LibvirtSettingRow = {
      id,
      label: libvirtKeyLabel(key, locale),
      value: `${libvirtValueWords(key, cfg.values[key] ?? v(key), locale)}${later(key)}`,
      ...extra,
    };
    if (restricted.has(key)) {
      out.locked = true;
      out.sub = all.locked;
    } else if (edit) out.edit = edit;
    return out;
  };

  const processors: LibvirtSettingRow[] = [row('vcpus', 'vcpus', 'vcpus')];
  if (v('vcpus_max') && v('vcpus_max') !== v('vcpus')) processors.push(row('vcpus_max', 'vcpus_max'));
  if (v('cpu_mode')) processors.push(row('cpu_mode', 'cpu_mode'));

  const memory: LibvirtSettingRow[] = [row('memory', 'memory_mb', 'memory')];
  if (v('memory_max_mb') && v('memory_max_mb') !== v('memory_mb'))
    memory.push(row('memory_max', 'memory_max_mb'));

  const cdrom: LibvirtSettingRow[] = keysOf(cfg, /^cdrom\d+$/).map((k) => {
    const r = row(k, k, 'cdrom', { key: k });
    const src = getProp(parseProps(v(k) ?? ''), 'source');
    if (src && src !== 'empty' && !r.locked) r.sub = src;
    return r;
  });

  const disks: LibvirtSettingRow[] = keysOf(cfg, /^disk\d+$/).map((k) => {
    const p = parseProps(v(k) ?? '');
    const size = Number(getProp(p, 'size'));
    const disk = cfg.disks?.find((d) => d.key === k);
    return {
      id: k,
      label: interpolate(w.disk, { target: getProp(p, 'target') ?? k }),
      value: [
        disk?.sizeBytes != null
          ? formatBytesBinary(disk.sizeBytes)
          : Number.isFinite(size) && size > 0
            ? formatBytesBinary(size)
            : null,
        getProp(p, 'bus'),
        getProp(p, 'format'),
      ]
        .filter(Boolean)
        .join(' · '),
      sub: getProp(p, 'source') ?? undefined,
      mono: true,
    };
  });

  const network: LibvirtSettingRow[] = keysOf(cfg, /^net\d+$/).map((k) => {
    const p = parseProps(v(k) ?? '');
    const net = getProp(p, 'network');
    const bridge = getProp(p, 'bridge');
    const on = net
      ? interpolate(w.network, { name: net })
      : bridge
        ? interpolate(w.bridge, { name: bridge })
        : DASH;
    return {
      id: k,
      label: k,
      value: on,
      sub: [getProp(p, 'model'), getProp(p, 'mac'), getProp(p, 'link') === 'down' ? w.linkDown : null]
        .filter(Boolean)
        .join(' · '),
      mono: true,
    };
  });

  const options: LibvirtSettingRow[] = [
    row('autostart', 'autostart', 'autostart'),
    row('description', 'description', 'description'),
  ];
  if (v('title')) options.unshift(row('title', 'title'));
  if (v('boot')) options.push(row('boot', 'boot'));
  for (const k of ['on_poweroff', 'on_reboot', 'on_crash']) if (v(k)) options.push(row(k, k));

  const firmware: LibvirtSettingRow[] = ['machine', 'firmware', 'secure_boot', 'tpm']
    .filter((k) => v(k) !== undefined)
    .map((k) => ({ ...row(k, k), mono: k === 'machine' }));

  return [
    { id: 'processors', title: w.processors, rows: processors },
    { id: 'memory', title: w.memory, rows: memory },
    ...(cdrom.length ? [{ id: 'cdrom' as const, title: w.cdrom, rows: cdrom }] : []),
    {
      id: 'disks',
      title: w.disks,
      rows: disks.length ? disks : [{ id: 'none', label: w.noDisk, value: '' }],
    },
    {
      id: 'network',
      title: w.networkTitle,
      rows: network.length ? network : [{ id: 'none', label: w.noNic, value: '' }],
    },
    { id: 'options', title: w.options, rows: options },
    ...(firmware.length ? [{ id: 'firmware' as const, title: w.firmware, rows: firmware }] : []),
  ];
}

/* Settings (edits) ------------------------------------------------------------------------------------------------ */

export interface LibvirtEditInput {
  text: string;
  on: boolean;
  /** The ISO for a CD/DVD drive (its volid or path), “” for empty. */
  iso: string;
}

export interface LibvirtEditSpec {
  title: string;
  field: string;
  kind: 'number' | 'multiline' | 'switch' | 'iso';
  hint?: string;
}

export function libvirtEditSpec(
  kind: LibvirtEditKind,
  name: string,
  cfg?: HostGuestConfig,
  locale?: string | null,
): LibvirtEditSpec {
  const w = words(locale).edit;
  const title = (t: string) => interpolate(t, { name });
  switch (kind) {
    case 'vcpus': {
      const max = cfg ? currentValue(cfg, 'vcpus_max') : undefined;
      return {
        title: title(w.vcpusTitle),
        field: w.vcpusField,
        kind: 'number',
        ...(max ? { hint: interpolate(w.vcpusHint, { max }) } : {}),
      };
    }
    case 'memory':
      return { title: title(w.memoryTitle), field: w.memoryField, kind: 'number', hint: w.memoryHint };
    case 'autostart':
      return { title: title(w.autostartTitle), field: w.autostartField, kind: 'switch' };
    case 'description':
      return { title: title(w.notesTitle), field: w.notesField, kind: 'multiline' };
    case 'cdrom':
      return { title: title(w.cdromTitle), field: w.cdromField, kind: 'iso' };
  }
}

/** The value an edit starts from (the pending one first). */
export function libvirtEditStart(
  cfg: HostGuestConfig,
  kind: LibvirtEditKind,
  key?: string,
): LibvirtEditInput {
  const base: LibvirtEditInput = { text: '', on: false, iso: '' };
  switch (kind) {
    case 'vcpus':
      return { ...base, text: currentValue(cfg, 'vcpus') ?? '' };
    case 'memory':
      return { ...base, text: currentValue(cfg, 'memory_mb') ?? '' };
    case 'autostart':
      return { ...base, on: currentValue(cfg, 'autostart') === '1' };
    case 'description':
      return { ...base, text: currentValue(cfg, 'description') ?? '' };
    case 'cdrom': {
      const src = getProp(parseProps(currentValue(cfg, key ?? 'cdrom0') ?? ''), 'source');
      return { ...base, iso: !src || src === 'empty' ? '' : src };
    }
  }
}

/** The change an edit's fields describe, trimmed to what differs (null with what is wrong). */
export function libvirtEditDraft(
  cfg: HostGuestConfig,
  kind: LibvirtEditKind,
  input: LibvirtEditInput,
  key?: string,
  locale?: string | null,
): { draft: ConfigDraft | null; error: string | null } {
  const w = words(locale).edit;
  const done = (d: ConfigDraft) => ({ draft: trimDraft(cfg, d), error: null });
  const text = input.text.trim();
  const whole = (min: number, max?: number) => {
    if (!text) return w.fillIn;
    if (!/^\d+$/.test(text)) return w.wholeNumber;
    const n = Number(text);
    if (n < min) return interpolate(w.atLeast, { n: min });
    if (max != null && n > max) return interpolate(w.atMost, { n: max });
    return null;
  };
  switch (kind) {
    case 'vcpus': {
      const bad = whole(1, 512);
      return bad ? { draft: null, error: bad } : done({ set: { vcpus: text } });
    }
    case 'memory': {
      const bad = whole(64);
      return bad ? { draft: null, error: bad } : done({ set: { memory_mb: text } });
    }
    case 'autostart':
      return done({ set: { autostart: input.on ? '1' : '0' } });
    case 'description':
      if (input.text.trim()) return done({ set: { description: input.text } });
      return done(currentValue(cfg, 'description')?.trim() ? { delete: ['description'] } : {});
    case 'cdrom': {
      const k = key ?? 'cdrom0';
      const p = parseProps(currentValue(cfg, k) ?? '');
      const bus = getProp(p, 'bus') ?? 'sata';
      return done({ set: { [k]: `source=${input.iso || 'empty'},bus=${bus}` } });
    }
  }
}

export interface LibvirtReviewLine {
  key: string;
  label: string;
  old: string;
  new: string;
}

/** The review's lines in libvirt's words (“Memory  4 GiB → 8 GiB”, “CD/DVD (cdrom0)  Empty → debian-13.iso”). */
export function libvirtReviewLines(
  cfg: HostGuestConfig,
  draft: ConfigDraft,
  locale?: string | null,
): LibvirtReviewLine[] {
  const removed = words(locale).values.removed;
  return reviewRows(cfg, draft).map((r) => ({
    key: r.key,
    label: libvirtKeyLabel(r.key, locale),
    old: libvirtValueWords(r.key, r.old, locale),
    new: r.op === 'delete' ? removed : libvirtValueWords(r.key, r.new, locale),
  }));
}

/** A running VM takes more vCPUs or memory than its maximum at the next start: the review says so. */
export function libvirtReviewNote(
  cfg: HostGuestConfig,
  draft: ConfigDraft,
  locale?: string | null,
): string | null {
  const set = draft.set ?? {};
  if (!cfg.running || !('vcpus' in set || 'memory_mb' in set)) return null;
  return words(locale).edit.reviewNote;
}

/** The ISOs a CD/DVD can take (`choices.isos`: `{volid, name, sizeBytes}`), empty first. */
export function isoChoices(
  isos: readonly Record<string, unknown>[] | undefined,
  current: string,
  locale?: string | null,
): { value: string; label: string }[] {
  const list = (isos ?? [])
    .map((i) => ({
      value: String(i.volid ?? i.path ?? i.name ?? ''),
      label: String(i.name ?? fileName(String(i.volid ?? ''))),
    }))
    .filter((i) => i.value);
  const out = [{ value: '', label: words(locale).values.empty }, ...list];
  return current && !out.some((o) => o.value === current)
    ? [...out, { value: current, label: fileName(current) }]
    : out;
}

/* Backups ---------------------------------------------------------------------------------------------------------- */

export interface LibvirtBackupRow {
  volume: string;
  /** “Today 02:00”, or “win11 · Today 02:00” in a server's list. */
  title: string;
  /** “12 GiB”. */
  line: string;
  label: string;
  backup: HostBackupVolume;
}

/** A VM's backups (`storage: libvirt`), newest first. */
export function libvirtBackupRows(
  items: readonly HostBackupVolume[],
  now: number,
  timeZone?: string,
  nameOf?: (b: HostBackupVolume) => string | null,
  locale?: string | null,
): LibvirtBackupRow[] {
  return [...items]
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
    .map((b) => {
      const when = b.created ? formatRelativeDay(Date.parse(b.created), now, timeZone, locale) : DASH;
      const who = nameOf?.(b) ?? null;
      const title = who ? `${who} · ${when}` : when;
      const line = [b.sizeBytes != null ? formatBytesBinary(b.sizeBytes) : null, b.notes || null]
        .filter(Boolean)
        .join(' · ');
      return { volume: b.volume, title, line, label: [title, line].filter(Boolean).join(', '), backup: b };
    });
}

/* A QEMU/KVM server ------------------------------------------------------------------------------------------------ */

/** The libvirt card's facts: libvirt and QEMU, what new VMs can have, where backups go. */
export function libvirtFacts(
  d: HostLibvirtDetail,
  locale?: string | null,
): { label: string; value: string }[] {
  const w = words(locale).facts;
  const fw = [
    d.firmware.uefi ? 'UEFI' : null,
    d.firmware.secureBoot ? 'Secure Boot' : null,
    d.firmware.tpm ? 'TPM' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const out: { label: string; value: string }[] = [{ label: 'libvirt', value: d.version }];
  if (d.qemu) out.push({ label: 'QEMU', value: d.qemu });
  out.push({ label: w.firmware, value: fw || w.biosOnly });
  const nets = d.networks.filter((n) => n.active).map((n) => n.name);
  if (nets.length) out.push({ label: w.networks, value: nets.join(', ') });
  if (d.backupsDir) out.push({ label: w.backupsTo, value: d.backupsDir });
  return out;
}

export interface LibvirtPoolRow {
  name: string;
  /** “dir · 12 volumes”, “Not active”. */
  line: string;
  usedText: string;
  pct: number | null;
  tone: 'warn' | 'bad' | null;
  label: string;
}

/** The storage pools with their use (warn from 85 %, `libvirt.pool_full`), or unRAID's VM folders. */
export function libvirtPoolRows(d: HostLibvirtDetail, locale?: string | null): LibvirtPoolRow[] {
  const w = words(locale).pools;
  if (!d.pools.length && d.folders)
    return [
      ...(d.folders.domains
        ? [
            {
              name: w.vmDisks,
              line: d.folders.domains,
              usedText: '',
              pct: null,
              tone: null,
              label: interpolate(w.vmDisksIn, { folder: d.folders.domains }),
            },
          ]
        : []),
      ...(d.folders.isos
        ? [
            {
              name: w.isos,
              line: d.folders.isos,
              usedText: '',
              pct: null,
              tone: null,
              label: interpolate(w.isosIn, { folder: d.folders.isos }),
            },
          ]
        : []),
    ];
  return d.pools.map((p) => {
    const pct = p.totalBytes > 0 ? (p.usedBytes / p.totalBytes) * 100 : null;
    const usedText =
      p.totalBytes > 0
        ? interpolate(w.used, {
            used: formatBytesBinary(p.usedBytes),
            total: formatBytesBinary(p.totalBytes),
          })
        : '';
    const line = p.active ? [p.type, w.volumes(p.volumes)].join(' · ') : w.notActive;
    return {
      name: p.name,
      line,
      usedText,
      pct,
      tone: poolTone(pct),
      label: [p.name, line, usedText].filter(Boolean).join(', '),
    };
  });
}

/** Where a libvirt hint is fixed on the phone (IU-13): no recent backup → the VM's Backups. */
export function libvirtHintWayOut(
  kind: string,
  locale?: string | null,
): { label: string; to: 'backups' } | null {
  return kind === 'libvirt.no_backup' ? { label: words(locale).backItUp, to: 'backups' } : null;
}

/** The VMs a server's “no recent backup” hints name, for its Backups segment. */
export function noBackupGuests<G extends Pick<HostGuest, 'id' | 'name'>>(
  hints: readonly HostHint[],
  serverId: string,
  guests: readonly G[],
): G[] {
  const out: G[] = [];
  for (const h of hints) {
    if (h.serverId !== serverId || h.kind !== 'libvirt.no_backup') continue;
    const g = hintGuest(h, guests) ?? guests.find((x) => x.id === `libvirt:${h.entity}`) ?? null;
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}
