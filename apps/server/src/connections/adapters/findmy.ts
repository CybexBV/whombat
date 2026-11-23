/**
 * The assistant's Find My (docs/decisions/findmy-connection.md): `findmy_people` answers where each person is, as Find
 * My on the connection's Mac shows them, optionally one person by name or first name. When the last read is older than
 * 2 minutes it reads first, through the Mac's own Find My store (a Mac someone is using is left alone), and waits up to
 * 45 seconds; otherwise, or when that read doesn't work, it answers the last read with its age and why. It never gives
 * pictures or coordinates. Outside an assistant's turn it refuses, as the Servers tools do.
 */
import { FindMyPeopleArgs, findMyProblemText, type HostFindMy, type HostFindMyPerson } from '@whombat/core';
import { outsideCommandScope } from '../../commit/scope';
import { type FindMyStore, findMyFor } from '../../hosts/findmy';
import { knownServer, serverLabel } from '../../hosts/self';
import { failure, output, scope } from '../../hosts/tools-shared';
import { ConnectionArgumentError } from '../request';
import type { Adapter, AdapterContext, AdapterTool } from './types';

/** How long the tool waits for a read it started (ms). */
export const FIND_MY_PEOPLE_WAIT_MS = 45_000;

export interface FindMyPeopleDeps {
  /** The call's hosts service and the assistant as its actor (`scope`). */
  scope: typeof scope;
  /** The process's Find My store. */
  store: (ctx: AdapterContext) => FindMyStore;
  /** Waits this long (tests make it resolve when they say). */
  wait: (ms: number) => Promise<void>;
  now: (ctx: AdapterContext) => number;
}

const DEFAULT_DEPS: FindMyPeopleDeps = {
  scope,
  store: (ctx) => findMyFor((ctx.call as NonNullable<AdapterContext['call']>).services),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
  now: (ctx) => (ctx.call as NonNullable<AdapterContext['call']>).services.clock().getTime(),
};

/** “just now”, “4 min ago”, “2 h ago”. */
function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** A person as the assistant reads them: never their spot on a map. */
function personOut(p: HostFindMyPerson) {
  return {
    name: p.name,
    place: p.place,
    ...(p.address ? { street: p.address } : {}),
    // Find My's own words for when it saw them (“Now”, “5 min ago”).
    ...(p.when ? { seen: p.when } : {}),
    ...(p.nearby ? { nearby: true } : {}),
  };
}

/** The people a `person` names: the whole name, else the first name, else a part of the name (without case). */
export function matchPeople(people: readonly HostFindMyPerson[], person: string): HostFindMyPerson[] {
  const want = person.trim().toLowerCase();
  const exact = people.filter((p) => p.name.toLowerCase() === want);
  if (exact.length) return exact;
  const first = people.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === want);
  if (first.length) return first;
  return people.filter((p) => p.name.toLowerCase().includes(want));
}

/** The answer from what the store has now (pure). */
export function peopleAnswer(
  shown: HostFindMy | null,
  options: { mac: string; person?: string | undefined; now: number; stillReading: boolean },
) {
  const { mac } = options;
  if (!shown?.readAt) {
    if (shown?.problem)
      return { error: findMyProblemText(shown.problem.code, mac, shown.problem.message), isError: true };
    return {
      error: options.stillReading
        ? `Whombat is still reading Find My on ${mac}. Ask again in a minute.`
        : `Whombat hasn’t read Find My on ${mac} yet.`,
      isError: true,
    };
  }
  const read = ago(options.now - new Date(shown.readAt).getTime());
  const why = shown.problem
    ? `It couldn’t read again just now: ${findMyProblemText(shown.problem.code, mac, shown.problem.message)}`
    : options.stillReading
      ? 'A new read is still under way.'
      : null;
  const picked = options.person ? matchPeople(shown.people, options.person) : shown.people;
  const missing =
    options.person && !picked.length
      ? `Nobody called ${options.person} is on Find My on ${mac}. People there: ${shown.people
          .map((p) => p.name)
          .join(', ')}.`
      : null;
  return {
    answer: {
      mac,
      read,
      readAt: shown.readAt,
      ...(why ? { note: `This is the read from ${read}. ${why}` } : {}),
      ...(missing ? { notFound: missing } : {}),
      people: picked.map(personOut),
    },
    isError: false,
  };
}

/** `findmy_people`, with the waits and the store it uses. */
export function findMyPeopleTool(deps: FindMyPeopleDeps = DEFAULT_DEPS): AdapterTool {
  return async (ctx, args) => {
    const parsed = FindMyPeopleArgs.safeParse(args);
    if (!parsed.success) throw new ConnectionArgumentError('person: a name or first name, or leave it out.');
    const serverId = ctx.fields.mac?.trim();
    if (!serverId)
      throw new ConnectionArgumentError('This Find My connection names no Mac. Pick one in its settings.');
    let s: Awaited<ReturnType<typeof scope>>;
    try {
      s = await deps.scope(ctx);
    } catch (err) {
      if (err instanceof ConnectionArgumentError) throw err;
      return failure(err, { server: serverId });
    }
    // The Mac's name as screens give it (the fleet read notes the names people gave their servers).
    if (!knownServer(serverId)) await s.hosts.fleetRaw().catch(() => null);
    const mac = serverLabel(serverId);
    const store = deps.store(ctx);
    // A read starts unless one runs or the last worked under two minutes ago; it leaves a Mac in use alone.
    const started = outsideCommandScope(() => store.refresh(s.hosts, serverId, s.actor('admin'), mac));
    let stillReading = false;
    if (started.reading)
      stillReading = !(await Promise.race([
        store.idle(serverId).then(() => true),
        deps.wait(FIND_MY_PEOPLE_WAIT_MS).then(() => false),
      ]));
    const shown = store.view(serverId);
    const res = peopleAnswer(shown, {
      mac,
      person: parsed.data.person,
      now: deps.now(ctx),
      stillReading: stillReading || shown.reading,
    });
    return 'error' in res ? output({ error: res.error }, true) : output(res.answer);
  };
}

/** Find My's typed tools (`findmy_people`), served through the connection's adapter. */
export const FINDMY_ADAPTER: Adapter = { findmy_people: findMyPeopleTool() };
