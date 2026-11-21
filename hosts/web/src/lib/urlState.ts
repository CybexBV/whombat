// URL state (SCREENS.md 0, G5, NOTES.md "UI v2"): range, the host page tab,
// guest filters and the open console live in the URL so a view can be shared
// and reloaded. Defaults are omitted from the URL: range=24h, tab=summary.

import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { RANGES, type Range } from '../api/types';

export const DEFAULT_RANGE: Range = '24h';
export const DEFAULT_GROUP = 'All';

export function parseRange(v: string | null): Range {
  return v && (RANGES as readonly string[]).includes(v) ? (v as Range) : DEFAULT_RANGE;
}

type Setter = (key: string, value: string | null, opts?: { drop?: string[] }) => void;

/** Set or clear one search param (replace, so range clicks do not flood history). */
export function useParamSetter(): [URLSearchParams, Setter] {
  const [params, setParams] = useSearchParams();
  const set = useCallback<Setter>(
    (key, value, opts) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === null) next.delete(key);
          else next.set(key, value);
          for (const d of opts?.drop ?? []) next.delete(d);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return [params, set];
}

export function useRange(): [Range, (r: Range) => void] {
  const [params, set] = useParamSetter();
  const range = parseRange(params.get('range'));
  const setRange = useCallback((r: Range) => set('range', r === DEFAULT_RANGE ? null : r), [set]);
  return [range, setRange];
}

export function useGroup(): [string, (g: string) => void] {
  const [params, set] = useParamSetter();
  const group = params.get('group') || DEFAULT_GROUP;
  const setGroup = useCallback((g: string) => set('group', g === DEFAULT_GROUP ? null : g), [set]);
  return [group, setGroup];
}

/** Query string carrying the current range to another page ("?range=7d" or ""). */
export function rangeQuery(range: Range): string {
  return range === DEFAULT_RANGE ? '' : `?range=${range}`;
}

// ---------------------------------------------------------------- host pages

export const HOST_TABS = ['summary', 'guests', 'storage', 'sensors', 'virtualization', 'system', 'agent'] as const;
export type HostTab = (typeof HOST_TABS)[number];
export const DEFAULT_TAB: HostTab = 'summary';

export function parseTab(v: string | null): HostTab {
  return v && (HOST_TABS as readonly string[]).includes(v) ? (v as HostTab) : DEFAULT_TAB;
}

function query(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export interface HostPathOpts {
  tab?: HostTab;
  range?: Range;
  /** Guests tab: platform key (docker | incus | libvirt | vm | ct). */
  platform?: string | null;
  /** Guests tab: name filter. */
  q?: string | null;
  view?: 'list' | 'screens' | null;
  /** Card to bring into view (its element id, e.g. "system"): the page scrolls to it. */
  section?: string | null;
}

/** Path of a host page (Proxmox hosts use the same route; the page picks the variant). */
export function hostPath(id: string, opts: HostPathOpts = {}): string {
  return `/servers/${encodeURIComponent(id)}${query({
    tab: opts.tab && opts.tab !== DEFAULT_TAB ? opts.tab : null,
    range: opts.range && opts.range !== DEFAULT_RANGE ? opts.range : null,
    platform: opts.platform,
    q: opts.q,
    view: opts.view === 'screens' ? 'screens' : null,
  })}${opts.section ? `#${opts.section}` : ''}`;
}

/** @deprecated use hostPath; kept for the alert rows and older links. */
export function serverPath(id: string, range: Range): string {
  return hostPath(id, { range });
}

/** A host's Agent tab (the same content as the standalone settings page). */
export function agentPath(id: string): string {
  return hostPath(id, { tab: 'agent' });
}

/** Settings › Agents › server: works for servers whose agent never reported (the host page needs a report). */
export function agentSettingsPath(id: string): string {
  return `/settings/agents/${encodeURIComponent(id)}`;
}

/** The console of a guest, inside its host's Guests tab. */
export function consolePath(server: string, guestId: string, opts: { range?: Range; protocol?: string | null; platform?: string | null } = {}): string {
  return `/servers/${encodeURIComponent(server)}/guests/${encodeURIComponent(guestId)}/console${query({
    range: opts.range && opts.range !== DEFAULT_RANGE ? opts.range : null,
    platform: opts.platform,
    protocol: opts.protocol,
  })}`;
}

/** Tabs of the guest page (/servers/:id/guests/:guestId, `tab` parameter); which ones show depends on the platform and permissions (features/guest/tabs.ts). */
export const GUEST_TABS = ['summary', 'hardware', 'options', 'cloudinit', 'config', 'snapshots', 'backups', 'firewall', 'replication', 'tasks'] as const;
export type GuestTab = (typeof GUEST_TABS)[number];

export function parseGuestTab(v: string | null): GuestTab {
  return (GUEST_TABS as readonly string[]).includes(v ?? '') ? (v as GuestTab) : 'summary';
}

/** The guest page. */
export function guestPath(server: string, guestId: string, opts: { tab?: GuestTab; range?: Range } = {}): string {
  return `/servers/${encodeURIComponent(server)}/guests/${encodeURIComponent(guestId)}${query({
    tab: opts.tab && opts.tab !== 'summary' ? opts.tab : null,
    range: opts.range && opts.range !== DEFAULT_RANGE ? opts.range : null,
  })}`;
}

/** Platform tab key of a guest (the host page's `platform` param). */
export function guestTab(platform: string, kind: string): string {
  return platform === 'pve' ? (kind === 'vm' ? 'vm' : 'ct') : platform;
}

/** Host page opened on the guest's platform tab, filtered to the guest. */
export function guestListPath(server: string, platform: string, kind: string, name: string, range: Range = DEFAULT_RANGE): string {
  return hostPath(server, { tab: 'guests', platform: guestTab(platform, kind), q: name, range });
}

// ---------------------------------------------------------------- guests page

export interface GuestsPageQuery {
  q?: string | null;
  state?: string | null;
  platform?: string | null;
  server?: string | null;
  /** Proxmox tag (exact, case-insensitive). */
  tag?: string | null;
  sort?: string | null;
  view?: 'list' | 'screens' | null;
}

export function guestsPagePath(p: GuestsPageQuery = {}): string {
  return `/guests${query({ q: p.q, state: p.state, platform: p.platform, server: p.server, tag: p.tag, sort: p.sort, view: p.view === 'screens' ? 'screens' : null })}`;
}
