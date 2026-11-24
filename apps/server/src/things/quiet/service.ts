/**
 * `things.quiet`, `things.watch`, `things.setWatch` for connections, devices and the person's accounts (quiet-notices.md
 * QN-10…QN-17; QN-S09, QN-S10, QN-S16): the thing as the person may see it, the line as it is now (a page read, its
 * kind's reads kept 30 s), who may quiet it (who may manage the thing; a mail account its person), then one command in
 * the commit pipeline. Servers go to the servers' part (`hosts/quiet.ts`). The desk's Ignore and Not now and Needs you's
 * shared Ignore come here too, as the person.
 */
import { catalogEntry, parseThingId } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { type ConnectionViewer, isVisibleTo } from '../../connections/store';
import { noticeQuiets } from '../../db/schema/index';
import { DEVICE_CHECKS, deviceLines } from '../../devices/home';
import { addQuietExceptions, watchList } from '../../domain/quiet-watch';
import { accountName } from '../../home/mail-glance';
import { quietServerNotice, serverWatch, setServerWatch } from '../../hosts/quiet';
import { notAllowed, notFound } from '../../lib/errors';
import type { Services } from '../../services';
import { type AccountTarget, accountChecks, accountLines } from '../accounts/index';
import { kindFor } from '../kinds/index';
import { connectionPage, findThing } from '../page';
import { genericChecksFor } from '../panels';
import { displayName } from '../part-of';
import { type QuietThing, quietNotice, setWatch } from './commands';
import { checkStartsOn } from './defaults';
import { type ThingQuiet, thingQuiet } from './store';
import type { KindCheck, LooseNotice } from './types';
import { endThingQuiet } from './window-service';
import { activeWindow } from './windows';
import {
  type QuietAnswer,
  type QuietRequest,
  quietNames,
  quietOf,
  type WatchRequest,
  type WireWatch,
  type WireWatchCheck,
} from './wire';
import { snoozeUntil } from './words';

/** A thing someone wants to quiet a line of, with what it watches and how to read its lines now. */
interface QuietTarget {
  thing: QuietThing;
  checks: readonly KindCheck[];
  lines: () => Promise<LooseNotice[]>;
}

/** Servers are the person's (QN-10; one-person.md OP-S07): the viewer is the person, not the agent. */
function viewerIsPerson(viewer: ConnectionViewer): boolean {
  return viewer.principal.kind === 'person';
}

/** One of the person's accounts (Google, Microsoft 365, Email, GitHub, Website feedback) as a thing to quiet. */
function accountTarget(services: Services, viewer: ConnectionViewer, target: AccountTarget): QuietTarget {
  const name =
    target.kind === 'mail'
      ? accountName(target.row.provider)
      : target.kind === 'github'
        ? 'GitHub'
        : 'Website feedback';
  return {
    thing: {
      id: target.id,
      kind: 'connection',
      ref: target.id.slice(target.id.indexOf(':') + 1),
      name,
      owner: viewer.burrowId,
    },
    checks: accountChecks(target),
    lines: async () => accountLines(services, target),
  };
}

/** The thing behind a thingId for this person, or `not_found`; servers are the servers' part's. */
export async function quietTarget(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
  timeZone: string,
): Promise<QuietTarget> {
  const target = await findThing(services, viewer, value);
  if (target.kind === 'learning') throw notFound('Thing');
  if (target.kind === 'account') return accountTarget(services, viewer, target.account);
  const row = target.row;
  if (!isVisibleTo(row, viewer)) throw notFound('Thing');
  if (target.kind === 'device')
    return {
      thing: {
        id: target.id,
        kind: 'device',
        ref: row.id,
        name: target.skill.name.slice(0, 120),
        owner: viewer.burrowId,
      },
      checks: DEVICE_CHECKS,
      lines: async () => deviceLines(target.skill),
    };
  const entry = catalogEntry(row.catalogId);
  return {
    thing: {
      id: target.id,
      kind: 'connection',
      ref: row.id,
      name: displayName(row).slice(0, 120),
      owner: row.burrowId,
    },
    checks: [...(kindFor(row)?.checks ?? []), ...(entry ? genericChecksFor(row.catalogId) : [])],
    lines: async () => {
      let lines: readonly LooseNotice[] = [];
      await connectionPage(services, viewer, row, timeZone, undefined, (made) => {
        lines = made;
      });
      return [...lines];
    },
  };
}

/** `things.quiet` (QN-10…QN-12): Ignore, Remind me tomorrow, or Undo of either, on one line of a thing. */
export async function quietThingNotice(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
  body: QuietRequest,
  timeZone: string,
): Promise<QuietAnswer> {
  const parsed = parseThingId(value);
  if (parsed?.kind === 'server') {
    // A server's lines are the person's to quiet (QN-10, QN-23); the servers' part does the rest.
    if (!viewerIsPerson(viewer)) throw notAllowed('Only you can quiet what Whombat watches on a server.');
    const notice = {
      check: body.notice.check,
      ...(body.notice.subject ? { subject: body.notice.subject } : {}),
    };
    const quiet = await quietServerNotice(services, {
      burrowId: viewer.burrowId,
      actorId: viewer.principal.id,
      serverId: parsed.id,
      notice,
      how: body.how,
      ...(body.until ? { until: body.until } : {}),
    });
    return { notice, quiet };
  }
  if (viewer.principal.kind !== 'person') throw notAllowed('Only you can quiet what Whombat watches.');
  const target = await quietTarget(services, viewer, value, timeZone);
  const notice = {
    check: body.notice.check,
    ...(body.notice.subject ? { subject: body.notice.subject } : {}),
  };
  const subject = body.notice.subject ?? '';
  let input: Parameters<(typeof quietNotice)['apply']>[2];
  if (body.how === 'undo') {
    const [row] = await services.db
      .select({ title: noticeQuiets.title, subjectName: noticeQuiets.subjectName })
      .from(noticeQuiets)
      .where(
        and(
          eq(noticeQuiets.ownerId, target.thing.owner),
          eq(noticeQuiets.thingId, target.thing.id),
          eq(noticeQuiets.checkId, notice.check),
          eq(noticeQuiets.subject, subject),
        ),
      );
    if (!row) {
      // A line quiet with the whole thing kept quiet: Undo there (an app that has no End now) ends the window.
      if (
        activeWindow(
          (await thingQuiet(services.db, target.thing.owner, target.thing.id)).windows,
          services.clock(),
        )
      ) {
        await endThingQuiet(services, viewer, value, timeZone);
        return { notice, quiet: null };
      }
      throw notFound('Quiet');
    }
    input = {
      thing: target.thing,
      line: {
        check: notice.check,
        ...(subject ? { subject: { id: subject, name: (row.subjectName ?? subject).slice(0, 80) } } : {}),
      },
      how: 'undo',
      timeZone,
    };
  } else {
    const line = (await target.lines()).find(
      (l) => l.check === notice.check && (l.subject?.id ?? '') === subject && l.ignore,
    );
    if (!line?.check || !line.ignore) throw notFound('Notice');
    const now = services.clock();
    const until =
      body.how === 'snooze' ? (body.until ?? snoozeUntil(now, timeZone).toISOString()) : undefined;
    input = {
      thing: target.thing,
      line: {
        check: line.check,
        ...(line.subject ? { subject: line.subject } : {}),
        title: line.title,
        tone: line.tone,
        ...(line.band != null ? { band: line.band } : {}),
        ...(line.episode ? { episode: line.episode.slice(0, 200) } : {}),
        lifts: line.ignore.lifts,
        words: line.ignore.words,
        ...(line.ignore.until ? { until: line.ignore.until } : {}),
      },
      how: body.how,
      ...(until ? { until } : {}),
      timeZone,
    };
  }
  const result = await services.pipeline.commit(quietNotice, input, {
    burrowId: viewer.burrowId,
    actorId: viewer.principal.id,
  });
  if (result.status !== 'ok') throw notAllowed('This can’t be quieted now.');
  const row = result.result.row;
  if (!row) return { notice, quiet: null };
  const names = await quietNames(services.db, [row]);
  return { notice, quiet: quietOf(row, names, services.clock(), timeZone) };
}

/** What Whombat watches on a thing (QN-15): one switch per check, and what is excepted under it. */
async function watchOf(
  services: Services,
  target: QuietTarget,
  quiet: ThingQuiet,
  timeZone: string,
): Promise<WireWatch> {
  const now = services.clock();
  const names = await quietNames(services.db, [...quiet.quiets, ...quiet.offs]);
  const by = (id: string | null) => {
    const name = id ? names.get(id) : undefined;
    return id && name ? { by: { id, name } } : {};
  };
  const checks = new Map<string, WireWatchCheck>();
  const turnedOn = new Set(quiet.ons.map((o) => o.checkId));
  for (const c of target.checks)
    if (!checks.has(c.check))
      checks.set(c.check, {
        check: c.check,
        name: c.name.slice(0, 80),
        nature: c.nature,
        // A check that starts off is on once someone turned it on (watch-defaults.md).
        on: c.startsOn || turnedOn.has(c.check),
        perItem: c.perItem,
        exceptions: [],
      });
  // A check a row names that the thing no longer lists still shows, so it can be taken back.
  const at = (check: string, title: string) => {
    let c = checks.get(check);
    if (!c) {
      c = {
        check,
        name: title.slice(0, 80),
        nature: 'problem',
        on: true,
        perItem: true,
        exceptions: [],
      };
      checks.set(check, c);
    }
    return c;
  };
  addQuietExceptions(quiet, { at, by, now, timeZone });
  return watchList(checks);
}

/** `things.watch`: What Whombat watches on a thing. */
export async function thingWatch(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
  timeZone: string,
): Promise<WireWatch> {
  const parsed = parseThingId(value);
  if (parsed?.kind === 'server') {
    const watch = await serverWatch(services, {
      burrowId: viewer.burrowId,
      actorId: viewer.principal.id,
      serverId: parsed.id,
    });
    return { ...watch, mayChange: watch.mayChange && viewerIsPerson(viewer) };
  }
  const target = await quietTarget(services, viewer, value, timeZone);
  return watchOf(
    services,
    target,
    await thingQuiet(services.db, target.thing.owner, target.thing.id),
    timeZone,
  );
}

/**
 * `things.setWatch` (QN-13, QN-15): Stop watching a check (or one item of it), or watch it again. `agentId`: the
 * assistant switched it because the person said so (`watch_checks`, on-purpose.md); the viewer is that person.
 */
export async function setThingWatch(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
  body: WatchRequest,
  timeZone: string,
  opts: { agentId?: string } = {},
): Promise<WireWatch> {
  const parsed = parseThingId(value);
  if (parsed?.kind === 'server') {
    if (!viewerIsPerson(viewer)) throw notAllowed('Only you can choose what Whombat watches on a server.');
    return setServerWatch(services, {
      burrowId: viewer.burrowId,
      actorId: viewer.principal.id,
      serverId: parsed.id,
      check: body.check,
      ...(body.subject ? { subject: body.subject } : {}),
      watched: body.watched,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    });
  }
  if (viewer.principal.kind !== 'person') throw notAllowed('Only you can choose what Whombat watches.');
  const target = await quietTarget(services, viewer, value, timeZone);
  const quiet = await thingQuiet(services.db, target.thing.owner, target.thing.id);
  const known = target.checks.find((c) => c.check === body.check);
  const named =
    quiet.offs.find((o) => o.checkId === body.check) ??
    quiet.ons.find((o) => o.checkId === body.check) ??
    quiet.quiets.find((q) => q.checkId === body.check);
  if (!known && !named) throw notFound('Check');
  const result = await services.pipeline.commit(
    setWatch,
    {
      thing: target.thing,
      check: body.check,
      checkName: (known?.name ?? body.check).slice(0, 80),
      ...(body.subject ? { subject: body.subject } : {}),
      watched: body.watched,
      startsOn: known ? known.startsOn : checkStartsOn(body.check),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    },
    { burrowId: viewer.burrowId, actorId: viewer.principal.id },
  );
  if (result.status !== 'ok') throw notAllowed('This can’t be changed now.');
  return watchOf(
    services,
    target,
    await thingQuiet(services.db, target.thing.owner, target.thing.id),
    timeZone,
  );
}
