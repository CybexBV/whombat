/**
 * Quiet notices on a server (quiet-notices.md QN-10…QN-17, QN-21, QN-23; QN-S50…QN-S59). An alert's Ignore is the hosts
 * service's acknowledgement until it resolves (or its severity rises, hosts HS-193). Remind me tomorrow is its
 * acknowledgement until 09:00 tomorrow in the burrow's zone; Undo takes either back. Stop watching switches the alert's
 * rule off for the server, or for one disk, mount or guest, in the hosts service (HS-194…HS-196). A hint is quieted
 * in Whombat's own store under the thing `server:<id>`, keyed by its check and item (`hostNoticeSubjectId`), with the
 * store's commands; a pass every 5 minutes ends the hint rows that end by themselves (`quietServerPass`). Who may: the
 * routes ask (the person, QN-10); here the line must exist now, and every change is signed in the server's Activity.
 * Checks that start off (watch-defaults.md): a hint kind's lines are left out until someone turns it on (a `watch_ons`
 * row); an alert rule is switched off in the hosts service by the same pass, as Whombat, unless someone turned it on.
 */
import {
  HOST_WATCH_CHECKS,
  type HostAlert,
  type HostHint,
  type HostWatchCheck,
  hostAlertCheck,
  hostEntityName,
  hostNoticeSubjectId,
  type NoticeQuiet,
  type NoticeRef,
  type NoticeSubject,
  type ThingWatch,
  type ThingWatchCheck,
} from '@whombat/core';
import { and, eq, like } from 'drizzle-orm';
import { externalEffect } from '../commit/scope';
import type { Tx } from '../db/client';
import { noticeQuiets, noticeStates, watchOffs, watchOns } from '../db/schema/index';
import { addQuietExceptions, watchList } from '../domain/quiet-watch';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { ApiError, badRequest, conflict, notAllowed, notFound } from '../lib/errors';
import { loadPrincipalRow, type PrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { applyQuiet } from '../things/quiet/apply';
import { quietNotice, setWatch } from '../things/quiet/commands';
import { notWatched } from '../things/quiet/defaults';
import { type QuietBook, quietBook, thingQuiet, writePass } from '../things/quiet/store';
import { quietNames, quietOf } from '../things/quiet/wire';
import { lowerWords, quietTitle, snoozeUntil, untilWords, watchTitle } from '../things/quiet/words';
import { fleetHints } from './agent-updates';
import { HOSTS_API, HostsError, HostsUnavailable, seg } from './client';
import { recordServerQuiet } from './commands';
import { hostsCall, refusedBeforeActing, toApiError } from './errors';
import { arr, hintGuests, obj, toHostAlert, toHostHint } from './map';
import { alertLine, alertQuiet, HUB_LEVEL, hintLine, hintRefId, hubBy, serverThingId } from './quiet-lines';
import { serverLabel } from './self';
import { actorOf, type HostsService, hostsFor, WHOMBAT_ACTOR } from './service';

/** The longest snooze the hosts service takes (30 days, in minutes). */
const SNOOZE_MAX_MIN = 43_200;

/** Every check a server can raise (QN-15): its 26 alert rules and every hint kind; the hub's own checks aren't. */
export const SERVER_CHECKS: readonly HostWatchCheck[] = HOST_WATCH_CHECKS.filter(
  (c) => !(c.rule && HUB_LEVEL(c.rule)),
);

const checkOf = (check: string) => SERVER_CHECKS.find((c) => c.check === check);

/** A change on the hosts service before it is signed: a refusal is the service's, in Whombat's words. */
function onHub<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return hostsCall(() =>
    externalEffect(`hosts.${label}`, fn, {
      refused: (err) =>
        refusedBeforeActing(err) ||
        (err instanceof HostsUnavailable && err.reason !== 'timeout' && err.reason !== 'broken'),
    }),
  );
}

interface Who {
  hosts: HostsService;
  burrowId: string;
  timeZone: string;
  person: PrincipalRow;
}

/** The hosts service for this burrow and the person acting; `not_found` where it doesn't watch servers. */
async function who(services: Services, burrowId: string, actorId: string): Promise<Who> {
  const hosts = hostsFor(services);
  if (!(await hosts.serves(burrowId).catch(() => false))) throw notFound('Thing');
  const person = await loadPrincipalRow(services.db, actorId);
  if (person?.kind !== 'person') throw notAllowed('Only people quiet what Whombat watches.');
  const burrow = await hosts.homeBurrow();
  return { hosts, burrowId, timeZone: burrow?.timeZone ?? 'UTC', person };
}

/** A server's name as Activity says it (“The Titan”, “BlackBox”): its given name, the fleet's, else its id. */
const serverName = serverLabel;

/** Signs a quiet change of a server's alert or rule in its Activity (QN-17). */
async function sign(
  services: Services,
  w: Who,
  input: Omit<Parameters<(typeof recordServerQuiet)['apply']>[2], 'serverName'>,
): Promise<void> {
  await services.pipeline.commit(
    recordServerQuiet,
    { ...input, serverName: serverName(input.serverId) },
    { burrowId: w.burrowId, actorId: w.person.id },
  );
}

/* Alerts ----------------------------------------------------------------------------------------------------------- */

/**
 * Ignore, Remind me tomorrow or Undo on open alerts of a server (QN-11, QN-12, QN-21, QN-23): the hosts service's
 * acknowledgement as the person, then the change signed. Undo takes back only what someone acknowledged (maintenance
 * and an offline parent aren't Whombat's to take back). The first alert's quiet after it; null after Undo.
 */
async function quietAlerts(
  services: Services,
  w: Who,
  alerts: readonly HostAlert[],
  how: 'ignore' | 'snooze' | 'undo',
  until?: string,
): Promise<NoticeQuiet | null> {
  const first = alerts[0];
  if (!first) throw notFound('Notice');
  const now = services.clock();
  const actor = actorOf(w.person, 'operator');
  const line = alertLine(first);
  const base = {
    serverId: first.serverId ?? 'whombat',
    check: line.check,
    ...(line.subject ? { subject: line.subject.id } : {}),
  };
  if (how === 'undo') {
    const acked = alerts.filter((a) => a.acknowledged);
    if (!acked.length) throw notFound('Quiet');
    const wasSnoozed = acked.some(
      (a) => a.acknowledged?.until && Date.parse(a.acknowledged.until) > now.getTime(),
    );
    for (const a of acked)
      await onHub('unackAlert', () =>
        w.hosts.call<unknown>({ method: 'DELETE', path: `${HOSTS_API}/alerts/${seg(a.id)}/ack`, actor }),
      );
    w.hosts.forget('fleet');
    await sign(services, w, {
      ...base,
      kind: wasSnoozed ? 'quiet.unsnooze' : 'quiet.unignore',
      title: quietTitle(wasSnoozed ? 'unsnooze' : 'unignore', line.title, ''),
    });
    return null;
  }
  let minutes = 0;
  let end: Date | null = null;
  if (how === 'snooze') {
    end = until ? new Date(until) : snoozeUntil(now, w.timeZone);
    minutes = Math.ceil((end.getTime() - now.getTime()) / 60_000);
    if (!Number.isFinite(minutes) || minutes < 1) throw badRequest('Pick a time that is still to come.');
    if (minutes > SNOOZE_MAX_MIN) throw badRequest('Pick a time within the next month.');
  }
  let after: HostAlert | null = null;
  for (const a of alerts) {
    const raw = await onHub('ackAlert', () =>
      w.hosts.call<unknown>({
        method: 'POST',
        path: `${HOSTS_API}/alerts/${seg(a.id)}/ack`,
        body: minutes ? { minutes } : {},
        actor,
      }),
    );
    after ??= toHostAlert(raw);
  }
  w.hosts.forget('fleet');
  const words =
    how === 'ignore'
      ? lowerWords(hostAlertCheck(first.rule).words)
      : untilWords(end as Date, now, w.timeZone);
  await sign(services, w, { ...base, kind: `quiet.${how}`, title: quietTitle(how, line.title, words) });
  if (!after) return null;
  const names = await quietNames(services.db, [{ byId: w.person.id }]);
  return alertQuiet(after, { now, names, untilWords: (d) => untilWords(d, now, w.timeZone) }) ?? null;
}

/**
 * Needs you's and Watch's Ignore, Remind me tomorrow and Undo on one alert by its id (QN-21): as `things.quiet` does
 * for its line. `not_found` when it isn't open now.
 */
export async function quietAlertById(
  services: Services,
  ctx: {
    burrowId: string;
    actorId: string;
    alertId: string;
    how: 'ignore' | 'snooze' | 'undo';
    until?: string;
  },
): Promise<NoticeQuiet | null> {
  const w = await who(services, ctx.burrowId, ctx.actorId);
  w.hosts.forget('fleet');
  const alert = (await hostsCall(() => w.hosts.fleet())).alerts.find(
    (a) => a.id === ctx.alertId && a.state === 'open',
  );
  if (!alert) throw notFound('Notice');
  return quietAlerts(services, w, [alert], ctx.how, ctx.until);
}

/**
 * The line of a Watch hint by its id (`hintRefId`), as `things.quiet` takes it for its server; null where no servers
 * are watched or the hint isn't there now.
 */
export async function hintNoticeById(
  services: Services,
  burrowId: string,
  hintId: string,
): Promise<{ thing: string; notice: NoticeRef } | null> {
  const hosts = hostsFor(services);
  if (!(await hosts.serves(burrowId).catch(() => false))) return null;
  const hint = (await hostsCall(() => hosts.fleet())).hints.find((h) => hintRefId(h) === hintId);
  if (!hint) return null;
  const line = hintLine(hint);
  return {
    thing: serverThingId(hint.serverId),
    notice: { check: line.check, ...(line.subject ? { subject: line.subject.id } : {}) },
  };
}

/* things.quiet ----------------------------------------------------------------------------------------------------- */

const sameItem = (subject: NoticeSubject | undefined, id: string | undefined) =>
  (subject?.id ?? '') === (id ?? '');

/** `things.quiet` for `server:<id>`: the line's quiet now, null after Undo; `not_found` for a line it doesn't have. */
export async function quietServerNotice(
  services: Services,
  ctx: {
    burrowId: string;
    actorId: string;
    serverId: string;
    notice: NoticeRef;
    how: 'ignore' | 'snooze' | 'undo';
    until?: string;
  },
): Promise<NoticeQuiet | null> {
  const w = await who(services, ctx.burrowId, ctx.actorId);
  w.hosts.forget('fleet');
  const fleet = await hostsCall(() => w.hosts.fleet());
  if (!fleet.servers.some((s) => s.id === ctx.serverId)) throw notFound('Thing');
  const { check, subject } = ctx.notice;
  const alerts = fleet.alerts.filter((a) => {
    if (a.serverId !== ctx.serverId || a.state !== 'open') return false;
    const l = alertLine(a);
    return l.check === check && sameItem(l.subject, subject);
  });
  if (alerts.length) return quietAlerts(services, w, alerts, ctx.how, ctx.until);
  if (!check.startsWith('host.hint.')) throw notFound(ctx.how === 'undo' ? 'Quiet' : 'Notice');
  return quietHint(services, w, ctx.serverId, fleet.hints, ctx.notice, ctx.how, ctx.until);
}

/** The thing a server's hint rows belong to (the store's `QuietThing`). */
function thingOf(w: Who, serverId: string) {
  return {
    id: serverThingId(serverId),
    kind: 'server' as const,
    ref: serverId.slice(0, 160),
    name: serverName(serverId),
    owner: w.burrowId,
  };
}

/** A hint's Ignore, Remind me tomorrow or Undo: a row of the quiet store, through its command (QN-23, QN-S55). */
async function quietHint(
  services: Services,
  w: Who,
  serverId: string,
  hints: readonly HostHint[],
  notice: NoticeRef,
  how: 'ignore' | 'snooze' | 'undo',
  until?: string,
): Promise<NoticeQuiet | null> {
  const thing = thingOf(w, serverId);
  const now = services.clock();
  let input: Parameters<(typeof quietNotice)['apply']>[2];
  if (how === 'undo') {
    const [row] = await services.db
      .select({ subjectName: noticeQuiets.subjectName })
      .from(noticeQuiets)
      .where(
        and(
          eq(noticeQuiets.ownerId, w.burrowId),
          eq(noticeQuiets.thingId, thing.id),
          eq(noticeQuiets.checkId, notice.check),
          eq(noticeQuiets.subject, notice.subject ?? ''),
        ),
      );
    if (!row) throw notFound('Quiet');
    input = {
      thing,
      line: {
        check: notice.check,
        ...(notice.subject
          ? { subject: { id: notice.subject, name: (row.subjectName ?? notice.subject).slice(0, 80) } }
          : {}),
      },
      how: 'undo',
      timeZone: w.timeZone,
    };
  } else {
    const hint = hints.find((h) => {
      if (h.serverId !== serverId) return false;
      const l = hintLine(h);
      return l.check === notice.check && sameItem(l.subject, notice.subject);
    });
    if (!hint) throw notFound('Notice');
    const line = hintLine(hint, hintGuests(hint));
    input = {
      thing,
      line: {
        check: line.check,
        ...(line.subject ? { subject: line.subject } : {}),
        title: line.title,
        tone: line.tone,
        ...(line.band != null ? { band: line.band } : {}),
        ...(line.episode ? { episode: line.episode } : {}),
        lifts: line.ignore.lifts,
        words: line.ignore.words,
      },
      how,
      ...(how === 'snooze' ? { until: until ?? snoozeUntil(now, w.timeZone).toISOString() } : {}),
      timeZone: w.timeZone,
    };
  }
  const result = await services.pipeline.commit(quietNotice, input, {
    burrowId: w.burrowId,
    actorId: w.person.id,
  });
  if (result.status !== 'ok') throw notAllowed('This can’t be quieted now.');
  const row = result.result.row;
  w.hosts.forget('fleet');
  // The server's row goes out again when its dot changed (realtime `hosts.server`).
  w.hosts.touched(serverId);
  if (!row) return null;
  return quietOf(row, await quietNames(services.db, [row]), now, w.timeZone);
}

/* What Whombat watches --------------------------------------------------------------------------------------------- */

/** The hub's watch settings, its refusals in Whombat's words (`server_not_found` → not found). */
async function hubOffs(w: Who, serverId: string) {
  try {
    return await w.hosts.watchRaw(serverId);
  } catch (err) {
    if (err instanceof HostsError && err.status === 404) throw notFound('Thing');
    throw toApiError(err);
  }
}

/** `things.watch` for `server:<id>`: one switch per check, and what is excepted under it (QN-15). */
export async function serverWatch(
  services: Services,
  ctx: { burrowId: string; actorId: string; serverId: string },
): Promise<ThingWatch> {
  const w = await who(services, ctx.burrowId, ctx.actorId);
  return watchOf(services, w, ctx.serverId);
}

async function watchOf(services: Services, w: Who, serverId: string): Promise<ThingWatch> {
  const now = services.clock();
  const [offs, fleet, quiet] = await Promise.all([
    hubOffs(w, serverId),
    hostsCall(() => w.hosts.fleet()),
    thingQuiet(services.db, w.burrowId, serverThingId(serverId)),
  ]);
  const acked = fleet.alerts.filter((a) => a.serverId === serverId && a.state === 'open' && a.acknowledged);
  const hubPeople = [...offs.map((o) => o.by), ...acked.map((a) => a.acknowledged?.by)]
    .map(hubBy)
    .filter((p): p is { id: string; name: string } => p !== null);
  const names = await quietNames(services.db, [
    ...quiet.quiets,
    ...quiet.offs,
    ...hubPeople.map((p) => ({ byId: p.id })),
  ]);
  const by = (id: string | null | undefined) => {
    const name = id ? names.get(id) : undefined;
    return id && name ? { by: { id, name } } : {};
  };
  const hubByOf = (raw: string | null | undefined) => by(hubBy(raw)?.id);
  const turnedOn = new Set(quiet.ons.map((o) => o.checkId));
  const checks = new Map<string, ThingWatchCheck>(
    SERVER_CHECKS.map((c) => [
      c.check,
      {
        check: c.check,
        name: c.name,
        nature: c.nature,
        on: c.startsOn || turnedOn.has(c.check),
        perItem: c.perItem,
        exceptions: [],
      },
    ]),
  );
  // A check this version doesn't know (a newer hub's rule, a row about one) still shows, so it can be taken back.
  const at = (check: string, name: string) => {
    let c = checks.get(check);
    if (!c) {
      c = {
        check,
        name: name.slice(0, 80) || check,
        nature: 'problem',
        on: true,
        perItem: true,
        exceptions: [],
      };
      checks.set(check, c);
    }
    return c;
  };
  for (const off of offs) {
    const known = hostAlertCheck(off.rule);
    const c = at(known.check, known.name);
    if (!off.entity) {
      c.on = false;
      // A rule that starts off is off in the hosts service because Whombat switched it off: nobody to name.
      if (known.startsOn || turnedOn.has(known.check)) c.off = { ...hubByOf(off.by), at: off.at };
      continue;
    }
    const id = hostNoticeSubjectId(known, off.entity) ?? off.entity.slice(0, 160);
    c.exceptions.push({
      subject: { id, name: hostEntityName(off.entity) || id.slice(0, 80) },
      state: 'stopped',
      words: 'always',
      ...hubByOf(off.by),
      at: off.at,
    });
  }
  for (const a of acked) {
    const line = alertLine(a);
    const q = alertQuiet(a, { now, names, untilWords: (d) => untilWords(d, now, w.timeZone) });
    if (!q) continue;
    at(line.check, line.title).exceptions.push({
      ...(line.subject ? { subject: line.subject } : {}),
      state: q.state,
      words: q.words,
      ...(q.until ? { until: q.until } : {}),
      ...hubByOf(a.acknowledged?.by),
      at: q.at,
    });
  }
  addQuietExceptions(quiet, { at, by, now, timeZone: w.timeZone });
  return watchList(checks);
}

/**
 * `things.setWatch` for `server:<id>` (QN-13, QN-15, QN-23): an alert rule is switched off or on in the hosts service,
 * for the server or one item (its open alert resolves there), and the change signed when something changed; a hint
 * kind's goes through the quiet store's command. What Whombat watches on it after.
 */
export async function setServerWatch(
  services: Services,
  ctx: {
    burrowId: string;
    actorId: string;
    serverId: string;
    check: string;
    subject?: NoticeSubject;
    watched: boolean;
    /** The assistant switched it because the person said so (on-purpose.md). */
    agentId?: string;
  },
): Promise<ThingWatch> {
  const w = await who(services, ctx.burrowId, ctx.actorId);
  const agent = ctx.agentId
    ? {
        agentId: ctx.agentId,
        undo: {
          thing: serverThingId(ctx.serverId),
          check: ctx.check,
          ...(ctx.subject ? { subject: ctx.subject } : {}),
          watched: !ctx.watched,
        },
      }
    : undefined;
  const c = checkOf(ctx.check);
  if (!c) throw notFound('Check');
  if (ctx.subject && !c.perItem)
    throw badRequest('This is about the whole server: stop watching it as a whole.');
  if (c.rule) {
    const rule = c.rule;
    const entity = ctx.subject?.id;
    w.hosts.forget(`watch:${ctx.serverId}`);
    const before = await hubOffs(w, ctx.serverId);
    const wasOff = before.some((o) => o.rule === rule && (o.entity ?? '') === (entity ?? ''));
    try {
      await onHub('setWatch', () =>
        w.hosts.setWatch(
          ctx.serverId,
          { rule, ...(entity ? { entity } : {}), off: !ctx.watched },
          actorOf(w.person, 'operator'),
        ),
      );
    } catch (err) {
      const code =
        err instanceof ApiError ? (err.extra.details as { code?: string } | undefined)?.code : null;
      if (code === 'too_many') throw conflict('Whombat already leaves out as much as it can on this server.');
      throw err;
    }
    if (!c.startsOn && !ctx.subject) {
      // A rule that starts off: Whombat keeps that someone turned it on, so the pass leaves it on (and signs it).
      await commitWatch(services, w, ctx.serverId, c, ctx.watched, undefined, ctx.agentId);
    } else if (wasOff === ctx.watched)
      await sign(services, w, {
        serverId: ctx.serverId,
        kind: ctx.watched ? 'watch.on' : 'watch.off',
        title: watchTitle(ctx.watched, ctx.subject?.name ?? c.name, !ctx.subject),
        check: c.check,
        ...(entity ? { subject: entity } : {}),
        ...(agent ? { agent } : {}),
      });
  } else await commitWatch(services, w, ctx.serverId, c, ctx.watched, ctx.subject, ctx.agentId);
  return watchOf(services, w, ctx.serverId);
}

/** The quiet store's side of a server's switch: a hint kind's off or on, or who turned on a rule that starts off. */
async function commitWatch(
  services: Services,
  w: Who,
  serverId: string,
  c: HostWatchCheck,
  watched: boolean,
  subject?: NoticeSubject,
  agentId?: string,
): Promise<void> {
  const result = await services.pipeline.commit(
    setWatch,
    {
      thing: thingOf(w, serverId),
      check: c.check,
      checkName: c.name.slice(0, 80),
      ...(subject ? { subject } : {}),
      watched,
      startsOn: c.startsOn,
      ...(agentId ? { agentId } : {}),
    },
    { burrowId: w.burrowId, actorId: w.person.id },
  );
  if (result.status !== 'ok') throw notAllowed('This can’t be changed now.');
  w.hosts.forget('fleet');
  w.hosts.touched(serverId);
}

/* The pass --------------------------------------------------------------------------------------------------------- */

/**
 * Hint rows that end by themselves (QN-11, QN-12, QN-S56), every 5 minutes: a snooze past its time, an Ignore whose
 * line got worse or newer, or one until it is fixed whose line two passes in a row didn't see while its server was
 * online (the hosts service drops every hint of an offline server). Rows of servers the hosts service no longer has
 * go. Not recorded (QN-17); those who see servers hear that Home changed. The number of rows that ended.
 */
export async function quietServerPass(services: Services): Promise<number> {
  const hosts = hostsFor(services);
  if (!hosts.present) return 0;
  const burrow = await hosts.homeBurrow();
  if (!burrow) return 0;
  const now = services.clock();
  const [fleet, agents, book] = await Promise.all([
    hosts.fleetRaw(),
    hosts.agentsRaw().catch(() => [] as unknown[]),
    quietBook(services.db, [burrow.id]),
  ]);
  const cards = new Map(arr(fleet.servers).map((c) => [String(obj(c).id), obj(c)] as const));
  const hints = fleetHints(arr(fleet.hints).map(toHostHint), agents);
  const things = await serverThings(services, burrow.id);
  let ended = 0;
  for (const thing of things) {
    const serverId = thing.slice('server:'.length);
    const card = cards.get(serverId);
    if (!card) {
      await services.pipeline.transact(burrow.id, (session) => forgetServer(session.tx, burrow.id, thing));
      continue;
    }
    const quiet = book.of(thing);
    const rows = quiet.quiets.filter((q) => q.checkId.startsWith('host.hint.'));
    if (!rows.length) continue;
    const lines = hints.filter((h) => h.serverId === serverId).map((h) => hintLine(h, hintGuests(h)));
    const r = applyQuiet({
      lines,
      quiets: rows,
      ...notWatched(quiet),
      states: [],
      now,
      pass: true,
      ...(card.status === 'offline' ? { skipped: ['*'] } : {}),
    });
    if (!r.lift.length && !r.cleared.length) continue;
    ended += r.lift.length;
    await services.pipeline.transact(burrow.id, async (session) => {
      await writePass(session.tx, burrow.id, thing, {
        lift: r.lift,
        cleared: r.cleared,
        states: [],
        gone: [],
      });
      if (r.lift.length)
        publishHomeChanged(session, await homeAudience(session, burrow.id), ['things', 'watch']);
    });
  }
  if (ended) hosts.forget('fleet');
  await startOffRules(services, hosts, burrow.id, [...cards.keys()], book);
  return ended;
}

/** The alert rules that start off (watch-defaults.md). */
const RULES_OFF = SERVER_CHECKS.filter((c) => c.rule && !c.startsOn);

/**
 * Switches the alert rules that start off off in the hosts service, as Whombat, on every server where nobody turned them
 * on here (watch-defaults.md): what the hosts service doesn't raise shows nowhere (the dot, the page, Watch, the desk,
 * the assistant's reads), and its open alert resolves. A server added later gets them at the next pass; a rule already
 * off stays as it is. A server the hosts service refuses this for (still being added) is tried again next time.
 */
async function startOffRules(
  services: Services,
  hosts: HostsService,
  burrowId: string,
  serverIds: readonly string[],
  book: QuietBook,
): Promise<void> {
  for (const serverId of serverIds) {
    const thing = serverThingId(serverId);
    const due = RULES_OFF.filter((c) => !book.of(thing).ons.some((o) => o.checkId === c.check));
    if (!due.length) continue;
    try {
      const offs = await hosts.watchRaw(serverId);
      const missing = due.filter((c) => !offs.some((o) => o.rule === c.rule && !o.entity));
      if (!missing.length) continue;
      // Someone may have turned one on since the pass read its rows.
      const fresh = await thingQuiet(services.db, burrowId, thing);
      for (const c of missing)
        if (c.rule && !fresh.ons.some((o) => o.checkId === c.check))
          await hosts.setWatch(serverId, { rule: c.rule, off: true }, WHOMBAT_ACTOR);
    } catch (err) {
      services.log.debug({ err: String(err), serverId }, 'hosts: rules that start off not switched off yet');
    }
  }
}

/** What is kept about a server the hosts service no longer has. */
async function forgetServer(tx: Tx, burrowId: string, thing: string): Promise<void> {
  await tx
    .delete(noticeQuiets)
    .where(and(eq(noticeQuiets.ownerId, burrowId), eq(noticeQuiets.thingId, thing)));
  await tx.delete(watchOffs).where(and(eq(watchOffs.ownerId, burrowId), eq(watchOffs.thingId, thing)));
  await tx.delete(watchOns).where(and(eq(watchOns.ownerId, burrowId), eq(watchOns.thingId, thing)));
  await tx.delete(noticeStates).where(eq(noticeStates.thingId, thing));
}

/** The server things the burrow keeps quiet rows, offs or ons of. */
async function serverThings(services: Services, burrowId: string): Promise<string[]> {
  const [q, o, n] = await Promise.all([
    services.db
      .selectDistinct({ thing: noticeQuiets.thingId })
      .from(noticeQuiets)
      .where(and(eq(noticeQuiets.ownerId, burrowId), like(noticeQuiets.thingId, 'server:%'))),
    services.db
      .selectDistinct({ thing: watchOffs.thingId })
      .from(watchOffs)
      .where(and(eq(watchOffs.ownerId, burrowId), like(watchOffs.thingId, 'server:%'))),
    services.db
      .selectDistinct({ thing: watchOns.thingId })
      .from(watchOns)
      .where(and(eq(watchOns.ownerId, burrowId), like(watchOns.thingId, 'server:%'))),
  ]);
  return [...new Set([...q, ...o, ...n].map((r) => r.thing))];
}
