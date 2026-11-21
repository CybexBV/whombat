// The create dialog's forms (docs/MANAGE.md, Create): defaults like the
// Proxmox VE wizard (virtio-scsi-single, x86-64-v2-AES, a virtio NIC on the
// first bridge, guest agent on; containers unprivileged with nesting and
// DHCP) and the mapping of each form to CreateGuestInput. Pure, unit tested.

import type { Choices, CreateGuestInput } from '../../api/manage';
import { t } from '../../lib/i18n';

export type FormErrors<F> = Partial<Record<keyof F, string>>;

export interface VmForm {
  vmid: string;
  name: string;
  /** ISO volume ("local:iso/debian-13.iso") or "" for no media. */
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
  machine: 'q35' | 'i440fx';
  agent: boolean;
  tpm: boolean;
  start: boolean;
}

export interface CtForm {
  vmid: string;
  hostname: string;
  template: string;
  password: string;
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
  start: boolean;
}

export interface IncusForm {
  name: string;
  type: 'container' | 'vm';
  /** A local alias or fingerprint, or "images:debian/13". */
  image: string;
  profiles: string[];
  pool: string;
  cpu: string;
  memoryMb: string;
  rootGb: string;
  /** "" = from the profiles. */
  network: string;
  start: boolean;
}

export const OS_TYPES: { value: string; label: string; windows?: boolean }[] = [
  { value: 'l26', label: 'Linux 6.x – 2.6 kernel' },
  { value: 'win11', label: 'Windows 11 / 2022 / 2025', windows: true },
  { value: 'win10', label: 'Windows 10 / 2016 / 2019', windows: true },
  { value: 'other', label: t('Other') },
];

export const NIC_MODELS = ['virtio', 'e1000e', 'e1000', 'rtl8139', 'vmxnet3'];

/** Storages of the host that hold this content (images, rootdir, iso, vztmpl, backup, import). */
export function storagesWith(choices: Choices | undefined, content: string) {
  return (choices?.storages ?? []).filter((s) => s.content.includes(content));
}

export function vmDefaults(c: Choices | undefined): VmForm {
  return {
    vmid: c?.next_id ? String(c.next_id) : '',
    name: '',
    iso: c?.isos?.[0]?.volume ?? '',
    ostype: 'l26',
    storage: storagesWith(c, 'images')[0]?.id ?? '',
    diskGb: '32',
    cores: '2',
    sockets: '1',
    cpu: c?.cpu_types?.includes('x86-64-v2-AES') || !c?.cpu_types?.length ? 'x86-64-v2-AES' : c.cpu_types[0]!,
    memoryMb: '2048',
    bridge: c?.bridges[0] ?? 'vmbr0',
    vlan: '',
    model: 'virtio',
    firewall: true,
    bios: 'seabios',
    machine: 'q35',
    agent: true,
    tpm: false,
    start: false,
  };
}

/** Windows guests want UEFI and a TPM (Windows 11 needs both), as the Proxmox wizard sets them. */
export function withOsType(f: VmForm, ostype: string): VmForm {
  const windows = OS_TYPES.find((o) => o.value === ostype)?.windows ?? false;
  return windows ? { ...f, ostype, bios: 'ovmf', machine: 'q35', tpm: true } : { ...f, ostype };
}

export function ctDefaults(c: Choices | undefined): CtForm {
  return {
    vmid: c?.next_id ? String(c.next_id) : '',
    hostname: '',
    template: c?.ct_templates?.[0]?.volume ?? '',
    password: '',
    sshKeys: '',
    storage: storagesWith(c, 'rootdir')[0]?.id ?? '',
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
    start: false,
  };
}

export function incusDefaults(c: Choices | undefined): IncusForm {
  const local = c?.images?.find((i) => i.type === 'container');
  return {
    name: '',
    type: 'container',
    image: local?.aliases?.[0] ?? local?.fingerprint ?? 'images:debian/13',
    profiles: c?.profiles?.includes('default') ? ['default'] : [],
    pool: c?.storages[0]?.id ?? '',
    cpu: '',
    memoryMb: '',
    rootGb: '',
    network: '',
    start: true,
  };
}

// ---------------------------------------------------------------- checks

const DNS_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** A DNS name (what Proxmox accepts for VM names and container host names). */
export function nameError(name: string): string | undefined {
  const n = name.trim();
  if (!n) return t('Enter a name.');
  if (n.length > 253 || !n.split('.').every((l) => DNS_LABEL.test(l))) return t('Use letters, digits and “-” (a DNS name, dots between parts).');
  return undefined;
}

const intIn = (v: string, min: number, max: number) => /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max;

function vmidError(v: string): string | undefined {
  if (!v.trim()) return undefined; // the next free one
  return intIn(v, 100, 999_999_999) ? undefined : t('Use an ID from 100 to 999999999.');
}

function vlanError(v: string): string | undefined {
  return !v.trim() || intIn(v, 1, 4094) ? undefined : t('Use a VLAN tag from 1 to 4094.');
}

const CIDR4 = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const IP4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const CIDR6 = /^[0-9a-fA-F:]+\/\d{1,3}$/;

export function validateVm(f: VmForm): FormErrors<VmForm> {
  return {
    vmid: vmidError(f.vmid),
    name: nameError(f.name),
    storage: f.storage ? undefined : t('Choose a storage.'),
    diskGb: intIn(f.diskGb, 1, 65_536) ? undefined : t('Use a size from 1 to 65536 GiB.'),
    cores: intIn(f.cores, 1, 512) ? undefined : t('Use 1 to 512 cores.'),
    sockets: intIn(f.sockets, 1, 16) ? undefined : t('Use 1 to 16 sockets.'),
    memoryMb: intIn(f.memoryMb, 16, 16_777_216) ? undefined : t('Use at least 16 MiB.'),
    vlan: vlanError(f.vlan),
  };
}

export function validateCt(f: CtForm): FormErrors<CtForm> {
  return {
    vmid: vmidError(f.vmid),
    hostname: nameError(f.hostname),
    template: f.template ? undefined : t('Choose a template.'),
    password: !f.password || f.password.length >= 5 ? undefined : t('Use at least 5 characters.'),
    storage: f.storage ? undefined : t('Choose a storage.'),
    diskGb: intIn(f.diskGb, 1, 65_536) ? undefined : t('Use a size from 1 to 65536 GiB.'),
    cores: intIn(f.cores, 1, 512) ? undefined : t('Use 1 to 512 cores.'),
    memoryMb: intIn(f.memoryMb, 16, 16_777_216) ? undefined : t('Use at least 16 MiB.'),
    swapMb: intIn(f.swapMb, 0, 16_777_216) ? undefined : t('Use 0 MiB or more.'),
    vlan: vlanError(f.vlan),
    ip4: f.ipv4 !== 'static' || CIDR4.test(f.ip4.trim()) ? undefined : t('Use an address with prefix, like 10.0.0.5/24.'),
    gw4: f.ipv4 !== 'static' || !f.gw4.trim() || IP4.test(f.gw4.trim()) ? undefined : t('Use an IPv4 address.'),
    ip6: f.ipv6 !== 'static' || CIDR6.test(f.ip6.trim()) ? undefined : t('Use an address with prefix, like fd00::5/64.'),
  };
}

export function validateIncus(f: IncusForm): FormErrors<IncusForm> {
  return {
    name: nameError(f.name) ?? (f.name.includes('.') ? t('Instance names have no dots.') : undefined),
    image: f.image.trim() ? undefined : t('Choose an image.'),
    cpu: !f.cpu.trim() || intIn(f.cpu, 1, 512) ? undefined : t('Use 1 to 512 CPUs.'),
    memoryMb: !f.memoryMb.trim() || intIn(f.memoryMb, 16, 16_777_216) ? undefined : t('Use at least 16 MiB.'),
    rootGb: !f.rootGb.trim() || intIn(f.rootGb, 1, 65_536) ? undefined : t('Use a size from 1 to 65536 GiB.'),
  };
}

export const hasErrors = (e: Record<string, string | undefined>): boolean => Object.values(e).some(Boolean);

// ---------------------------------------------------------------- inputs

const id = (v: string) => (v.trim() ? Number(v) : undefined);

export function vmInput(f: VmForm): CreateGuestInput {
  const net = [`${f.model},bridge=${f.bridge}`, f.vlan.trim() ? `tag=${f.vlan.trim()}` : '', f.firewall ? 'firewall=1' : ''].filter(Boolean).join(',');
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
  return { platform: 'pve', kind: 'vm', new_id: id(f.vmid), name: f.name.trim(), set, start: f.start };
}

export function ctInput(f: CtForm): CreateGuestInput {
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
  if (f.sshKeys.trim()) set['ssh-public-keys'] = f.sshKeys.trim();
  if (f.nameserver.trim()) set.nameserver = f.nameserver.trim();
  if (f.searchdomain.trim()) set.searchdomain = f.searchdomain.trim();
  return { platform: 'pve', kind: 'container', new_id: id(f.vmid), name: f.hostname.trim(), set, start: f.start };
}

/** Incus managed networks (incusbr0, lxdbr0) attach with network=; other host bridges as bridged NICs. */
export function incusNic(network: string): string {
  return /^(incus|lxd)br\d+$/.test(network) ? `type=nic,network=${network},name=eth0` : `type=nic,nictype=bridged,parent=${network},name=eth0`;
}

export function incusInput(f: IncusForm): CreateGuestInput {
  const set: Record<string, string> = {};
  if (f.cpu.trim()) set['limits.cpu'] = f.cpu.trim();
  if (f.memoryMb.trim()) set['limits.memory'] = `${f.memoryMb.trim()}MiB`;
  if (f.rootGb.trim() || (f.pool && f.pool !== 'default')) set['device.root'] = ['type=disk', 'path=/', `pool=${f.pool || 'default'}`, ...(f.rootGb.trim() ? [`size=${f.rootGb.trim()}GiB`] : [])].join(',');
  if (f.network) set['device.eth0'] = incusNic(f.network);
  return { platform: 'incus', kind: f.type, name: f.name.trim(), image: f.image.trim(), profiles: f.profiles, set, start: f.start };
}
