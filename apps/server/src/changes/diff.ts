/**
 * What changed between two reads of a thing (docs/decisions/outside-changes.md), pure: a service's version, its devices'
 * firmware and its routes; a server's restart, kernel, operating system and waiting updates; its containers' images.
 * Only what both reads saw counts: a part a read couldn't see (null) keeps the read before, an item that came or went
 * isn't a change of the item (a container or device added), and a first read only sets what the next is compared with.
 */
import type { ThingChangeKind } from '@whombat/core';
import type { ChangeFact } from '../db/schema/changes';

/** A change to record: its kind, the item it is about ('' the whole thing) and what it was. */
export interface ChangeDraft {
  kind: ThingChangeKind;
  subject: string;
  fact: ChangeFact;
}

/** Above this many changes of one kind in one read, they are one change (“5 containers got new images”). */
export const BURST_MAX = 3;
/** How many names a combined change keeps. */
const NAMES_MAX = 5;
/** A boot time that moved less than this is the same boot (the time is worked out from the uptime). */
export const BOOT_JITTER_MS = 2 * 60_000;

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* A service --------------------------------------------------------------------------------------------------------- */

/** Routes as a kind reads them: the host and where it goes (`off:` before a target that is switched off). */
export interface TrackedRoutes {
  via: 'proxy' | 'tunnel';
  map: Record<string, string>;
}

/**
 * What a kind's read tells about what can change (the health pass's `KindSeen.tracked`): its version, its devices'
 * firmware by name and its routes by host. Absent: not tracked; null: not read this time (the last read stands).
 */
export interface TrackedFacts {
  version?: string | null;
  firmware?: Record<string, string> | null;
  routes?: TrackedRoutes | null;
}

/** What is kept of a service between reads. */
export interface ServiceState {
  version?: string;
  firmware?: Record<string, string>;
  routes?: TrackedRoutes;
}

/** The state to keep after `read`: what it read, and the last read's for what it couldn't. */
export function nextServiceState(before: ServiceState | null, read: TrackedFacts): ServiceState {
  const out: ServiceState = { ...(before ?? {}) };
  if (typeof read.version === 'string' && read.version.trim()) out.version = clip(read.version.trim(), 60);
  if (read.firmware) out.firmware = cleanMap(read.firmware);
  if (read.routes) out.routes = { via: read.routes.via, map: cleanMap(read.routes.map) };
  return out;
}

function cleanMap(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map).slice(0, 500)) {
    const key = clip(k.trim(), 160);
    const value = clip(String(v).trim(), 200);
    if (key && value) out[key] = value;
  }
  return out;
}

/** A service's changes between the state kept and this read's (`name`: the service, “Immich”). */
export function diffService(name: string, before: ServiceState | null, after: ServiceState): ChangeDraft[] {
  if (!before) return [];
  const out: ChangeDraft[] = [];
  if (before.version && after.version && sameVersion(before.version, after.version) === false)
    out.push({
      kind: 'version',
      subject: '',
      fact: { k: 'version', name, from: before.version, to: after.version },
    });
  if (before.firmware && after.firmware) out.push(...firmwareChanges(before.firmware, after.firmware));
  if (before.routes && after.routes && before.routes.via === after.routes.via)
    out.push(...routeChanges(after.routes.via, before.routes.map, after.routes.map));
  return out;
}

/** Whether two versions are the same, ignoring a `v` before them and space around them. */
function sameVersion(a: string, b: string): boolean {
  const bare = (v: string) => v.trim().replace(/^v(?=\d)/i, '');
  return bare(a) === bare(b);
}

function firmwareChanges(before: Record<string, string>, after: Record<string, string>): ChangeDraft[] {
  const changed = Object.entries(after).filter(
    ([device, to]) => before[device] !== undefined && !sameVersion(before[device] as string, to),
  );
  if (changed.length > BURST_MAX) {
    const tos = new Set(changed.map(([, to]) => to));
    return [
      {
        kind: 'firmware',
        subject: '',
        fact: {
          k: 'firmwares',
          devices: changed.slice(0, NAMES_MAX).map(([d]) => d),
          count: changed.length,
          to: tos.size === 1 ? (changed[0]?.[1] ?? null) : null,
        },
      },
    ];
  }
  return changed.map(([device, to]) => ({
    kind: 'firmware' as const,
    subject: device,
    fact: { k: 'firmware' as const, device, from: before[device] as string, to },
  }));
}

function routeChanges(
  via: TrackedRoutes['via'],
  before: Record<string, string>,
  after: Record<string, string>,
): ChangeDraft[] {
  const hosts = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const drafts: ChangeDraft[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const host of hosts) {
    const from = before[host] ?? null;
    const to = after[host] ?? null;
    if (from === to) continue;
    if (from === null) added++;
    else if (to === null) removed++;
    else changed++;
    drafts.push({ kind: 'route', subject: host, fact: { k: 'route', via, host, from, to } });
  }
  if (drafts.length <= BURST_MAX) return drafts;
  return [
    {
      kind: 'route',
      subject: '',
      fact: {
        k: 'routes',
        via,
        added,
        removed,
        changed,
        hosts: drafts.slice(0, NAMES_MAX).map((d) => d.subject),
      },
    },
  ];
}

/* A server ---------------------------------------------------------------------------------------------------------- */

/** What is kept of a server between reads (from the hosts service's detail). */
export interface ServerState {
  /** “Debian GNU/Linux 13”, “Proxmox VE 9.0.10”. */
  os?: string;
  kernel?: string;
  /** When it last started, ISO. */
  bootAt?: string;
  /** How many updates were waiting. */
  updates?: number;
}

/** What one read of a server saw; null where it couldn't tell. */
export interface ServerRead {
  os: string | null;
  kernel: string | null;
  bootAt: string | null;
  updates: number | null;
}

export function nextServerState(before: ServerState | null, read: ServerRead): ServerState {
  const out: ServerState = { ...(before ?? {}) };
  if (read.os) out.os = clip(read.os, 120);
  if (read.kernel) out.kernel = clip(read.kernel, 120);
  if (read.bootAt) out.bootAt = read.bootAt;
  if (read.updates !== null && Number.isFinite(read.updates))
    out.updates = Math.max(0, Math.round(read.updates));
  return out;
}

/**
 * A server's changes: a restart (its boot time moved, with the kernel it came back with when that changed), a new
 * kernel without one, its system's own version, and waiting updates that went (installed: by whom is decided by what
 * Whombat did there). Updates that appear are news, not a change of the server.
 */
export function diffServer(before: ServerState | null, after: ServerState): ChangeDraft[] {
  if (!before) return [];
  const out: ChangeDraft[] = [];
  const kernelChanged = !!before.kernel && !!after.kernel && before.kernel !== after.kernel;
  const restarted =
    !!before.bootAt &&
    !!after.bootAt &&
    Date.parse(after.bootAt) - Date.parse(before.bootAt) > BOOT_JITTER_MS;
  if (restarted)
    out.push({
      kind: 'restart',
      subject: '',
      fact: { k: 'restart', kernel: kernelChanged ? (after.kernel as string) : null },
    });
  else if (kernelChanged)
    out.push({ kind: 'system', subject: 'kernel', fact: { k: 'kernel', to: after.kernel as string } });
  if (before.os && after.os && before.os !== after.os)
    out.push({ kind: 'system', subject: 'os', fact: { k: 'os', from: before.os, to: after.os } });
  if (before.updates !== undefined && after.updates !== undefined && after.updates < before.updates)
    out.push({
      kind: 'system',
      subject: 'packages',
      fact: { k: 'packages', count: before.updates - after.updates },
    });
  return out;
}

/* Containers -------------------------------------------------------------------------------------------------------- */

/** One container as a read saw it: its image as named, and the image's own id when the agent says it. */
export interface ContainerRead {
  name: string;
  image: string;
  imageId?: string | null;
}

/** What is kept: each container's image, `<ref>@<short id>` when its id is known. */
export type ContainerState = Record<string, string>;

const SHORT_ID = /^(?:sha256:)?([0-9a-f]{12})/i;

export function containerState(read: readonly ContainerRead[]): ContainerState {
  const out: ContainerState = {};
  for (const c of read.slice(0, 500)) {
    const name = clip(c.name.trim(), 160);
    const image = clip(c.image.trim(), 200);
    if (!name || !image) continue;
    const id = c.imageId ? SHORT_ID.exec(c.imageId.trim())?.[1] : undefined;
    out[name] = id ? `${image}@${id.toLowerCase()}` : image;
  }
  return out;
}

function splitImage(value: string): { ref: string; id: string | null } {
  const at = value.lastIndexOf('@');
  return at > 0 && /^[0-9a-f]{12}$/.test(value.slice(at + 1))
    ? { ref: value.slice(0, at), id: value.slice(at + 1) }
    : { ref: value, id: null };
}

/**
 * Containers whose image changed: another name or tag, or the same tag with another image (Watchtower's pull). A
 * container that came or went isn't one; more than a few in one read are one change.
 */
export function diffContainers(before: ContainerState | null, after: ContainerState): ChangeDraft[] {
  if (!before) return [];
  const drafts: ChangeDraft[] = [];
  for (const [name, now] of Object.entries(after)) {
    const was = before[name];
    if (was === undefined || was === now) continue;
    const a = splitImage(was);
    const b = splitImage(now);
    if (a.ref === b.ref && (a.id === null || b.id === null || a.id === b.id)) continue;
    drafts.push({ kind: 'image', subject: name, fact: { k: 'image', name, from: a.ref, to: b.ref } });
  }
  if (drafts.length <= BURST_MAX) return drafts;
  return [
    {
      kind: 'image',
      subject: '',
      fact: {
        k: 'images',
        names: drafts.slice(0, NAMES_MAX).map((d) => d.subject),
        count: drafts.length,
      },
    },
  ];
}

/* Merging a burst ------------------------------------------------------------------------------------------------- */

/**
 * A change seen again soon after one of the same item (`MERGE_MS`): the two as one (from the first's start to the
 * second's end), `'gone'` when the second undid the first (2.3 → 2.4 → 2.3), or null when they don't merge.
 */
export function mergeFacts(earlier: ChangeFact, later: ChangeFact): ChangeFact | 'gone' | null {
  if (earlier.k !== later.k) return null;
  switch (later.k) {
    case 'version':
    case 'image':
    case 'os':
    case 'firmware': {
      const e = earlier as typeof later;
      if (later.k === 'version' && (e as { name: string }).name !== later.name) return null;
      return e.from === later.to ? 'gone' : ({ ...later, from: e.from } as ChangeFact);
    }
    case 'route': {
      const e = earlier as typeof later;
      if (e.host !== later.host || e.via !== later.via) return null;
      return e.from === later.to ? 'gone' : { ...later, from: e.from };
    }
    case 'restart': {
      const e = earlier as typeof later;
      return { k: 'restart', kernel: later.kernel ?? e.kernel };
    }
    case 'kernel':
      return later;
    case 'packages': {
      const e = earlier as typeof later;
      return { k: 'packages', count: e.count + later.count };
    }
    default:
      return null;
  }
}

/** Changes of one item this close together are one change. */
export const MERGE_MS = 30 * 60_000;
