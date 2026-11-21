// Platform tabs of the Workloads / Guests section (S8, SCREENS 3.7 and 4.6).
// Standard hosts: docker, incus, libvirt (only those present on the host,
// CONTRACT). Proxmox: vm (QEMU / KVM) and ct (LXC). The URL `platform` param
// uses these keys.

import { isProxmoxDetail } from '../../api/client';
import type { Guest, PlatformWorkload, ServerDetail, StandardWorkloads } from '../../api/types';
import type { IconName } from '../../components/Icon';
import { plural } from '../../lib/format';
import { t } from '../../lib/i18n';

export type PlatformKey = 'docker' | 'incus' | 'libvirt' | 'vm' | 'ct';
export type TableKind = 'docker' | 'vm' | 'pve';

export interface PlatformTab {
  key: PlatformKey;
  name: string;
  icon: IconName;
  /** Right-aligned caption on the platform card. */
  caption: string;
  workload: PlatformWorkload;
  /** Guests table title. */
  title: string;
  /** Plural noun for the footer ("containers", "instances", "VMs"). */
  noun: [string, string];
  table: TableKind;
  /** List / Screens and Console buttons (Docker has no console). */
  hasConsole: boolean;
  /** Query for GET /servers/{id}/guests. */
  api: { platform: string; kind?: string };
  /** Caption of the console side list. */
  railTitle: string;
  showUnits: boolean;
}

function stdTabs(w: StandardWorkloads): PlatformTab[] {
  const tabs: PlatformTab[] = [];
  if (w.docker) {
    tabs.push({
      key: 'docker',
      name: 'Docker',
      icon: 'box',
      caption: 'Engine',
      workload: w.docker,
      title: t('Docker containers'),
      noun: [t('container'), t('containers')],
      table: 'docker',
      hasConsole: false,
      api: { platform: 'docker' },
      railTitle: t('Docker containers'),
      showUnits: false,
    });
  }
  if (w.incus) {
    const vms = w.incus.vms ?? w.incus.guests.filter((g) => g.kind === 'vm' && g.state === 'running').length;
    const cts = w.incus.containers ?? w.incus.guests.filter((g) => g.kind === 'container' && g.state === 'running').length;
    tabs.push({
      key: 'incus',
      name: 'Incus',
      icon: 'layers',
      caption: `${plural(cts, 'container')} · ${plural(vms, 'KVM VM')}`,
      workload: w.incus,
      title: t('Incus instances · {vms} and {containers}', { vms: plural(vms, 'KVM VM'), containers: plural(cts, 'container') }),
      noun: [t('instance'), t('instances')],
      table: 'vm',
      hasConsole: true,
      api: { platform: 'incus' },
      railTitle: t('Incus instances'),
      showUnits: true,
    });
  }
  if (w.libvirt) {
    tabs.push({
      key: 'libvirt',
      name: 'QEMU / KVM',
      icon: 'screen',
      caption: 'libvirt',
      workload: w.libvirt,
      title: t('QEMU / KVM virtual machines · libvirt'),
      noun: [t('virtual machine'), t('virtual machines')],
      table: 'vm',
      hasConsole: true,
      api: { platform: 'libvirt' },
      railTitle: t('libvirt VMs'),
      showUnits: true,
    });
  }
  return tabs;
}

function runningStopped(w: PlatformWorkload): string {
  const stopped = w.total - w.running;
  return stopped > 0 ? t('{running} running, {stopped} stopped', { running: w.running, stopped }) : t('{running} running', { running: w.running });
}

export function platformTabs(d: ServerDetail): PlatformTab[] {
  if (isProxmoxDetail(d)) {
    const tabs: PlatformTab[] = [];
    if (d.guests.vm) {
      tabs.push({
        key: 'vm',
        name: 'QEMU / KVM',
        icon: 'screen',
        caption: t('KVM guests'),
        workload: d.guests.vm,
        title: t('QEMU / KVM virtual machines · {state}', { state: runningStopped(d.guests.vm) }),
        noun: [t('VM'), t('VMs')],
        table: 'pve',
        hasConsole: true,
        api: { platform: 'pve', kind: 'vm' },
        railTitle: t('QEMU / KVM VMs'),
        showUnits: true,
      });
    }
    if (d.guests.container) {
      tabs.push({
        key: 'ct',
        name: t('LXC containers'),
        icon: 'box',
        caption: t('Containers'),
        workload: d.guests.container,
        title: t('LXC containers · {state}', { state: runningStopped(d.guests.container) }),
        noun: [t('container'), t('containers')],
        table: 'pve',
        hasConsole: true,
        api: { platform: 'pve', kind: 'container' },
        railTitle: t('LXC containers'),
        showUnits: true,
      });
    }
    return tabs;
  }
  return d.workloads ? stdTabs(d.workloads) : [];
}

/** Default tab: first platform with guests (Docker on a standard host, QEMU on Proxmox). */
export function defaultTab(tabs: PlatformTab[]): PlatformTab | undefined {
  return tabs.find((t) => t.workload.total > 0) ?? tabs[0];
}

/** Which tab a guest id belongs to ("incus:nixbuild" -> incus; "pve:200" -> vm or ct). */
export function tabForGuest(tabs: PlatformTab[], guestId: string): PlatformTab | undefined {
  const inList = tabs.find((t) => t.workload.guests.some((g) => g.id === guestId));
  if (inList) return inList;
  const prefix = guestId.split(':')[0];
  return tabs.find((t) => t.key === prefix || t.api.platform === prefix);
}

/** Sort by CPU, busiest first; stopped guests (no CPU) last, then by name. */
export function sortByCpu(guests: Guest[]): Guest[] {
  return [...guests].sort((a, b) => {
    const ca = a.cpu_pct ?? -1;
    const cb = b.cpu_pct ?? -1;
    return cb - ca || a.name.localeCompare(b.name);
  });
}

/** "Showing 8 of 16 containers, sorted by CPU" / "Showing all 7 instances, sorted by CPU". */
export function footerText(tab: PlatformTab, shown: number, total: number, query: string): string {
  const noun = total === 1 ? tab.noun[0] : tab.noun[1];
  let s =
    query.trim() !== ''
      ? t('Showing {shown} of {total} {noun} matching “{query}”, sorted by CPU', { shown, total, noun, query: query.trim() })
      : shown >= total
        ? total === 1
          ? t('Showing 1 {noun}', { noun })
          : t('Showing all {total} {noun}, sorted by CPU', { total, noun })
        : t('Showing {shown} of {total} {noun}, sorted by CPU', { shown, total, noun });
  if (tab.showUnits) s = t('{text} · disk in MB/s (read / write), network in Mb/s (receive / transmit)', { text: s });
  return s;
}

