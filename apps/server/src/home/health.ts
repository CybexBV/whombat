/**
 * Connection health (one-whombat-assistant.md ONE-DW26, ONE-DW27; connection-pages.md CP-15, CP-16): every 5 minutes
 * each active connection gets its entry's cheap check, timed — its response time is a point for the page's chart
 * (`rtt_ms`, null when the check failed) — and, where Whombat has words for it, a glance for its tile on Home from the
 * same reader its page uses: Home Assistant how it runs (its version, integrations loaded, errors today, updates; yellow
 * while integrations don't load or a Repair is serious), UniFi Network the internet line, access points online and
 * clients (and the line's down and up as points), Hetzner servers running. Others show their state and “Last checked”.
 * Points for the pages' charts (dashboards.md DS-11): Home Assistant's errors since the restart (`log_err`, the noisiest
 * source's `log_err_top` with its name on the glance) and its database (`db_mb`); UniFi's gateway CPU and memory and
 * its clients; and for every connection Whombat knows the machine of (CP-08), that machine's disk (`disk_pct`,
 * `disk_gb`; Home Assistant OS's Supervisor's when Whombat doesn't watch it).
 * Since service-dashboards.md SD-S01 every kind's look comes from the kinds registry (`things/kinds/index.ts`, its
 * module's `seen`); Unraid, part of a server rather than a page of its own, keeps its hostname here.
 * A refused credential goes through the connect side's confirmation (`needs_reauth`); a connection that doesn't answer
 * shows offline, keeping its last facts. Written with the pipeline's transaction (no person acted, nothing signed);
 * `home.changed {things}` only when what shows changed.
 *
 * The dot (quiet-notices.md QN-02, QN-04, QN-11; QN-S03…QN-S08): the pass gathers the thing's lines as its page shows
 * them — the kind's (`seen.notices`), the generic ones (signed out, not answering, failed stored checks) and the disk of
 * the machine it runs on — and works its status and reason out with its quiet rows (`applyQuiet`): heads-ups, quieted
 * and not-yet-confirmed lines don't colour it. Ignores that end by themselves end here (fixed, newer, period, worse), the
 * line states move on, and the glance keeps the lines that could colour it, so a read works the dot out again with the
 * quiet rows of that moment. A failed check reads none of the kind's checks (`skipped`): nothing ends for them.
 */
import {
  type CatalogEntry,
  catalogEntry,
  isAgentConnection,
  isGatewayConnection,
  resolveMcpUrl,
  type SignInKind,
  thingId,
} from '@whombat/core';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { outsideCommandScope } from '../commit/scope';
import { recordFromCheck, runCatalogCheck } from '../connections/checks';
import { credentialFor } from '../connections/credentials';
import { confirmRefusedCredential } from '../connections/refused';
import { type CatalogConnectionRow, ConnectionAuthError } from '../connections/types';
import { burrows, catalogConnections } from '../db/schema/index';
import { sideBySide } from '../lib/side-by-side';
import type { Services } from '../services';
import { kindFor } from '../things/kinds/index';
import type { KindSeen } from '../things/kinds/registry';
import { unraidHostname } from '../things/kinds/unraid';
import { diskNotice, diskNow, type MachineNow } from '../things/machine';
import { answerCheckOf, genericNotices, signinNotice } from '../things/panels';
import { within } from '../things/part-of';
import {
  DISK_GB_KEY,
  DISK_PCT_KEY,
  POINTS_KEEP_MS,
  RTT_KEY,
  readPoints,
  recordPoints,
} from '../things/points';
import { applyQuiet, isSkipped, lineKey, type Skipped } from '../things/quiet/apply';
import { notWatched } from '../things/quiet/defaults';
import { colours, GLANCE_LINES_MAX, glanceLine } from '../things/quiet/glance';
import {
  type PassQuiet,
  passQuiet,
  pruneGoneThings,
  thingQuiet,
  thingStates,
  writePass,
} from '../things/quiet/store';
import type { LooseNotice } from '../things/quiet/types';
import { readMachine, resolveRunsOn } from '../things/runs-on';
import { forecastFull } from '../things/series';
import { TRACKER_CATALOG_ID } from '../trackers/connection';
import { homeAudience, publishHomeChanged } from './notify';
import type { ConnectionGlance } from './types';

/**
 * The connections the pass looks at: the agents', the AI gateways (fusebox-page.md FP-01) and the report trackers (their
 * driver's check, so a tracker that stopped answering or a driver that didn't load reaches “Whether it answers”); not
 * other connections only automations use. Looking doesn't make a connection an agent's.
 */
function watched(entry: CatalogEntry): boolean {
  return isAgentConnection(entry) || isGatewayConnection(entry) || entry.id === TRACKER_CATALOG_ID;
}

/** Connections looked at in one pass (the rest wait for the next). */
const PASS_MAX = 50;
/** How many connections a pass looks at side by side (PS-04). */
const PASS_PARALLEL = 4;
/** A connection looked at less than this long ago is skipped. */
const FRESH_MS = 4 * 60_000;

/** Home Assistant's points (DS-11), kept with its kind (`things/kinds/first.ts`). */
export { haSeenPoints } from '../things/kinds/first';

/** The machine's disk as points (`disk_pct`, `disk_gb`), when its size is known. */
export function diskPoints(m: MachineNow | null): Record<string, number> {
  const disk = diskNow(m);
  if (!disk) return {};
  return {
    [DISK_PCT_KEY]: Math.round((disk.used / disk.total) * 1000) / 10,
    [DISK_GB_KEY]: Math.round(disk.used * 100) / 100,
  };
}

/**
 * The disk of the machine a connection runs on, when Whombat knows it (a few seconds at most; nothing otherwise), or of
 * the machine as its kind sees it (Home Assistant OS's Supervisor's): its points, and the line its page shows about it
 * (`machine.disk`, `machine.disk_forecast`; QN-S11). `read` is false when no machine could be read.
 */
async function machineDisk(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  seen?: KindSeen['machine'],
): Promise<{ points: Record<string, number>; line: LooseNotice | null; read: boolean }> {
  const at = row.burrowId ? await within(resolveRunsOn(services, row.burrowId, row), 5_000, null) : null;
  const figures = at ? await within(readMachine(services, at, null), 5_000, null) : null;
  const m = seen ? seen(figures) : figures;
  if (!m) return { points: {}, line: null, read: false };
  const pct =
    (await readPoints(services.db, row.id, [DISK_PCT_KEY], now, POINTS_KEEP_MS)).get(DISK_PCT_KEY) ?? [];
  const name = figures?.name ?? null;
  const line = diskNotice(m, forecastFull(pct, 100, now), {
    now,
    timeZone: 'UTC',
    ...(name ? { where: name } : {}),
    question: name
      ? `The disk of ${name} is filling up. What takes the space, and what can go?`
      : `The disk ${row.label} runs on is filling up. What takes the space, and what can go?`,
  });
  return { points: diskPoints(m), line, read: true };
}

/**
 * The line a kind from before quiet notices stands for (no `seen.notices`): its glance's status and reason, as one line
 * that can't be quieted (QN-S08). Null when it is fine.
 */
function olderKindLine(glance: KindSeen['glance']): LooseNotice | null {
  if (glance.status !== 'warn' && glance.status !== 'bad') return null;
  return {
    id: 'kind',
    tone: glance.status,
    icon: 'warn',
    title: (glance.reason ?? 'Needs a look').slice(0, 120),
    nature: 'problem',
  };
}

/** Only these checks were read: a check that failed tells nothing about the kind's (QN-S04). */
const onlyRead =
  (...read: string[]): Skipped =>
  (check) =>
    !read.includes(check);

/** The burrow's time zone (which log errors still come in today). */
async function zoneOf(services: Services, row: CatalogConnectionRow): Promise<string> {
  const [b] = await services.db
    .select({ timeZone: burrows.timeZone })
    .from(burrows)
    .where(eq(burrows.id, row.burrowId));
  return b?.timeZone ?? 'UTC';
}

/**
 * The glance of an entry Whombat has words for, from its kind's reader (the registry's `seen`, SD-S01, SD-05); null for
 * the others. Unraid's own name, for the server it is part of (SB-09): its address may not be the one the server reports.
 */
async function seenOf(
  services: Services,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
  now: Date,
  quiet?: Awaited<ReturnType<typeof thingQuiet>>,
): Promise<KindSeen | null> {
  if (entry.id === 'unraid') {
    const hostname = await unraidHostname(services, row);
    return { glance: { facts: [], ...(hostname ? { hostname } : {}) }, points: {} };
  }
  const seen = kindFor(row)?.seen;
  return seen ? seen(services, row, now, await zoneOf(services, row), quiet) : null;
}

/**
 * A check that didn't work: the words are the line and the reason (sidebar.md SB-03); the figures and the machine's name
 * stay from before.
 */
/** A kind's own words for a check that got no answer (a console resting), or null; its failure is no words. */
async function unansweredWords(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<string | null> {
  return (
    (await kindFor(row)
      ?.unanswered?.(services, row, now)
      .catch(() => null)) ?? null
  );
}

function failed(
  status: 'bad' | 'warn' | 'offline',
  words: string,
  previous: ConnectionGlance | null,
): ConnectionGlance {
  return {
    status,
    line: words,
    facts: previous?.facts ?? [],
    reason: words,
    ...(previous?.hostname ? { hostname: previous.hostname } : {}),
  };
}

/** What a pass reads once for every connection it looks at: their quiet rows and line states, and whom Home tells. */
export interface HealthPass {
  quiet: PassQuiet;
  /** The person a burrow's `home.changed` is for (`homeAudience`), read once per burrow in the pass. */
  audience(burrowId: string): Promise<string[]>;
}

/** The pass's shared reads for `rows`; null when they can't be read, and each connection reads its own as alone. */
async function healthPass(
  services: Services,
  rows: readonly CatalogConnectionRow[],
): Promise<HealthPass | null> {
  const quiet = await passQuiet(
    services.db,
    rows.map((r) => ({ owner: r.burrowId, thingId: thingId('connection', r.id) })),
  ).catch(() => null);
  if (!quiet) return null;
  const people = new Map<string, Promise<string[]>>();
  return {
    quiet,
    audience(burrowId) {
      let read = people.get(burrowId);
      if (!read) {
        const made = homeAudience({ tx: services.db }, burrowId);
        // A failed read is that connection's failure alone: the next one asks again.
        made.catch(() => {
          if (people.get(burrowId) === made) people.delete(burrowId);
        });
        people.set(burrowId, made);
        read = made;
      }
      return read;
    },
  };
}

/**
 * Looks at one connection now: its check, its glance; returns the glance it stored. `pass`: what the pass read once
 * for all its connections; without it the connection reads its own.
 */
export async function checkConnectionHealth(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
  pass: HealthPass | null = null,
): Promise<ConnectionGlance | null> {
  const entry = catalogEntry(row.catalogId);
  if (!entry || entry.transport === 'builtin' || !watched(entry)) return null;
  const previous = row.glance as ConnectionGlance | null;
  const thing = thingId('connection', row.id);
  const burrowId = row.burrowId;
  const kept = pass
    ? Promise.resolve([pass.quiet.of(burrowId, thing), pass.quiet.states(thing)] as const)
    : Promise.all([thingQuiet(services.db, burrowId, thing), thingStates(services.db, thing)]);
  let glance: ConnectionGlance;
  let points: Record<string, number | null> = { [RTT_KEY]: null };
  // Its lines as its page would show them (QN-S03), and the checks this pass didn't read (QN-S04).
  let lines: LooseNotice[] = [];
  let skipped: Skipped = [];
  const answered = (outcome: 'offline' | 'error') =>
    genericNotices(
      {
        status: row.status,
        catalogId: row.catalogId,
        glance: { status: 'ok', outcome, facts: [] },
        checks: row.checks,
        label: row.label,
      },
      0,
      null,
    );
  try {
    const credential = await credentialFor(services, row);
    const started = Date.now();
    const outcome = await runCatalogCheck(services, {
      entry,
      signIn: row.signIn as SignInKind,
      baseUrl: row.baseUrl,
      mcpUrl: resolveMcpUrl(entry, row.fields, row.signIn as SignInKind),
      fields: row.fields,
      credential,
    });
    if (outcome.refused) {
      await outsideCommandScope(() => confirmRefusedCredential(services, row.id));
      glance = failed('bad', 'Needs you to sign in again', previous);
      lines = [signinNotice(row.label)];
      skipped = onlyRead('conn.signin');
    } else if (!outcome.ok) {
      const how = outcome.status === null ? 'offline' : 'error';
      const own = await unansweredWords(services, row, now);
      glance = {
        ...(how === 'offline'
          ? failed('offline', own ?? 'Couldn’t reach it', previous)
          : failed('warn', own ?? 'It answered with an error', previous)),
        outcome: how,
      };
      lines = answered(how);
      skipped = onlyRead(answerCheckOf(row.catalogId), 'conn.check');
    } else {
      points = { [RTT_KEY]: Date.now() - started };
      // What the answer filled (Nextcloud's user id, connection-signin.md SG-15a), for the next calls.
      await recordFromCheck(services, row, outcome);
      const quiet = (await kept.catch(() => null))?.[0];
      const seen = await seenOf(services, row, entry, now, quiet).catch(() => undefined);
      lines = genericNotices({ ...row, glance: null }, 0, null);
      if (seen === undefined) {
        // The check answered but the reader didn't: what showed stays, and none of the kind's checks were read.
        glance = {
          status: 'ok',
          ...(previous?.line ? { line: previous.line } : {}),
          facts: previous?.facts ?? [],
          ...(previous?.hostname ? { hostname: previous.hostname } : {}),
        };
        skipped = (check) => !check.startsWith('conn.');
      } else {
        Object.assign(points, seen?.points ?? {});
        glance = {
          status: 'ok',
          ...(seen?.glance.line ? { line: seen.glance.line } : {}),
          facts: seen?.glance.facts ?? [],
          ...(seen?.glance.logTop ? { logTop: seen.glance.logTop } : {}),
          ...(seen?.glance.hostname ? { hostname: seen.glance.hostname } : {}),
          ...(seen?.glance.activity ? { activity: seen.glance.activity } : {}),
        };
        if (seen) {
          if (seen.notices) lines.push(...seen.notices);
          else {
            const older = olderKindLine(seen.glance);
            if (older) lines.push(older);
          }
          skipped = seen.skipped ?? [];
        }
      }
      const disk = await machineDisk(services, row, now, seen?.machine).catch(() => null);
      Object.assign(points, disk?.points ?? {});
      // A kind that draws its machine says its disk itself (Home Assistant's Supervisor); one line per check.
      const own = new Set(lines.map((l) => l.check).filter(Boolean));
      if (disk?.line && !own.has(disk.line.check)) lines.push(disk.line);
      if (!disk?.read) {
        const before = skipped;
        skipped = (check) => check.startsWith('machine.') || isSkipped(before, check);
      }
    }
  } catch (err) {
    if (err instanceof ConnectionAuthError) {
      glance = failed('bad', 'Needs you to sign in again', previous);
      lines = [signinNotice(row.label)];
      skipped = onlyRead('conn.signin');
    } else {
      glance = {
        ...failed('offline', (await unansweredWords(services, row, now)) ?? 'Couldn’t reach it', previous),
        outcome: 'offline',
      };
      lines = answered('offline');
      skipped = onlyRead(answerCheckOf(row.catalogId), 'conn.check');
    }
  }
  const [quiet, states] = await kept;
  const result = applyQuiet({
    lines,
    quiets: quiet.quiets,
    ...notWatched(quiet),
    states,
    now,
    pass: true,
    skipped,
  });
  const seenPasses = new Map(result.states.map((st) => [lineKey(st.checkId, st.subject), st.seenPasses]));
  const passesOf = (l: LooseNotice) =>
    l.check ? seenPasses.get(lineKey(l.check, l.subject?.id)) : undefined;
  glance = {
    ...glance,
    status: result.worst ? (result.worst.offline ? 'offline' : result.status) : 'ok',
    ...(result.reason ? { reason: result.reason } : {}),
    lines: [...result.active, ...result.quiet.map((q) => q.line)]
      .filter(colours)
      .slice(0, GLANCE_LINES_MAX)
      .map((l) => glanceLine(l, passesOf(l))),
  };
  if (!result.reason) delete glance.reason;
  const changed = shownText(previous) !== shownText(glance);
  // Read before the transaction: it doesn't wait on another connection while it holds one.
  const audience = changed && pass ? await pass.audience(row.burrowId) : null;
  await services.pipeline.transact(row.burrowId, async (session) => {
    await session.tx
      .update(catalogConnections)
      .set({ glance, glanceAt: now, checkedAt: now })
      .where(eq(catalogConnections.id, row.id));
    await recordPoints(session.tx, row.id, now, points);
    await writePass(session.tx, burrowId, thing, result);
    if (!changed) return;
    publishHomeChanged(session, audience ?? (await homeAudience(session, row.burrowId)), ['things', 'watch']);
  });
  return glance;
}

/** What a glance shows (its lines by item and tone, not their words): Home hears of a change only when this moves. */
function shown(g: ConnectionGlance | null) {
  if (!g) return null;
  // Home doesn't show the activity (the desk's calm glance reads it on its own beat), so a queue ticking down stays quiet.
  const { lines, activity: _activity, ...rest } = g;
  return {
    ...rest,
    lines: lines?.map((l) => [l.check, l.subject?.id, l.tone, l.nature, (l.seen ?? 0) >= 2]),
  };
}

/**
 * `shown` as text with every object's keys in order: the previous glance comes back from jsonb, which stores keys in
 * its own order, so plain text would differ on every pass and tell Home of a change that isn't one.
 */
function shownText(g: ConnectionGlance | null): string {
  return JSON.stringify(shown(g), (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
}

/** How often the rows of things that are gone are swept (quiet-notices.md QN-S02). */
const PRUNE_EVERY_MS = 3600_000;
const pruned = new WeakMap<Services, number>();

/** One pass of the poller (`home.connection-health`): connections not looked at for a while. Returns how many. */
export async function pollConnectionHealth(services: Services, now = services.clock()): Promise<number> {
  if (now.getTime() - (pruned.get(services) ?? 0) >= PRUNE_EVERY_MS) {
    pruned.set(services, now.getTime());
    await pruneGoneThings(services.db).catch((err) =>
      services.log.warn({ err: String(err) }, 'connection health: sweeping quiet rows failed'),
    );
  }
  const rows = await services.db
    .select()
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.status, 'active'),
        or(
          isNull(catalogConnections.glanceAt),
          lt(catalogConnections.glanceAt, new Date(now.getTime() - FRESH_MS)),
        ),
      ),
    )
    .orderBy(catalogConnections.glanceAt)
    .limit(PASS_MAX);
  const due = rows.filter((row) => {
    const entry = catalogEntry(row.catalogId);
    return !!entry && entry.transport !== 'builtin' && watched(entry);
  });
  // The quiet rows, line states and people once for the pass, not four reads and a person per connection.
  const pass = due.length ? await healthPass(services, due) : null;
  // Side by side (page-speed.md PS-04): one slow service doesn't hold up the others' tiles.
  await sideBySide(due, PASS_PARALLEL, (row) =>
    checkConnectionHealth(services, row, now, pass).catch((err) =>
      services.log.warn(
        { err: err instanceof Error ? err.name : 'error' },
        'connection health: check failed',
      ),
    ),
  );
  return due.length;
}
