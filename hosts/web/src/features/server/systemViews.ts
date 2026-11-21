// Pure helpers of the host's System tab: sorting and filtering the live
// lists (processes, services, ports, package updates) and their wording.

import type { HostPort, HostProcess, HostService, PackageUpdate } from '../../api/types';
import { t, tn } from '../../lib/i18n';

export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: string;
  dir: SortDir;
}

/** Clicking a column: the same one flips the direction, another starts at its natural direction. */
export function nextSort(cur: SortState, key: string, natural: SortDir): SortState {
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: natural };
}

/** Stable sort by `cmp` (ascending), reversed for desc. */
export function sortRows<T>(rows: readonly T[], cmp: (a: T, b: T) => number, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((r, i) => [r, i] as const)
    .sort(([a, i], [b, j]) => sign * cmp(a, b) || i - j)
    .map(([r]) => r);
}

/** Every word of the filter appears somewhere in the row's text (case-insensitive). */
export function matchesFilter(text: string, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const lower = text.toLowerCase();
  return words.every((w) => lower.includes(w));
}

export const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------- per view

export function processText(p: HostProcess): string {
  return `${p.name} ${p.command} ${p.user} ${p.pid} ${p.container ?? ''}`;
}

/** Failed units first, then the ones changing state, running, and the rest. */
export function serviceRank(s: Pick<HostService, 'active'>): number {
  switch (s.active) {
    case 'failed':
      return 0;
    case 'activating':
    case 'deactivating':
    case 'reloading':
      return 1;
    case 'active':
      return 2;
    default:
      return 3;
  }
}

export function serviceTone(s: Pick<HostService, 'active'>): string {
  switch (s.active) {
    case 'failed':
      return 'var(--critical)';
    case 'active':
      return 'var(--good)';
    case 'inactive':
      return 'var(--muted)';
    default:
      return 'var(--warning)';
  }
}

/** "active · running", "failed", "inactive · dead". */
export function serviceState(s: Pick<HostService, 'active' | 'sub'>): string {
  return s.sub && s.sub !== s.active ? `${s.active} · ${s.sub}` : s.active;
}

export function serviceText(s: HostService): string {
  return `${s.name} ${s.description ?? ''} ${s.active} ${s.sub ?? ''} ${s.enabled ?? ''}`;
}

/** Listening on every address ("0.0.0.0", "::", "*") or only on loopback. */
export function portScope(p: Pick<HostPort, 'address'>): 'all' | 'local' | 'address' {
  const a = p.address;
  if (a === '0.0.0.0' || a === '::' || a === '*' || a === '') return 'all';
  if (a.startsWith('127.') || a === '::1' || a === 'localhost') return 'local';
  return 'address';
}

export function portText(p: HostPort): string {
  return `${p.port} ${p.proto} ${p.address} ${p.process ?? ''} ${p.pid ?? ''}`;
}

/** One row per port, protocol family, process and scope: "tcp 0.0.0.0:22" and "tcp6 [::]:22" of the same sshd show once. */
export function mergePorts(ports: readonly HostPort[]): HostPort[] {
  const out: HostPort[] = [];
  const seen = new Set<string>();
  for (const p of ports) {
    const fam = p.proto.replace(/6$/, '');
    const scope = portScope(p);
    const k = `${fam}|${p.port}|${p.pid ?? p.process ?? ''}|${scope === 'address' ? p.address : scope}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...p, proto: fam });
  }
  return out;
}

export function updateText(u: PackageUpdate): string {
  return `${u.name} ${u.current ?? ''} ${u.new} ${u.source ?? ''} ${u.security ? 'security' : ''}`;
}

/** "12 updates · 3 security" / "No pending updates". */
export function updatesSummary(items: readonly PackageUpdate[]): string {
  if (!items.length) return t('No pending updates');
  const sec = items.filter((u) => u.security).length;
  return `${tn(items.length, '{n} update', '{n} updates')}${sec ? ` · ${t('{n} security', { n: sec })}` : ''}`;
}
