/**
 * What every Servers tool shares (`tools.ts`, `tools-manage.ts`; one-whombat-servers.md ONE-DH14…ONE-DH17): the call's
 * scope (the hosts service, “<Whombat> for <person>” with the role a route needs), servers and guests named by id or
 * name, compact JSON answers and refusals in Whombat's words, the change record for Done recently, and the follow-up
 * of a task a call started (proxmox.md PX-05).
 */
import {
  CONNECTION_OUTPUT_MAX,
  type HostChoices,
  type HostGuest,
  type HostServerPlatform,
} from '@whombat/core';
import type { AdapterCall, AdapterContext } from '../connections/adapters/types';
import { type CallOutput, ConnectionArgumentError } from '../connections/request';
import { loadPrincipalRow } from '../read/principals';
import { HOSTS_API, type HostsActor, HostsError, type HostsRole, HostsUnavailable, seg } from './client';
import { type HostsChangeInput, recordHostsChange } from './commands';
import { type HostsNames, hostsErrorText } from './errors';
import { taskFollowFor } from './follow';
import { arr, obj, serverPlatform, toHostChoices, toHostGuest } from './map';
import { givenServerName, SELF_GUEST_TEXT, selfActionRefused, selfOpRefused } from './self';
import { HOSTS_TEXT, type HostsService, hostsFor } from './service';
import { type ToolInverse, takePendingUndo } from './undo';
import { serversTaskWords, type TaskNames } from './words';

export type Args = Readonly<Record<string, unknown>>;

/** A tool answer: compact JSON, cut to the output cap. */
export function output(value: unknown, isError = false): CallOutput {
  const text = JSON.stringify(value);
  const truncated = text.length > CONNECTION_OUTPUT_MAX;
  return {
    content: truncated ? `${text.slice(0, CONNECTION_OUTPUT_MAX)}…` : text,
    isError,
    truncated,
    bytes: Buffer.byteLength(text),
  };
}

/** A refusal or failure the agent reads and can relay (never the remote side's raw answer, but the platform's words). */
export function failure(err: unknown, names: HostsNames): CallOutput {
  if (err instanceof HostsUnavailable)
    return output({ error: err.reason === 'not_configured' ? HOSTS_TEXT.absent : HOSTS_TEXT.down }, true);
  if (err instanceof HostsError)
    return output(
      {
        error: hostsErrorText(err, names),
        code: err.code,
        ...(err.fieldErrors ? { fields: err.fieldErrors } : {}),
      },
      true,
    );
  throw err;
}

export const req = (args: Args, name: string): string => {
  const v = args[name];
  if (typeof v !== 'string' || !v.trim()) throw new ConnectionArgumentError(`${name}: required.`);
  return v.trim();
};
export const opt = (args: Args, name: string): string | null => {
  const v = args[name];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new ConnectionArgumentError(`${name}: a string.`);
  return v.trim() || null;
};

export interface CallScope {
  hosts: HostsService;
  call: AdapterCall;
  /** The assistant and the person it works for, as the hosts service's audit names them. */
  actor: (role: HostsRole) => HostsActor;
  personId: string | null;
}

export async function scope(ctx: AdapterContext): Promise<CallScope> {
  const call = ctx.call;
  if (!call) throw new ConnectionArgumentError('This connection’s tools run only in an assistant’s turn.');
  const hosts = hostsFor(call.services);
  if (!hosts.present) throw new HostsUnavailable('not_configured', HOSTS_TEXT.absent);
  const agent = await loadPrincipalRow(call.services.db, call.agentId);
  // The agent works for the person; nobody in an outsiders' turn (one-person.md OP-S41).
  const personId = call.personId;
  const person = personId ? await loadPrincipalRow(call.services.db, personId) : null;
  const who = agent?.name ?? 'Whombat';
  const name = person ? `${who} for ${person.shortName || person.name}` : who;
  return {
    hosts,
    call,
    personId: person?.kind === 'person' ? person.id : null,
    actor: (role) => ({ id: call.agentId, name, role }),
  };
}

/** A server the call named: its id, fleet card, kind of page (IU-03) and the name messages give it. */
export interface ResolvedServer {
  id: string;
  card: Record<string, unknown>;
  kind: HostServerPlatform;
  /** The host name when it is the id with its own capitals (“BlackBox”), else the id. */
  label: string;
  /** One of its guests is this Whombat itself (IU-02). */
  runsThisWhombat: boolean;
}

/** A server named by its id, the name a person gave it or its host name (case-insensitive), from the fleet. */
export async function resolveServer(s: Pick<CallScope, 'hosts'>, raw: string): Promise<ResolvedServer> {
  const fleet = await s.hosts.fleetRaw();
  const want = raw.trim().toLowerCase();
  const cards = arr(fleet.servers).map(obj);
  // The id first, then the name a person gave it (“The Titan”), then its host name.
  const card =
    cards.find((c) => String(c.id).toLowerCase() === want) ??
    cards.find((c) => givenServerName(String(c.id))?.toLowerCase() === want) ??
    cards.find((c) => String(c.hostname ?? '').toLowerCase() === want);
  if (!card)
    throw new ConnectionArgumentError(
      `There’s no server “${raw}”. servers_overview lists them: ${cards
        .map((c) => {
          const named = givenServerName(String(c.id));
          return named ? `${c.id} (${named})` : c.id;
        })
        .slice(0, 20)
        .join(', ')}.`,
    );
  const id = String(card.id);
  const hostname = typeof card.hostname === 'string' ? card.hostname : '';
  return {
    id,
    card,
    kind: serverPlatform(card.detail_view),
    label: givenServerName(id) ?? (hostname && hostname.toLowerCase() === id.toLowerCase() ? hostname : id),
    runsThisWhombat: card.hosts_this_whombat === true,
  };
}

/** Whose manage routes a server's or guest's change goes to: the guest's platform, else the server's kind. */
export function managePlatform(
  kind: HostServerPlatform,
  guest?: { platform: string } | null,
): 'pve' | 'incus' | 'libvirt' | null {
  if (guest?.platform === 'pve' || guest?.platform === 'incus' || guest?.platform === 'libvirt')
    return guest.platform;
  if (guest) return null;
  return kind === 'proxmox' ? 'pve' : kind === 'incus' ? 'incus' : kind === 'libvirt' ? 'libvirt' : null;
}

/** Whether a guest is the one this Whombat runs in (IU-02). */
export const isSelf = (guest: unknown): boolean => (guest as { self?: unknown } | null)?.self === true;

/**
 * Refuses a change to the guest this Whombat runs in before the hub is asked (IU-02; the hub refuses too): an action
 * (`stop`, `snapshot_restore`, …) or a manage op (`config.set`, …; `asNew` for a restore that makes a new guest).
 */
export function refuseSelf(
  guest: unknown,
  change: { action: string } | { op: string; asNew?: boolean },
): void {
  if (!isSelf(guest)) return;
  const refused =
    'action' in change ? selfActionRefused(change.action) : selfOpRefused(change.op, change.asNew);
  if (refused) throw new HostsError(409, 'self_guest', SELF_GUEST_TEXT);
}

/** A tool that works on one kind of server, asked about another: the answer says which it works on. */
export function wrongKind(server: ResolvedServer, what: 'Incus' | 'Unraid'): CallOutput {
  return output(
    { error: `${server.id} doesn’t run ${what}, so this tool doesn’t work there.`, code: 'unsupported' },
    true,
  );
}

/** A guest named by its id (`pve:101`) or its name, on a server. */
export async function resolveGuest(s: CallScope, serverId: string, raw: string): Promise<HostGuest> {
  const page = await s.hosts.call<unknown>({
    path: `${HOSTS_API}/servers/${seg(serverId)}/guests`,
    query: { limit: 500 },
    actor: s.actor('viewer'),
  });
  const guests = arr(obj(page).guests).map((g) => toHostGuest(g, serverId));
  const want = raw.trim().toLowerCase();
  const byId = guests.find((g) => g.id.toLowerCase() === want);
  if (byId) return byId;
  const byName = guests.filter((g) => g.name.toLowerCase() === want);
  if (byName.length === 1) return byName[0] as HostGuest;
  if (byName.length > 1)
    throw new ConnectionArgumentError(
      `Several guests on ${serverId} are called “${raw}”: use the id (${byName.map((g) => g.id).join(', ')}).`,
    );
  throw new ConnectionArgumentError(`There’s no guest “${raw}” on ${serverId}. guests_list lists them.`);
}

/**
 * `input` with where its call went kept on its Undo recipe (`destination`, the Servers connection's `callTarget` when
 * the call ran, and `otherDestinations`, each other connection's it acted through): the inverse goes only there
 * (`undo.ts`).
 */
export function withDestination<C extends Pick<HostsChangeInput, 'change'>>(s: CallScope, input: C): C {
  const undo = input.change?.undo;
  const payload = undo?.payload;
  if (
    !input.change ||
    !undo ||
    !s.call.target ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  )
    return input;
  const others =
    s.call.others && Object.keys(s.call.others).length ? { otherDestinations: s.call.others } : {};
  return {
    ...input,
    change: {
      ...input.change,
      undo: { ...undo, payload: { ...payload, destination: s.call.target, ...others } },
    },
  };
}

/** Records a change the tool made (signed as the Whombat, for its person). */
export async function record(
  s: CallScope,
  input: Omit<HostsChangeInput, 'forPersonId' | 'conversationId' | 'undoes'>,
  undoes: { changeId: string; byId: string } | null = takePendingUndo(s.call.callId),
) {
  await s.call.services.pipeline
    .commit(
      recordHostsChange,
      {
        ...withDestination(s, input),
        forPersonId: s.personId,
        conversationId: s.call.conversationId,
        undoes: undoes ?? null,
      },
      { burrowId: s.call.burrowId, actorId: s.call.agentId },
    )
    .catch((err: unknown) =>
      s.call.services.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'hosts: change not recorded',
      ),
    );
}

/**
 * What the agent reads about a followed task (it needn't poll it): a card shows it running and it is woken when it ends
 * (task-feedback.md TF-10, TF-12).
 */
export const FOLLOWED_NOTE =
  'A card in this chat shows it running, and you are woken here when it ends to tell them how it went; no need to check on it.';

/**
 * Follows a task the call started (PX-05, TF-10): its card goes in the thread the call was asked in, and its end is told
 * there; whether it is followed. `change`: what the call changed, for Done recently — kept with the task and recorded
 * when it ends (TF-13), or now when no task is followed.
 */
export async function follow(
  s: CallScope,
  tool: string,
  args: Args,
  task: string | null | undefined,
  names: TaskNames,
  change: Change | null = null,
): Promise<boolean> {
  const conversationId = s.call.conversationId;
  const undoes = change ? takePendingUndo(s.call.callId) : null;
  const words = task && conversationId ? serversTaskWords(tool, args, names) : null;
  const followed =
    task && conversationId && words
      ? await taskFollowFor(s.call.services).remember({
          taskId: task,
          serverId: names.server,
          serverName: names.label || names.server,
          burrowId: s.call.burrowId,
          conversationId,
          // Its card and end go in the thread the call was asked in (task-feedback.md TF-04).
          threadRootId: s.call.threadRootId ?? null,
          agentId: s.call.agentId,
          personId: s.personId,
          approvalId: s.call.approvalId ?? null,
          words,
          change: change
            ? {
                ...withDestination(s, change),
                forPersonId: s.personId,
                conversationId,
                undoes: undoes ?? null,
              }
            : null,
        })
      : null;
  if (!followed && change) await record(s, change, undoes);
  return followed !== null;
}

export async function run<T>(names: HostsNames, fn: () => Promise<T>): Promise<T | CallOutput> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConnectionArgumentError) throw err;
    return failure(err, names);
  }
}

export const isOutput = (v: unknown): v is CallOutput =>
  !!v && typeof v === 'object' && 'content' in v && 'isError' in v && 'bytes' in v;

/** A service answer with its keys in camelCase (diagnose and exec answers). */
export function camelOut(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelOut);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [
      k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()),
      camelOut(x),
    ]),
  );
}

/* Arguments -------------------------------------------------------------------------------------------------------- */

/** An optional boolean argument (null when absent). */
export const optBool = (args: Args, name: string): boolean | null => {
  const v = args[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'boolean') throw new ConnectionArgumentError(`${name}: true or false.`);
  return v;
};

/** An optional whole number within bounds (null when absent). */
export const optInt = (args: Args, name: string, min: number, max: number): number | null => {
  const v = args[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new ConnectionArgumentError(`${name}: a whole number from ${min} to ${max}.`);
  return v;
};

/** An optional object of strings (`{"memory": "8192"}`), at most `max` keys. */
export const optStrMap = (args: Args, name: string, max = 100): Record<string, string> | null => {
  const v = args[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v))
    throw new ConnectionArgumentError(`${name}: an object of strings, like {"onboot": "1"}.`);
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > max) throw new ConnectionArgumentError(`${name}: at most ${max} keys.`);
  for (const [k, x] of entries)
    if (typeof x !== 'string') throw new ConnectionArgumentError(`${name}.${k}: a string.`);
  return Object.fromEntries(entries) as Record<string, string>;
};

/** An optional list of strings. */
export const optStrList = (args: Args, name: string, max = 300): string[] | null => {
  const v = args[name];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
    throw new ConnectionArgumentError(`${name}: a list of strings.`);
  if (v.length > max) throw new ConnectionArgumentError(`${name}: at most ${max}.`);
  return v as string[];
};

/** One of the allowed words. */
export function oneOf<T extends string>(args: Args, name: string, allowed: readonly T[]): T {
  const v = req(args, name);
  if (!(allowed as readonly string[]).includes(v))
    throw new ConnectionArgumentError(`${name}: ${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)}.`);
  return v as T;
}

/** A storage's, node's or disk's name as the service takes it. */
export function plainName(args: Args, name: string, required: true): string;
export function plainName(args: Args, name: string, required?: false): string | null;
export function plainName(args: Args, name: string, required = false): string | null {
  const v = required ? req(args, name) : opt(args, name);
  // Unraid's VM folders are storages too (`folder:domains`, `folder:isos`; 0.84).
  if (v !== null && !/^(folder:)?[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(v))
    throw new ConnectionArgumentError(`${name}: letters, digits, “.”, “_” and “-”.`);
  return v;
}

/** A new guest's number on Proxmox (100 to 999999999), or null for the next free one. */
export const newGuestId = (args: Args, name = 'id'): number | null => optInt(args, name, 100, 999_999_999);

/* The manage tools' common pieces (tools-guests.ts, tools-backups.ts, tools-host.ts) ------------------------------- */

export const S = (serverId: string) => `${HOSTS_API}/servers/${seg(serverId)}`;
export const G = (serverId: string, guestId: string) => `${S(serverId)}/guests/${seg(guestId)}`;

/**
 * A server's detail as the hub gives it to the role that acts (task-feedback.md TF-01): the hub works the switches out
 * per caller and a viewer gets every one off (“Requires operator access”), so every tool reads it as admin, the role
 * Whombat's own manage, console and power calls use.
 */
export function serverDetailRaw(s: CallScope, serverId: string): Promise<unknown> {
  return s.hosts.call<unknown>({ path: S(serverId), actor: s.actor('admin') });
}

export async function choicesOf(
  s: CallScope,
  serverId: string,
  platform?: 'pve' | 'incus' | 'libvirt' | null,
  project?: string | null,
): Promise<HostChoices> {
  return toHostChoices(
    await s.hosts.call<unknown>({
      path: `${S(serverId)}/manage/choices`,
      query: { platform: platform ?? undefined, project: project ?? undefined },
      actor: s.actor('operator'),
    }),
  );
}

/** A change on the service with the manage deadline. */
export function send<T>(
  s: CallScope,
  role: HostsRole,
  r: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    body?: unknown;
    query?: Record<string, string>;
  },
): Promise<T> {
  return s.hosts.call<T>({ ...r, actor: s.actor(role), timeoutMs: 60_000 });
}

export const gb = (bytes: number | null | undefined) =>
  typeof bytes === 'number' ? Math.round((bytes / 1e9) * 10) / 10 : null;

export type Change = Omit<HostsChangeInput, 'forPersonId' | 'conversationId' | 'undoes'>;

/** The change record of a tool's change, with its inverse call when there is one. */
export function changeOf(
  op: string,
  serverId: string,
  guestId: string | null,
  title: string,
  extra: { ids?: Record<string, string>; detail?: string | null; inverse?: ToolInverse | null } = {},
): Change {
  return {
    text: title.slice(0, 300),
    op,
    serverId,
    guestId,
    ...(extra.ids && Object.keys(extra.ids).length ? { ids: extra.ids } : {}),
    change: {
      title: title.slice(0, 200),
      ...(extra.detail ? { detail: extra.detail.slice(0, 1000) } : {}),
      undo: extra.inverse ? { kind: 'hosts.tool_inverse', payload: extra.inverse } : null,
    },
  };
}

export const idsOf = (r: { task?: { id: string }; auditId?: string }) => ({
  ...(r.task ? { taskId: r.task.id } : {}),
  ...(r.auditId ? { auditId: r.auditId } : {}),
});

export const call = async (fn: () => Promise<CallOutput>, names: HostsNames) =>
  (await run(names, fn)) as CallOutput;

/**
 * Incus devices as the agent gave them (`{"eth1": {"type": "nic", "network": "incusbr0"}, "old": null}`), checked:
 * names like Incus's, values strings, null to remove; a disk from a host folder is refused here (the service refuses
 * it too, IU-04).
 */
export function incusDevices(raw: unknown): Record<string, Record<string, string> | null> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new ConnectionArgumentError(
      'devices: an object of devices by name, like {"eth1": {"type": "nic", "network": "incusbr0"}}.',
    );
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return null;
  if (entries.length > 30) throw new ConnectionArgumentError('devices: at most 30 at a time.');
  const out: Record<string, Record<string, string> | null> = {};
  for (const [name, dev] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name))
      throw new ConnectionArgumentError(`devices.${name}: a device name (letters, digits, “.”, “_”, “-”).`);
    if (dev === null) {
      out[name] = null;
      continue;
    }
    if (typeof dev !== 'object' || Array.isArray(dev))
      throw new ConnectionArgumentError(`devices.${name}: an object of strings, or null to remove it.`);
    const d: Record<string, string> = {};
    for (const [k, v] of Object.entries(dev as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new ConnectionArgumentError(`devices.${name}.${k}: a string.`);
      d[k] = v;
    }
    if (d.type !== 'nic' && d.type !== 'disk')
      throw new ConnectionArgumentError(`devices.${name}.type: nic or disk.`);
    if (d.type === 'disk' && d.source?.startsWith('/'))
      throw new ConnectionArgumentError(
        `devices.${name}.source: a custom volume of the pool, never a folder of the host.`,
      );
    out[name] = d;
  }
  return out;
}
