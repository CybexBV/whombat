/**
 * Settings saved in a row are one change (docs/decisions/home-redesign.md HR-06): what a server's or guest's settings
 * change is called from the fields it changed (“Changed the name and notes of web on pve-02”, else “Changed 4 settings
 * of pve-01”), and how two saves' Undo recipes and details become one that goes back to how it was before the first.
 * `recordHostsChange` merges with `recordOrMergeChange` (home/registry.ts). Pure.
 */
import type { ChangeMerge } from '../home/registry';
import type { ConfigUndo, SettingsUndo } from './undo';

/** The settings changes that merge (`HostsChangeInput.op`). */
export const MERGING_OPS = ['server_settings', 'guest_config'] as const;
export type MergingOp = (typeof MERGING_OPS)[number];

export function isMergingOp(op: string): op is MergingOp {
  return (MERGING_OPS as readonly string[]).includes(op);
}

/** A server setting's field (`hosts.updateServer`'s patch): the key it merges on. */
export function serverSettingsFields(patch: {
  group?: string | undefined;
  location?: string | undefined;
  parent?: string | undefined;
  remoteControl?: Partial<Record<string, boolean | undefined>> | undefined;
}): string[] {
  const out: string[] = [];
  if (patch.group !== undefined) out.push('group');
  if (patch.location !== undefined) out.push('location');
  if (patch.parent !== undefined) out.push('parent');
  for (const [k, v] of Object.entries(patch.remoteControl ?? {}))
    if (v !== undefined) out.push(`switch.${k}`);
  return out;
}

/** Fields a person knows by name: a server's settings and the guest keys people set most. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  group: 'group',
  location: 'location',
  parent: 'parent server',
  // Proxmox guests
  name: 'name',
  description: 'notes',
  memory: 'memory',
  balloon: 'minimum memory',
  cores: 'cores',
  sockets: 'CPU sockets',
  cpu: 'CPU type',
  cpulimit: 'CPU limit',
  onboot: 'start at boot',
  startup: 'start order',
  boot: 'boot order',
  tags: 'tags',
  protection: 'protection',
  hostname: 'hostname',
  swap: 'swap',
  // Incus guests
  'boot.autostart': 'start at boot',
  'limits.memory': 'memory',
  'limits.cpu': 'CPUs',
  // libvirt guests
  title: 'title',
  vcpus: 'CPUs',
  memory_mb: 'memory',
  autostart: 'start at boot',
};

/** “a, b and c”. */
function list(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** At most this many fields are named; more are counted. */
const NAMED_MAX = 3;

/**
 * A settings change's title from every field it changed: the fields by name where Whombat knows them (“Changed the
 * location and group of pve-01”, a server's switches as “what Whombat may do”), else counted (“Changed 4 settings of
 * web on pve-02”). `target`: “pve-01”, “web on pve-02”.
 */
export function settingsTitle(fields: readonly string[], target: string): string {
  const unique = [...new Set(fields)];
  const switches = unique.some((f) => f.startsWith('switch.'));
  const others = unique.filter((f) => !f.startsWith('switch.'));
  const words = [...new Set(others.map((f) => FIELD_WORDS[f]))];
  const known = words.every((w): w is string => w !== undefined);
  if (!unique.length) return `Changed the settings of ${target}`;
  if (!known || words.length > NAMED_MAX) {
    const n = unique.length;
    return n === 1 ? `Changed a setting of ${target}` : `Changed ${n} settings of ${target}`;
  }
  if (!words.length) return `Changed what Whombat may do on ${target}`;
  const named = `Changed the ${list(words as string[])} of ${target}`;
  return switches ? `${named} and what Whombat may do there` : named;
}

/** Undo of two server-settings saves: the values from before the first (the earlier save's win). */
export function mergeSettingsUndo(earlier: SettingsUndo, later: SettingsUndo): SettingsUndo {
  const rc = { ...(later.patch.remoteControl ?? {}), ...(earlier.patch.remoteControl ?? {}) };
  return {
    serverId: earlier.serverId,
    patch: {
      ...later.patch,
      ...earlier.patch,
      ...(Object.keys(rc).length ? { remoteControl: rc } : {}),
    },
  };
}

/**
 * Undo of two configuration saves: a key the first changed goes back to its value before the first, a key only the
 * second changed to its value before the second; Undo runs only while every key is what the last save made it.
 */
export function mergeConfigUndo(earlier: ConfigUndo, later: ConfigUndo): ConfigUndo {
  const firstKeys = new Set([...Object.keys(earlier.set), ...earlier.delete]);
  const set = { ...earlier.set };
  const del = [...earlier.delete];
  for (const [k, v] of Object.entries(later.set)) if (!firstKeys.has(k)) set[k] = v;
  for (const k of later.delete) if (!firstKeys.has(k) && !del.includes(k)) del.push(k);
  return {
    serverId: earlier.serverId,
    guestId: earlier.guestId,
    guestName: later.guestName ?? earlier.guestName,
    set,
    delete: del,
    expect: { ...earlier.expect, ...later.expect },
    // Where the first save went: a later one that went elsewhere leaves an Undo that refuses there.
    ...((earlier.destination ?? later.destination)
      ? { destination: (earlier.destination ?? later.destination) as string }
      : {}),
  };
}

const ARROW = ' → ';
const DETAIL_LINES_MAX = 8;

/** Two saves' “key: old → new” lines as one: each key once, with the first save's old value and the last's new. */
export function mergeDetailLines(earlier: string | null, later: string | null): string | null {
  const lines = new Map<string, string>();
  const add = (text: string | null, first: boolean) => {
    for (const line of (text ?? '').split('\n')) {
      if (!line.trim()) continue;
      const colon = line.indexOf(': ');
      const key = colon > 0 ? line.slice(0, colon) : line;
      const prev = lines.get(key);
      if (!prev || first || colon <= 0) {
        lines.set(key, line);
        continue;
      }
      const value = (l: string) => l.slice(key.length + 2).split(ARROW);
      const old = value(prev)[0];
      const now = value(line).slice(1).join(ARROW);
      lines.set(key, old !== undefined && now ? `${key}: ${old}${ARROW}${now}` : line);
    }
  };
  add(earlier, true);
  add(later, false);
  const out = [...lines.values()].slice(0, DETAIL_LINES_MAX).join('\n');
  return out || null;
}

/** How a settings save merges into the actor's last change of the same server or guest. */
export function settingsMerge(input: {
  op: MergingOp;
  serverId: string;
  guestId?: string | null | undefined;
  fields: string[];
  target: string;
}): ChangeMerge {
  return {
    key: `hosts.${input.op}:${input.serverId}:${input.guestId ?? ''}`,
    fields: input.fields,
    title: (fields) => settingsTitle(fields, input.target),
    undo: (earlier, later) =>
      input.op === 'server_settings'
        ? mergeSettingsUndo(earlier as SettingsUndo, later as SettingsUndo)
        : mergeConfigUndo(earlier as ConfigUndo, later as ConfigUndo),
    detail: mergeDetailLines,
  };
}
