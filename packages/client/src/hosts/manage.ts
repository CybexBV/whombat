/**
 * Changes to guests as `hosts.manage` requests (ported from Rackoon's `features/manage/createForm.ts` and
 * `download.ts`): the create forms with the Proxmox wizard's defaults, their checks and the keys they set, the checks of
 * a download to a storage, and the words after a change started. `params` are camelCase; Whombat's server turns them
 * into the hosts service's fields (`newId` → `new_id`). Pure, shared by the web and Android.
 */
import type { HostChoices, HostManageOp, HostManageReadResult } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { HOSTS_ACTIONS_WORDS } from '../i18n/messages/connectionsHosts/actions';
import { cidr4Error, ip4Error } from './config';

export type FormErrors<F> = Partial<Record<keyof F, string>>;

/* The forms ----------------------------------------------------------------------------------------- */

export interface VmCreateForm {
  vmid: string;
  name: string;
  /** `local:iso/debian-13.iso`, or '' for an empty drive. */
  iso: string;
  ostype: string;
  storage: string;
  diskGb: string;
  cores: string;
  sockets: string;
  cpu: string;
  memoryMb: string;
  bridge: string;
  vlan: string;
  model: string;
  firewall: boolean;
  bios: 'seabios' | 'ovmf';
  machine: 'i440fx' | 'q35';
  tpm: boolean;
  agent: boolean;
  onboot: boolean;
  start: boolean;
}

export interface CtCreateForm {
  vmid: string;
  hostname: string;
  /** `local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst`. */
  template: string;
  password: string;
  /** One public key per line. */
  sshKeys: string;
  storage: string;
  diskGb: string;
  cores: string;
  memoryMb: string;
  swapMb: string;
  bridge: string;
  vlan: string;
  firewall: boolean;
  ipv4: 'dhcp' | 'static' | 'none';
  ip4: string;
  gw4: string;
  ipv6: 'auto' | 'dhcp' | 'static' | 'none';
  ip6: string;
  gw6: string;
  nameserver: string;
  searchdomain: string;
  nesting: boolean;
  onboot: boolean;
  start: boolean;
}

export interface IncusCreateForm {
  name: string;
  type: 'container' | 'vm';
  /** A local alias or fingerprint, or `images:debian/13`. */
  image: string;
  profiles: string[];
  pool: string;
  cpu: string;
  memoryMb: string;
  rootGb: string;
  /** '' = from the profiles. */
  network: string;
  start: boolean;
}

/** Guest OS types the create form offers; Windows ones get the Windows preset. */
export const CREATE_OS_TYPES: readonly { value: string; label: string; windows?: boolean }[] = [
  { value: 'l26', label: 'Linux (6.x or 2.6 kernel)' },
  { value: 'win11', label: 'Windows 11, Server 2022 or 2025', windows: true },
  { value: 'win10', label: 'Windows 10, Server 2016 or 2019', windows: true },
  { value: 'other', label: 'Something else' },
];

/** Network card models, VirtIO first (the one to use unless the guest lacks its driver). */
export const CREATE_NIC_MODELS: readonly { value: string; label: string }[] = [
  { value: 'virtio', label: 'VirtIO (fastest)' },
  { value: 'e1000e', label: 'Intel E1000E' },
  { value: 'e1000', label: 'Intel E1000' },
  { value: 'rtl8139', label: 'Realtek RTL8139' },
  { value: 'vmxnet3', label: 'VMware vmxnet3' },
];

const DEFAULT_CPU = 'x86-64-v2-AES';

/** Storages of a host that hold what is asked (`images`, `rootdir`, `backup`, `iso`, `vztmpl`, `import`). */
export function storagesFor(choices: HostChoices | undefined, content: string): HostChoices['storages'] {
  return (choices?.storages ?? []).filter((s) => s.content.includes(content));
}

/** A volume a form offers (an ISO image, a container template): its volume id and its name. */
export interface VolumeChoice {
  volume: string;
  name: string;
  storage: string;
}

/** The hub's volume objects (`{volume, name, storage}`; older shapes `{volid}`) as choices. */
export function volumeChoices(items: readonly Record<string, unknown>[] | undefined): VolumeChoice[] {
  const out: VolumeChoice[] = [];
  for (const i of items ?? []) {
    const volume = String(i.volume ?? i.volid ?? '');
    if (!volume) continue;
    out.push({
      volume,
      name: String(i.name ?? volume.split('/').pop() ?? volume),
      storage: String(i.storage ?? volume.split(':')[0] ?? ''),
    });
  }
  return out;
}

export function vmDefaults(c: HostChoices | undefined): VmCreateForm {
  const cpus = c?.cpuTypes ?? [];
  return {
    vmid: c?.nextId ? String(c.nextId) : '',
    name: '',
    iso: volumeChoices(c?.isos)[0]?.volume ?? '',
    ostype: 'l26',
    storage: storagesFor(c, 'images')[0]?.id ?? '',
    diskGb: '32',
    cores: '2',
    sockets: '1',
    cpu: !cpus.length || cpus.includes(DEFAULT_CPU) ? DEFAULT_CPU : (cpus[0] as string),
    memoryMb: '2048',
    bridge: c?.bridges[0] ?? 'vmbr0',
    vlan: '',
    model: 'virtio',
    firewall: true,
    bios: 'seabios',
    machine: 'i440fx',
    tpm: false,
    agent: true,
    onboot: false,
    start: true,
  };
}

export function isWindows(ostype: string): boolean {
  return CREATE_OS_TYPES.find((o) => o.value === ostype)?.windows ?? false;
}

/**
 * A new guest OS type: Windows gets the Windows preset, as Proxmox's wizard sets it (UEFI with an EFI disk, q35, a
 * TPM: Windows 11 needs both); going back to another type leaves the rest as it is.
 */
export function withOsType(f: VmCreateForm, ostype: string): VmCreateForm {
  return isWindows(ostype) ? { ...f, ostype, bios: 'ovmf', machine: 'q35', tpm: true } : { ...f, ostype };
}

/**
 * The ISO to install from after the guest OS changed: a Windows one for Windows (not the VirtIO driver disc), else
 * what was picked, unless that was a Windows one.
 */
export function preferredIso(isos: readonly VolumeChoice[], ostype: string, current: string): string {
  const win = (v: VolumeChoice) => /win/i.test(v.name) && !/virtio/i.test(v.name);
  const now = isos.find((i) => i.volume === current);
  if (isWindows(ostype)) return now && win(now) ? current : (isos.find(win)?.volume ?? current);
  if (now && win(now)) return isos.find((i) => !win(i) && !/virtio/i.test(i.name))?.volume ?? current;
  return current;
}

/** UEFI (OVMF) goes with q35, as in Proxmox's wizard; SeaBIOS with the default machine. */
export function withBios(f: VmCreateForm, bios: VmCreateForm['bios']): VmCreateForm {
  return { ...f, bios, machine: bios === 'ovmf' ? 'q35' : 'i440fx' };
}

export function ctDefaults(c: HostChoices | undefined): CtCreateForm {
  return {
    vmid: c?.nextId ? String(c.nextId) : '',
    hostname: '',
    template: volumeChoices(c?.ctTemplates)[0]?.volume ?? '',
    password: '',
    sshKeys: '',
    storage: storagesFor(c, 'rootdir')[0]?.id ?? '',
    diskGb: '8',
    cores: '1',
    memoryMb: '512',
    swapMb: '512',
    bridge: c?.bridges[0] ?? 'vmbr0',
    vlan: '',
    firewall: true,
    ipv4: 'dhcp',
    ip4: '',
    gw4: '',
    ipv6: 'none',
    ip6: '',
    gw6: '',
    nameserver: '',
    searchdomain: '',
    nesting: true,
    onboot: false,
    start: true,
  };
}

interface IncusImage {
  fingerprint?: string;
  aliases?: string[];
  type?: string;
}

/** Incus images on the host of a type (`container` or `virtual-machine`). */
export function incusImages(c: HostChoices | undefined, type: IncusCreateForm['type']): IncusImage[] {
  const want = type === 'vm' ? 'virtual-machine' : 'container';
  return ((c?.images ?? []) as IncusImage[]).filter((i) => i.type === want);
}

export function incusImageRef(i: IncusImage | undefined): string | undefined {
  return i?.aliases?.[0] ?? i?.fingerprint;
}

export function incusDefaults(c: HostChoices | undefined): IncusCreateForm {
  return {
    name: '',
    type: 'container',
    image: incusImageRef(incusImages(c, 'container')[0]) ?? 'images:debian/13',
    profiles: c?.profiles?.includes('default') ? ['default'] : [],
    pool: c?.storages[0]?.id ?? '',
    cpu: '',
    memoryMb: '',
    rootGb: '',
    network: '',
    start: true,
  };
}

/* Checks -------------------------------------------------------------------------------------------- */

const DNS_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const intIn = (v: string, lo: number, hi: number) => /^\d+$/.test(v.trim()) && +v >= lo && +v <= hi;

/** A DNS name: what Proxmox takes for a VM's name and a container's host name. */
export function guestNameError(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Give it a name.';
  if (n.length > 253 || !n.split('.').every((l) => DNS_LABEL.test(l)))
    return 'Letters, digits and “-”, with dots between parts.';
  return undefined;
}

const vmidError = (v: string) =>
  !v.trim() || intIn(v, 100, 999_999_999) ? undefined : 'Use a number from 100 to 999999999.';
const vlanError = (v: string) => (!v.trim() || intIn(v, 1, 4094) ? undefined : 'Use a VLAN from 1 to 4094.');
const coresError = (v: string) => (intIn(v, 1, 512) ? undefined : 'Use 1 to 512 cores.');
const memoryError = (v: string) => (intIn(v, 16, 16_777_216) ? undefined : 'Use at least 16 MiB.');
const diskError = (v: string) => (intIn(v, 1, 65_536) ? undefined : 'Use 1 to 65536 GiB.');
const CIDR6 = /^[0-9a-fA-F:]+\/\d{1,3}$/;
const IP6 = /^[0-9a-fA-F:]+$/;

export function vmErrors(f: VmCreateForm): FormErrors<VmCreateForm> {
  return {
    vmid: vmidError(f.vmid),
    name: guestNameError(f.name),
    storage: f.storage ? undefined : 'Pick a storage.',
    diskGb: diskError(f.diskGb),
    cores: coresError(f.cores),
    sockets: intIn(f.sockets, 1, 16) ? undefined : 'Use 1 to 16 sockets.',
    memoryMb: memoryError(f.memoryMb),
    bridge: f.bridge ? undefined : 'Pick a network.',
    vlan: vlanError(f.vlan),
  };
}

export function ctErrors(f: CtCreateForm): FormErrors<CtCreateForm> {
  return {
    vmid: vmidError(f.vmid),
    hostname: guestNameError(f.hostname),
    template: f.template ? undefined : 'Pick a template.',
    password: !f.password || f.password.length >= 5 ? undefined : 'At least 5 characters.',
    storage: f.storage ? undefined : 'Pick a storage.',
    diskGb: diskError(f.diskGb),
    cores: coresError(f.cores),
    memoryMb: memoryError(f.memoryMb),
    swapMb: intIn(f.swapMb, 0, 16_777_216) ? undefined : 'Use 0 MiB or more.',
    bridge: f.bridge ? undefined : 'Pick a network.',
    vlan: vlanError(f.vlan),
    ip4: f.ipv4 === 'static' ? (cidr4Error(f.ip4) ?? undefined) : undefined,
    gw4: f.ipv4 === 'static' && f.gw4.trim() ? (ip4Error(f.gw4) ?? undefined) : undefined,
    ip6:
      f.ipv6 === 'static' && !CIDR6.test(f.ip6.trim())
        ? 'An IPv6 address with its prefix, like fd00::5/64.'
        : undefined,
    gw6: f.ipv6 === 'static' && f.gw6.trim() && !IP6.test(f.gw6.trim()) ? 'An IPv6 address.' : undefined,
  };
}

export function incusErrors(f: IncusCreateForm): FormErrors<IncusCreateForm> {
  return {
    name: guestNameError(f.name) ?? (f.name.includes('.') ? 'Incus names have no dots.' : undefined),
    image: f.image.trim() ? undefined : 'Pick an image.',
    cpu: !f.cpu.trim() || intIn(f.cpu, 1, 512) ? undefined : 'Use 1 to 512 CPUs.',
    memoryMb: !f.memoryMb.trim() ? undefined : memoryError(f.memoryMb),
    rootGb: !f.rootGb.trim() ? undefined : diskError(f.rootGb),
  };
}

export function hasErrors(e: Record<string, string | undefined>): boolean {
  return Object.values(e).some(Boolean);
}

/**
 * The platform's field errors (`net0`, `scsi0`, `ssh-public-keys`) on the form's fields; keys without a field stay
 * out (the dialog shows the message).
 */
export function createFieldErrors<F>(
  fields: Record<string, string>,
  map: Record<string, keyof F>,
): FormErrors<F> {
  const out: FormErrors<F> = {};
  for (const [k, v] of Object.entries(fields)) {
    const f = map[k] ?? map[k.replace(/\d+$/, '')];
    if (f) out[f] = v;
  }
  return out;
}

export const VM_ERROR_FIELDS: Record<string, keyof VmCreateForm> = {
  name: 'name',
  newId: 'vmid',
  new_id: 'vmid',
  vmid: 'vmid',
  scsi: 'storage',
  efidisk: 'storage',
  tpmstate: 'storage',
  ide: 'iso',
  net: 'bridge',
  memory: 'memoryMb',
  cores: 'cores',
  sockets: 'sockets',
  cpu: 'cpu',
};

export const CT_ERROR_FIELDS: Record<string, keyof CtCreateForm> = {
  name: 'hostname',
  hostname: 'hostname',
  newId: 'vmid',
  new_id: 'vmid',
  ostemplate: 'template',
  password: 'password',
  'ssh-public-keys': 'sshKeys',
  rootfs: 'storage',
  memory: 'memoryMb',
  swap: 'swapMb',
  cores: 'cores',
  net: 'bridge',
  nameserver: 'nameserver',
  searchdomain: 'searchdomain',
};

/* What a create sends --------------------------------------------------------------------------------- */

const newId = (v: string) => (v.trim() ? { newId: Number(v.trim()) } : {});

/** `guest.create` params for a Proxmox VM: the disk on VirtIO SCSI single with an IO thread, the ISO on ide2. */
export function vmCreateParams(f: VmCreateForm) {
  const net = [
    `${f.model},bridge=${f.bridge}`,
    f.vlan.trim() ? `tag=${f.vlan.trim()}` : '',
    f.firewall ? 'firewall=1' : '',
  ]
    .filter(Boolean)
    .join(',');
  const set: Record<string, string> = {
    ostype: f.ostype,
    scsihw: 'virtio-scsi-single',
    scsi0: `${f.storage}:${f.diskGb.trim()},iothread=1`,
    ide2: `${f.iso || 'none'},media=cdrom`,
    boot: 'order=scsi0;ide2;net0',
    cores: f.cores.trim(),
    sockets: f.sockets.trim(),
    cpu: f.cpu,
    memory: f.memoryMb.trim(),
    net0: net,
    agent: f.agent ? '1' : '0',
  };
  if (f.machine === 'q35') set.machine = 'q35';
  if (f.bios === 'ovmf') {
    set.bios = 'ovmf';
    set.efidisk0 = `${f.storage}:1,efitype=4m,pre-enrolled-keys=1`;
  }
  if (f.tpm) set.tpmstate0 = `${f.storage}:1,version=v2.0`;
  if (f.onboot) set.onboot = '1';
  return {
    platform: 'pve' as const,
    kind: 'vm' as const,
    ...newId(f.vmid),
    name: f.name.trim(),
    start: f.start,
    set,
  };
}

/** `guest.create` params for a Proxmox container: always unprivileged. */
export function ctCreateParams(f: CtCreateForm) {
  const net = ['name=eth0', `bridge=${f.bridge}`];
  if (f.vlan.trim()) net.push(`tag=${f.vlan.trim()}`);
  if (f.firewall) net.push('firewall=1');
  if (f.ipv4 === 'dhcp') net.push('ip=dhcp');
  if (f.ipv4 === 'static') net.push(`ip=${f.ip4.trim()}`, ...(f.gw4.trim() ? [`gw=${f.gw4.trim()}`] : []));
  if (f.ipv6 === 'auto' || f.ipv6 === 'dhcp') net.push(`ip6=${f.ipv6}`);
  if (f.ipv6 === 'static') net.push(`ip6=${f.ip6.trim()}`, ...(f.gw6.trim() ? [`gw6=${f.gw6.trim()}`] : []));
  const set: Record<string, string> = {
    ostemplate: f.template,
    rootfs: `${f.storage}:${f.diskGb.trim()}`,
    cores: f.cores.trim(),
    memory: f.memoryMb.trim(),
    swap: f.swapMb.trim(),
    net0: net.join(','),
    unprivileged: '1',
  };
  if (f.nesting) set.features = 'nesting=1';
  if (f.password) set.password = f.password;
  const keys = f.sshKeys
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  if (keys) set['ssh-public-keys'] = keys;
  if (f.nameserver.trim())
    set.nameserver = f.nameserver
      .trim()
      .split(/[\s,]+/)
      .join(' ');
  if (f.searchdomain.trim()) set.searchdomain = f.searchdomain.trim();
  if (f.onboot) set.onboot = '1';
  return {
    platform: 'pve' as const,
    kind: 'container' as const,
    ...newId(f.vmid),
    name: f.hostname.trim(),
    start: f.start,
    set,
  };
}

/** Incus managed networks (incusbr0, lxdbr0) attach with `network=`; other host bridges as bridged NICs. */
export function incusNic(network: string): string {
  return /^(incus|lxd)br\d+$/.test(network)
    ? `type=nic,network=${network},name=eth0`
    : `type=nic,nictype=bridged,parent=${network},name=eth0`;
}

/** `guest.create` params for an Incus instance; what is left empty comes from its profiles. */
export function incusCreateParams(f: IncusCreateForm) {
  const set: Record<string, string> = {};
  if (f.cpu.trim()) set['limits.cpu'] = f.cpu.trim();
  if (f.memoryMb.trim()) set['limits.memory'] = `${f.memoryMb.trim()}MiB`;
  if (f.rootGb.trim() || (f.pool && f.pool !== 'default'))
    set['device.root'] = [
      'type=disk',
      'path=/',
      `pool=${f.pool || 'default'}`,
      ...(f.rootGb.trim() ? [`size=${f.rootGb.trim()}GiB`] : []),
    ].join(',');
  if (f.network) set['device.eth0'] = incusNic(f.network);
  return {
    platform: 'incus' as const,
    kind: f.type,
    name: f.name.trim(),
    image: f.image.trim(),
    profiles: f.profiles,
    start: f.start,
    set,
  };
}

/** “= 2 GiB” under a memory field. */
export function gibHint(mb: string): string | undefined {
  return /^\d+$/.test(mb.trim()) ? `= ${Math.round((Number(mb) / 1024) * 100) / 100} GiB` : undefined;
}

/* Templates ----------------------------------------------------------------------------------------- */

export type HostTemplate = NonNullable<HostChoices['templates']>[number];

/** A template as the guest dialogs take it (Clone, Delete): its hub id and VMID, always stopped. */
export function templateGuest(t: HostTemplate) {
  return {
    id: t.id.includes(':') ? t.id : `pve:${t.id}`,
    name: t.name,
    kind: t.kind,
    state: 'stopped' as const,
    platform: 'pve' as const,
    vmid: Number(t.id.split(':').pop()),
  };
}

/* Storage content ----------------------------------------------------------------------------------- */

export type StorageContent = 'iso' | 'vztmpl' | 'import';
export const STORAGE_CONTENTS: readonly StorageContent[] = ['iso', 'vztmpl', 'import'];

export const CONTENT_WORDS: Record<StorageContent, string> = {
  iso: 'ISO images',
  vztmpl: 'Container templates',
  import: 'Imports',
};

const CONTENT_EXT: Record<StorageContent, RegExp> = {
  iso: /\.(iso|img)$/i,
  vztmpl: /\.tar\.(gz|xz|zst)$/i,
  import: /\.(ova|ovf|qcow2|vmdk|raw|img)$/i,
};

export const CONTENT_EXT_HINT: Record<StorageContent, string> = {
  iso: '.iso or .img',
  vztmpl: '.tar.zst, .tar.xz or .tar.gz',
  import: '.ova, .qcow2, .vmdk, .raw or .img',
};

/** The kinds of files a storage holds that Whombat lists (its `content`, comma-separated or a list). */
export function storageContents(content: string | readonly string[]): StorageContent[] {
  const have = typeof content === 'string' ? content.split(',').map((c) => c.trim()) : content;
  return STORAGE_CONTENTS.filter((c) => have.includes(c));
}

/** Whether a storage gets Contents… (ISO images, container templates or imports). */
export function hasContents(content: string | readonly string[]): boolean {
  return storageContents(content).length > 0;
}

export interface ContentItem {
  volume: string;
  name: string;
  sizeBytes: number | null;
  created: string | null;
}

/** A `content.list` answer as rows, by name, only files of the asked kind. */
export function contentItems(data: HostManageReadResult | undefined, content: StorageContent): ContentItem[] {
  if (!data || (data.op !== 'content.list' && data.op !== 'appliance.list')) return [];
  const out: ContentItem[] = [];
  for (const i of data.items as Record<string, unknown>[]) {
    const volume = String(i.volume ?? i.volid ?? '');
    if (!volume) continue;
    const name = String(i.name ?? volume.split('/').pop() ?? volume);
    if (i.content ? i.content !== content : !CONTENT_EXT[content].test(name)) continue;
    const size = i.sizeBytes ?? i.size;
    out.push({
      volume,
      name,
      sizeBytes: typeof size === 'number' ? size : null,
      created: typeof i.created === 'string' ? i.created : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface Appliance {
  template: string;
  headline: string;
  description: string;
  version: string;
  section: string;
}

/** Proxmox's template catalogue (`appliance.list`) as rows. */
export function appliances(data: HostManageReadResult | undefined): Appliance[] {
  if (data?.op !== 'appliance.list') return [];
  return (data.items as Record<string, unknown>[])
    .map((a) => ({
      template: String(a.template ?? ''),
      headline: String(a.headline ?? a.package ?? a.template ?? ''),
      description: String(a.description ?? ''),
      version: String(a.version ?? ''),
      section: String(a.section ?? ''),
    }))
    .filter((a) => a.template);
}

export const APPLIANCE_SECTIONS: Record<string, string> = {
  system: 'Systems',
  turnkeylinux: 'TurnKey',
  mail: 'Mail',
};

/** Appliances matching a search and a section. */
export function filterAppliances(list: readonly Appliance[], q: string, section: string): Appliance[] {
  const needle = q.trim().toLowerCase();
  return list.filter(
    (a) =>
      (!section || a.section === section) &&
      (!needle || `${a.headline} ${a.template} ${a.description}`.toLowerCase().includes(needle)),
  );
}

/* Download from a link ------------------------------------------------------------------------------ */

export const CHECKSUM_ALGORITHMS = ['sha256', 'sha512', 'sha384', 'sha224', 'sha1', 'md5'] as const;
export type ChecksumAlgorithm = (typeof CHECKSUM_ALGORITHMS)[number];
const SUM_LEN: Record<ChecksumAlgorithm, number> = {
  md5: 32,
  sha1: 40,
  sha224: 56,
  sha256: 64,
  sha384: 96,
  sha512: 128,
};

/** The link's last part as a file name Proxmox takes (“” when there is none): decoded, odd characters as “_”. */
export function filenameFromUrl(url: string): string {
  let path: string;
  try {
    path = new URL(url.trim()).pathname;
  } catch {
    return '';
  }
  const last = path.split('/').filter(Boolean).pop() ?? '';
  let name: string;
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  return name
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 200);
}

export function downloadUrlError(url: string): string | undefined {
  const u = url.trim();
  if (!u) return 'Paste the link to the file.';
  let p: URL;
  try {
    p = new URL(u);
  } catch {
    return 'That isn’t a link.';
  }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return 'Use a link that starts with https://.';
  if (p.username || p.password) return 'Leave the user name and password out of the link.';
  return undefined;
}

export function downloadNameError(name: string, content: StorageContent): string | undefined {
  const n = name.trim();
  if (!n) return 'Give the file a name.';
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(n)) return 'Letters, digits, “.”, “_” and “-” only.';
  if (!CONTENT_EXT[content].test(n)) return `The name ends in ${CONTENT_EXT_HINT[content]}.`;
  return undefined;
}

export function checksumError(sum: string, algorithm: ChecksumAlgorithm | ''): string | undefined {
  const s = sum.trim();
  if (!algorithm) return undefined;
  if (!s) return 'Paste the checksum, or choose not to check it.';
  if (!/^[0-9a-fA-F]+$/.test(s)) return 'The checksum is letters a to f and digits.';
  return s.length === SUM_LEN[algorithm]
    ? undefined
    : `A ${algorithm.toUpperCase()} checksum has ${SUM_LEN[algorithm]} characters.`;
}

/** `content.download` params; the checksum only when one is given. */
export function downloadParams(d: {
  storage: string;
  content: StorageContent;
  url: string;
  filename: string;
  algorithm: ChecksumAlgorithm | '';
  checksum: string;
}) {
  return {
    platform: 'pve' as const,
    storage: d.storage,
    content: d.content,
    url: d.url.trim(),
    filename: d.filename.trim(),
    ...(d.algorithm && d.checksum.trim()
      ? { checksum: d.checksum.trim().toLowerCase(), checksumAlgorithm: d.algorithm }
      : {}),
  };
}

/* Words --------------------------------------------------------------------------------------------- */

/** The words after a change was accepted: done, or started on the host (its result comes as a task). */
export function manageDoneText(
  op: HostManageOp,
  name: string,
  started: boolean,
  locale?: string | null,
): string {
  const done = clientTree(locale, HOSTS_ACTIONS_WORDS).done;
  const w = Object.hasOwn(done, op) ? done[op as keyof typeof done] : done.other;
  return interpolate(started ? w.started : w.done, { name });
}
