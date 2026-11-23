/**
 * Find My as a connection of its own (docs/decisions/findmy-connection.md): the connection names one of the person's
 * Macs (its `mac` field), which reads Find My through Whombat Helper. Here: which servers are Macs, the connection's
 * check (`mac`: the Mac is one of Whombat's servers, runs macOS and has a new enough helper; nothing ever touches its
 * screen), the Find My connections there are and which of them a live automation listens to.
 */
import { type FindMyTrigger, findMyBackgroundMinutes, findMyProblemText } from '@whombat/core';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { automations, automationVersions, catalogConnections } from '../db/schema/index';
import { HOSTS_API, HostsError, HostsUnavailable, seg } from './client';
import { helperTooOld } from './findmy';
import { arr, obj, osFamily } from './map';
import { serverLabel } from './self';
import { HOSTS_TEXT, type HostsService, WHOMBAT_ACTOR } from './service';

/** The catalog id of a Find My connection. */
export const FIND_MY_CATALOG_ID = 'findmy';

/** A Mac among Whombat's servers, as a Find My connection's `mac` field offers it. */
export interface FleetMac {
  id: string;
  name: string;
}

/** The Macs in a fleet read (`/fleet`), by the names screens give them, in the fleet's order. */
export function macsOf(fleet: unknown): FleetMac[] {
  return arr(obj(fleet).servers)
    .map(obj)
    .filter((c) => typeof c.id === 'string' && osFamily(c.os_family, c.detail_view) === 'macos')
    .map((c) => ({ id: String(c.id), name: serverLabel(String(c.id)) }));
}

/** Whether the fleet has a server by this id (ids compare without case, as the hosts service's do). */
function inFleet(fleet: unknown, serverId: string): boolean {
  const want = serverId.toLowerCase();
  return arr(obj(fleet).servers).some((c) => String(obj(c).id).toLowerCase() === want);
}

/** The Find My words people read about the Mac a connection names. */
export const FIND_MY_CONNECTION_TEXT = {
  noMac: 'Whombat doesn’t watch a Mac yet. Add your Mac in Servers first.',
  gone: (mac: string) => `${mac} isn’t one of Whombat’s servers any more. Pick another Mac.`,
  notMac: (server: string) => `${server} isn’t a Mac. Pick one of your Macs.`,
  taken: (mac: string) => `Find My on ${mac} is already connected.`,
} as const;

/** Why the `mac` check failed, in a word: no Mac at all, the Mac gone, a server that isn't a Mac, an old helper. */
export type MacProblem = 'no_mac' | 'gone' | 'not_mac' | 'helper_old';

/** What the `mac` check found: the Macs to choose from and, when it failed, why. */
export interface MacCheck {
  macs: FleetMac[];
  /** The Mac the connection reads (given, else the only one); null while there is a choice to make. */
  mac: string | null;
  problem: string | null;
  code?: MacProblem;
}

/**
 * The `mac` check from a fleet read (pure): the field's Mac (or the only Mac when none is given yet) is one of the
 * servers and runs macOS, and its helper isn't older than the first that reads Find My (`helperVersion` of its detail;
 * unknown isn't judged here, the read says so then).
 */
export function macCheckOf(fleet: unknown, mac: string | undefined, helperVersion: string | null): MacCheck {
  const macs = macsOf(fleet);
  const given = mac?.trim() || null;
  if (!given) {
    if (!macs.length) return { macs, mac: null, problem: FIND_MY_CONNECTION_TEXT.noMac, code: 'no_mac' };
    if (macs.length > 1) return { macs, mac: null, problem: null };
  }
  const id = given ?? (macs[0] as FleetMac).id;
  const found = macs.find((m) => m.id.toLowerCase() === id.toLowerCase());
  if (!found)
    return inFleet(fleet, id)
      ? { macs, mac: id, problem: FIND_MY_CONNECTION_TEXT.notMac(serverLabel(id)), code: 'not_mac' }
      : { macs, mac: id, problem: FIND_MY_CONNECTION_TEXT.gone(serverLabel(id)), code: 'gone' };
  if (helperTooOld(helperVersion))
    return { macs, mac: found.id, problem: findMyProblemText('helper_old', found.name), code: 'helper_old' };
  return { macs, mac: found.id, problem: null };
}

/** The helper's version a Mac's detail reports (`macos.helper.version`), or null. */
export function helperVersionOf(detail: unknown): string | null {
  const v = obj(obj(obj(detail).macos).helper).version;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * The `mac` check against the hosts service: the fleet, then the chosen Mac's detail for its helper. A hosts service
 * that isn't there or doesn't answer fails it with Whombat's words (`unanswered`: it didn't answer, rather than said no).
 */
export async function runMacCheck(
  hosts: Pick<HostsService, 'present' | 'fleetRaw' | 'call'>,
  mac: string | undefined,
): Promise<MacCheck & { unanswered: boolean }> {
  if (!hosts.present) return { macs: [], mac: null, problem: HOSTS_TEXT.absent, unanswered: false };
  let fleet: unknown;
  try {
    fleet = await hosts.fleetRaw();
  } catch (err) {
    if (err instanceof HostsUnavailable || err instanceof HostsError)
      return { macs: [], mac: null, problem: HOSTS_TEXT.down, unanswered: true };
    throw err;
  }
  const first = macCheckOf(fleet, mac, null);
  if (first.problem || !first.mac) return { ...first, unanswered: false };
  // The helper's version is on the Mac's detail; a detail that can't be read leaves it to the read to say.
  const detail = await hosts
    .call<unknown>({ path: `${HOSTS_API}/servers/${seg(first.mac)}`, actor: WHOMBAT_ACTOR })
    .catch(() => null);
  return { ...macCheckOf(fleet, mac, helperVersionOf(detail)), unanswered: false };
}

/** The Mac a Find My connection reads (its `mac` field), or null. */
export function macOf(row: { fields: Readonly<Record<string, string>> }): string | null {
  return row.fields.mac?.trim() || null;
}

/** Find My connections, oldest first: every burrow's, one burrow's, or those reading one Mac. */
export async function findMyConnections(
  db: Db | Tx,
  filter: { burrowId?: string; mac?: string } = {},
): Promise<(typeof catalogConnections.$inferSelect)[]> {
  const rows = await db
    .select()
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.catalogId, FIND_MY_CATALOG_ID),
        filter.burrowId ? eq(catalogConnections.burrowId, filter.burrowId) : undefined,
      ),
    )
    .orderBy(asc(catalogConnections.createdAt));
  const mac = filter.mac?.toLowerCase();
  return mac ? rows.filter((r) => macOf(r)?.toLowerCase() === mac) : rows;
}

/** A Find My connection of the burrow by id, or null. */
export async function findMyConnectionRow(db: Db | Tx, burrowId: string, connectionId: string) {
  const [row] = await db
    .select()
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.id, connectionId),
        eq(catalogConnections.burrowId, burrowId),
        eq(catalogConnections.catalogId, FIND_MY_CATALOG_ID),
      ),
    );
  return row ?? null;
}

/** The findmy triggers of a definition. */
export function findMyTriggers(definition: { triggers: readonly { kind: string }[] } | null | undefined) {
  return (definition?.triggers ?? []).filter((t): t is FindMyTrigger => t.kind === 'findmy');
}

/**
 * The Find My connections a live automation listens to (published, not deleted, a `findmy` trigger in its current
 * version), each with the name of the first such automation: the reason it reads in the background.
 */
export async function listenedFindMyConnections(db: Db | Tx): Promise<Map<string, string>> {
  const rows = await db
    .select({ name: automations.name, definition: automationVersions.definition })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(
      and(
        eq(automations.status, 'published'),
        isNull(automations.deletedAt),
        sql`exists (select 1 from jsonb_array_elements(${automationVersions.definition} -> 'triggers') as t
          where t ->> 'kind' = 'findmy')`,
      ),
    )
    .orderBy(asc(automations.createdAt));
  const out = new Map<string, string>();
  for (const { name, definition } of rows)
    for (const t of findMyTriggers(definition)) if (!out.has(t.connectionId)) out.set(t.connectionId, name);
  return out;
}

/** How a Find My connection reads without anyone looking (`HostFindMy.background`): its pace and why. */
export interface FindMyPace {
  everyMinutes: number;
  /** The automation that needs it, when that is why it reads this often; null: the person's own setting. */
  automation: string | null;
}

/**
 * The pace of a connection (pure): its own setting, or every `listenedMinutes` while an automation listens when that is
 * sooner (or the setting is Off); null when it doesn't read in the background.
 */
export function findMyPace(
  background: string | undefined,
  listenedBy: string | null,
  listenedMinutes: number,
): FindMyPace | null {
  const own = findMyBackgroundMinutes(background);
  if (listenedBy !== null && (own === null || own > listenedMinutes))
    return { everyMinutes: listenedMinutes, automation: listenedBy };
  return own === null ? null : { everyMinutes: own, automation: null };
}
