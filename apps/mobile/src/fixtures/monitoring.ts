/**
 * The demo world's monitoring (Whombat monitoring.md MON-04, MON-07, MON-09, MON-15): a thing kept quiet for a while
 * (`things.keepQuiet`, `things.endQuiet`: UniFi until 23:00 while its access points move, the-falcon while its backup
 * disk moves), a connection down because of something else (Seerr while its machine `media` is stopped), the
 * week's line and “What happened” (`things.history`) for every thing, and a server check's limit
 * (`things.setWatchLimit`, Undo through `changes.undo`). It changes the pages, Home's things and a server's page the way
 * the server does: the page carries `keptQuiet` or `causedBy`, its Worth a look starts with the hold's heads-up for an
 * older app, its watched lines are held (End now, not Undo), and Home's thing has `quietUntil` or `causedBy`. Pure
 * TypeScript over plain objects; every answer parses with its endpoint's schema (`monitoring.test.ts`).
 */
import {
  HOST_WATCH_LIMITS,
  type HostServerDetail,
  type KeepQuietBody,
  type KeptQuiet,
  type NoticeQuiet,
  type ThingCause,
  type ThingHistory,
  type ThingIncident,
  type ThingPage,
  type ThingPagePanel,
  type ThingSummary,
  type ThingUptime,
  type ThingWatch,
  zonedInstant,
} from '@whombat/core';
import type { SetThingWatchLimitBody } from '@whombat/core/contracts';
import { zonedParts } from '@whombat/core/text';
import { mara } from '@whombat/fixtures';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The things the demo world keeps quiet when it starts, and why. */
export const MONITORING_THINGS = {
  unifi: 'connection:con_unifi',
  seerr: 'connection:con_seerr',
  falcon: 'server:the-falcon',
  pve02: 'server:pve-02',
} as const;

/** Seerr runs on this machine of pve-02, stopped: it doesn't answer while it is (MON-07). */
export const CAUSE_MACHINE = { serverId: 'pve-02', guestId: 'pve:126', name: 'media' } as const;

interface Window {
  id: string;
  since: number;
  until: number;
  note?: string;
  byName: string;
}

interface Answer {
  status: number;
  body: unknown;
}

const refusal = (status: number, code: string, message: string): Answer => ({
  status,
  body: { error: { code, message } },
});

export interface MonitoringFixtureOptions {
  now: () => Date;
  timeZone: string;
}

export function createMonitoringFixtures({ now, timeZone }: MonitoringFixtureOptions) {
  const at = (ms: number) => new Date(ms).toISOString();
  /** Today at `hh:mm` in the Whombat's zone, `days` from today. */
  const local = (hhmm: string, days = 0): number => {
    const p = zonedParts(now().getTime() + days * DAY, timeZone);
    return zonedInstant({ year: p.year, month: p.month, day: p.day }, hhmm, timeZone).getTime();
  };
  const two = (n: number) => String(n).padStart(2, '0');
  /** “until 23:00”, “until tomorrow 09:00”, “until Fri 09:00”: as the server says a window's end. */
  const untilWords = (until: number): string => {
    const a = zonedParts(until, timeZone);
    const b = zonedParts(now().getTime(), timeZone);
    const days = Math.round(
      (Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / DAY,
    );
    const hm = `${two(a.hour)}:${two(a.minute)}`;
    if (days <= 0) return `until ${hm}`;
    if (days === 1) return `until tomorrow ${hm}`;
    const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(new Date(until));
    return `until ${day} ${hm}`;
  };

  let seq = 0;
  const windows = new Map<string, Window>();
  const start = now().getTime();
  windows.set(MONITORING_THINGS.unifi, {
    id: 'qw_unifi',
    since: start - 25 * MINUTE,
    until: local('23:00'),
    note: 'Moving the access points',
    byName: mara.name.split(' ')[0] ?? mara.name,
  });
  windows.set(MONITORING_THINGS.falcon, {
    id: 'qw_falcon',
    since: start - 40 * MINUTE,
    until: local('23:00'),
    note: 'Moving the backup disk',
    byName: mara.name.split(' ')[0] ?? mara.name,
  });

  /** The window that holds now, if any (an ended one is forgotten). */
  function windowOf(thing: string): Window | null {
    const w = windows.get(thing);
    if (!w) return null;
    if (w.until <= now().getTime()) {
      windows.delete(thing);
      return null;
    }
    return w;
  }

  function keptOf(w: Window): KeptQuiet {
    const head = `Quiet ${untilWords(w.until)}`;
    return {
      id: w.id,
      words: w.note ? `${head} · ${w.note}` : head,
      since: at(w.since),
      until: at(w.until),
      ...(w.note ? { note: w.note } : {}),
      by: { id: mara.id, name: w.byName },
      canEnd: true,
    };
  }

  /** What a thing is down because of, when anything. */
  function causeOf(thing: string): ThingCause | null {
    if (thing !== MONITORING_THINGS.seerr) return null;
    const { serverId, guestId, name } = CAUSE_MACHINE;
    return {
      thing: `server:${serverId}/guest/${encodeURIComponent(guestId)}`,
      name,
      words: `Not answering while ${name} is stopped`,
      href: `/things/server%3A${serverId}?guest=${encodeURIComponent(guestId)}`,
    };
  }

  /** A line held by the window (a snooze until its end) or by the cause (an ignore while it lasts). */
  function heldQuiet(w: Window | null, cause: ThingCause | null): NoticeQuiet | null {
    if (w)
      return {
        state: 'snoozed',
        words: untilWords(w.until),
        until: at(w.until),
        by: { id: mara.id, name: w.byName },
        at: at(w.since),
        held: 'window',
      };
    if (cause)
      return {
        state: 'ignored',
        words: cause.words.replace(/^Not answering /, ''),
        at: at(start - 18 * MINUTE),
        held: 'cause',
      };
    return null;
  }

  /* The week in one line, and what happened ------------------------------------------------------------------- */

  /** Each thing's incidents, newest first: [nature, words, days ago at hh:mm, minutes]. */
  const INCIDENTS: Record<string, [ThingIncident['nature'], string, number, string, number][]> = {
    'server:pve-02': [
      ['problem', 'Running hot', 1, '15:40', 125],
      ['down', 'Not answering', 4, '03:12', 12],
    ],
    'connection:con_unifi': [['problem', 'An access point is offline', 3, '21:04', 41]],
    'connection:con_ha': [
      ['down', 'Not answering', 2, '06:31', 9],
      ['down', 'Not answering', 9, '22:15', 5],
    ],
    'connection:con_seerr': [['down', 'Not answering', 0, '13:47', 18]],
  };

  /** A server's own alerts in the period: [title, severity, rule, days ago at hh:mm, minutes]. */
  const ALERTS: Record<string, [string, 'critical' | 'warning', string, number, string, number][]> = {
    'server:pve-02': [
      ['CPU above 85 °C', 'warning', 'sensor.temp_high', 1, '15:42', 118],
      ['pve-02 isn’t checking in', 'critical', 'agent.heartbeat_missing', 4, '03:13', 11],
      ['Disk sdb has errors', 'warning', 'disk.smart_errors', 12, '10:05', 1440],
    ],
  };

  function incidentsOf(thing: string, from: number): ThingIncident[] {
    return (INCIDENTS[thing] ?? []).flatMap(([nature, words, days, hhmm, minutes], i) => {
      const started = local(hhmm, -days);
      if (started < from) return [];
      // Seerr's is still going: its machine is stopped now.
      const open = thing === MONITORING_THINGS.seerr;
      const lasted = open ? Math.max(1, Math.round((now().getTime() - started) / MINUTE)) : minutes;
      const cause = causeOf(thing);
      return [
        {
          id: `inc_${thing.replace(/[^a-z0-9]/gi, '')}_${i}`,
          nature,
          words,
          startedAt: at(started),
          endedAt: open ? null : at(started + minutes * MINUTE),
          minutes: lasted,
          ...(open && cause ? { cause: { thing: cause.thing, name: cause.name } } : {}),
        },
      ];
    });
  }

  /** The week's line (MON-49): “Up 99.6 % this week · down once, 12 min”, “Up all week”. */
  function uptimeOf(thing: string, days = 7): ThingUptime {
    const from = now().getTime() - days * DAY;
    const downs = incidentsOf(thing, from).filter((i) => i.nature === 'down');
    const minutes = downs.reduce((n, i) => n + i.minutes, 0);
    const period = days === 7 ? 'this week' : `in the last ${days} days`;
    const upPct = Math.max(0, 100 - (minutes / (days * 24 * 60)) * 100);
    const shown = upPct >= 95 ? (Math.floor(upPct * 10) / 10).toFixed(1) : String(Math.floor(upPct));
    const times = downs.length === 1 ? 'once' : downs.length === 2 ? 'twice' : `${downs.length} times`;
    return {
      text: downs.length
        ? `Up ${shown} % ${period} · down ${times}, ${minutes} min`
        : days === 7
          ? 'Up all week'
          : `Up all ${days} days`,
      upPct: Math.round(upPct * 10) / 10,
      downs: downs.length,
      downMinutes: minutes,
      from: at(from),
    };
  }

  /** `things.history?days=` (MON-51). */
  function history(thing: string, days: number): ThingHistory {
    const from = now().getTime() - days * DAY;
    const alerts = thing.startsWith('server:')
      ? (ALERTS[thing] ?? []).flatMap(([title, severity, rule, ago, hhmm, minutes]) => {
          const openedAt = local(hhmm, -ago);
          return openedAt < from
            ? []
            : [
                {
                  title,
                  severity,
                  rule,
                  openedAt: at(openedAt),
                  resolvedAt: at(openedAt + minutes * MINUTE),
                },
              ];
        })
      : undefined;
    return {
      thing,
      days,
      from: at(from),
      uptime: uptimeOf(thing, days),
      incidents: incidentsOf(thing, from),
      ...(alerts ? { alerts } : {}),
    };
  }

  /* Pages ------------------------------------------------------------------------------------------------------ */

  /** Worth a look with every watched line held, and the hold's heads-up first (for an app that doesn't draw it). */
  function heldNotices(
    panel: Extract<ThingPagePanel, { kind: 'notices' }>,
    quiet: NoticeQuiet,
    hold: { id: string; title: string; icon: 'clock' | 'power'; href?: string; name?: string },
  ): Extract<ThingPagePanel, { kind: 'notices' }> {
    const items = panel.items
      .filter((n) => n.id !== 'quiet-window' && n.id !== 'quiet-cause')
      .map((n) => (n.check && !n.quiet ? { ...n, quiet } : n));
    return {
      ...panel,
      items: [
        {
          id: hold.id,
          tone: 'info',
          icon: hold.icon,
          title: hold.title.slice(0, 120),
          nature: 'fyi',
          ...(hold.href && hold.name
            ? { link: { kind: 'href' as const, label: `See ${hold.name}`.slice(0, 30), href: hold.href } }
            : {}),
        },
        ...items,
      ],
    };
  }

  function mapPanels(page: ThingPage, fn: (p: ThingPagePanel) => ThingPagePanel): ThingPage {
    return { ...page, tabs: page.tabs.map((t) => ({ ...t, panels: t.panels.map(fn) })) };
  }

  /** A connection's or device's page as the server gives it now: its week, its window or its cause. */
  function withPage(page: ThingPage): ThingPage {
    const uptime = uptimeOf(page.id);
    // The week's words are also one of its facts, after the first, for an app that doesn't draw `uptime`.
    const facts = [...page.facts.slice(0, 1), [{ text: uptime.text }], ...page.facts.slice(1)];
    let out: ThingPage = { ...page, uptime, facts };
    const w = windowOf(page.id);
    const cause = w ? null : causeOf(page.id);
    const quiet = heldQuiet(w, cause);
    if (w && quiet) {
      const kept = keptOf(w);
      out = mapPanels(out, (p) =>
        p.kind === 'notices'
          ? heldNotices(p, quiet, { id: 'quiet-window', title: kept.words, icon: 'clock' })
          : p,
      );
      return { ...out, keptQuiet: kept, status: 'ok', badge: kept.words.split(' · ')[0] as string };
    }
    if (cause && quiet) {
      out = mapPanels(out, (p) =>
        p.kind === 'notices'
          ? heldNotices(p, quiet, {
              id: 'quiet-cause',
              title: cause.words,
              icon: 'power',
              ...(cause.href ? { href: cause.href } : {}),
              name: cause.name,
            })
          : p,
      );
      return {
        ...out,
        causedBy: cause,
        status: 'unknown',
        badge: cause.words.slice(0, 60),
        runsOn: {
          serverId: CAUSE_MACHINE.serverId,
          guestId: CAUSE_MACHINE.guestId,
          name: `${CAUSE_MACHINE.name} (${CAUSE_MACHINE.serverId})`,
          href: cause.href ?? '/things/server%3Apve-02',
          how: 'address',
        },
      };
    }
    return out;
  }

  /** Home's thing: kept quiet until its end, or grey with its cause's words. */
  function withThing(t: ThingSummary): ThingSummary {
    const w = windowOf(t.id);
    if (w) return { ...t, quietUntil: at(w.until), ...(t.kind === 'server' ? {} : { status: 'ok' }) };
    const cause = causeOf(t.id);
    if (cause) {
      const { reason: _reason, ...rest } = t;
      return { ...rest, status: 'unknown', line: cause.words, causedBy: cause };
    }
    return t;
  }

  /** A server's page: its week, and its window with its alerts held and no banner. */
  function withServer(d: HostServerDetail): HostServerDetail {
    const thing = `server:${d.server.id}`;
    const out: HostServerDetail = { ...d, uptime: uptimeOf(thing) };
    const w = windowOf(thing);
    if (!w) return out;
    const quiet = heldQuiet(w, null) as NoticeQuiet;
    return {
      ...out,
      keptQuiet: keptOf(w),
      banner: null,
      alerts: d.alerts?.map((a) => (a.state === 'open' ? { ...a, quiet, attention: false } : a)),
      hints: d.hints.map((h) => ({ ...h, quiet })),
    };
  }

  /* Keep quiet ------------------------------------------------------------------------------------------------- */

  function keepQuiet(thing: string, body: KeepQuietBody): Answer {
    const t = now().getTime();
    const until = body.until ? Date.parse(body.until) : t + (body.minutes ?? 60) * MINUTE;
    if (!Number.isFinite(until) || until - t < 5 * MINUTE)
      return refusal(400, 'validation_failed', 'Pick a time that is still ahead.');
    if (until - t > 31 * DAY) return refusal(400, 'validation_failed', 'Pick a time within a month.');
    const was = windowOf(thing);
    const w: Window = {
      id: was?.id ?? `qw_demo_${++seq}`,
      since: was?.since ?? t,
      until,
      ...(body.note ? { note: body.note } : {}),
      byName: mara.name.split(' ')[0] ?? mara.name,
    };
    windows.set(thing, w);
    return { status: 200, body: { keptQuiet: keptOf(w) } };
  }

  function endQuiet(thing: string): Answer {
    if (!windowOf(thing)) return refusal(404, 'not_found', 'It isn’t kept quiet.');
    windows.delete(thing);
    return { status: 200, body: { keptQuiet: null } };
  }

  /* Limits ----------------------------------------------------------------------------------------------------- */

  /** `server|rule` → its own limit; `server|rule|subject` → an item's. */
  const limits = new Map<string, number>([['pve-02|disk.space_high|fs:/mnt/backup', 95]]);
  /** What each change replaced, for Undo: its key and the limit before (null: none of its own). */
  const limitChanges = new Map<
    string,
    { key: string; before: number | null; title: string; thing: string }
  >();
  const SUBJECT_NAMES: Record<string, string> = { 'fs:/mnt/backup': '/mnt/backup' };

  /** What Whombat watches on a server, with the limits of the checks that have one (MON-15). */
  function withLimits(thing: string, watch: ThingWatch): ThingWatch {
    if (!thing.startsWith('server:')) return watch;
    const server = thing.slice('server:'.length);
    return {
      ...watch,
      checks: watch.checks.map((c) => {
        const rule = c.check.replace(/^host\./, '');
        const range = Object.hasOwn(HOST_WATCH_LIMITS, rule)
          ? HOST_WATCH_LIMITS[rule as keyof typeof HOST_WATCH_LIMITS]
          : null;
        if (!range) return c;
        const prefix = `${server}|${rule}|`;
        const items = [...limits.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, value]) => {
            const id = k.slice(prefix.length);
            return { subject: { id, name: SUBJECT_NAMES[id] ?? id }, value };
          });
        return {
          ...c,
          perItem: true,
          limit: {
            unit: range.unit,
            min: range.min,
            max: range.max,
            ...('defaultValue' in range ? { defaultValue: range.defaultValue } : {}),
            value: limits.get(`${server}|${rule}`) ?? null,
            items,
          },
        };
      }),
    };
  }

  function setWatchLimit(
    thing: string,
    body: SetThingWatchLimitBody,
    watchOf: () => ThingWatch | null,
  ): Answer {
    if (!thing.startsWith('server:')) return refusal(404, 'not_found', 'Only a server’s checks have limits.');
    const server = thing.slice('server:'.length);
    const rule = body.check.replace(/^host\./, '');
    const range = Object.hasOwn(HOST_WATCH_LIMITS, rule)
      ? HOST_WATCH_LIMITS[rule as keyof typeof HOST_WATCH_LIMITS]
      : null;
    if (!range) return refusal(400, 'validation_failed', 'This check has no limit to change.');
    if (body.limit !== null && (body.limit < range.min || body.limit > range.max))
      return refusal(
        400,
        'validation_failed',
        `Choose a limit from ${range.min} to ${range.max} ${range.unit}.`,
      );
    const key = `${server}|${rule}${body.subject ? `|${body.subject.id}` : ''}`;
    if (body.subject) SUBJECT_NAMES[body.subject.id] = body.subject.name;
    const before = limits.get(key) ?? null;
    if (body.limit === null) limits.delete(key);
    else limits.set(key, body.limit);
    const changeId = `chg_limit_${++seq}`;
    limitChanges.set(changeId, {
      key,
      before,
      thing,
      title:
        body.limit === null ? 'Used the default limit again' : `Set the limit to ${body.limit} ${range.unit}`,
    });
    const watch = watchOf();
    return { status: 200, body: { watch: watch ? withLimits(thing, watch) : null, changeId } };
  }

  /** Undo of a limit change: the limit before it back. Null for a change this part didn't make. */
  function undo(changeId: string): Answer | null {
    const c = limitChanges.get(changeId);
    if (!c) return null;
    limitChanges.delete(changeId);
    if (c.before === null) limits.delete(c.key);
    else limits.set(c.key, c.before);
    return {
      status: 200,
      body: {
        change: {
          id: changeId,
          title: c.title,
          at: now().toISOString(),
          actor: { kind: 'person', id: mara.id, name: mara.name },
          undo: { state: 'undone' },
          thingId: c.thing,
        },
        state: 'undone',
      },
    };
  }

  return {
    withPage,
    withThing,
    withServer,
    withLimits,
    history,
    keepQuiet,
    endQuiet,
    setWatchLimit,
    undo,
    /** Whether the thing is kept quiet now (for a test). */
    keptQuiet: (thing: string) => {
      const w = windowOf(thing);
      return w ? keptOf(w) : null;
    },
  };
}

export type MonitoringFixtures = ReturnType<typeof createMonitoringFixtures>;
