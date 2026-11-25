/**
 * Monitoring in fixture mode (Whombat; session minor 9):
 * `things.keepQuiet` and `things.endQuiet` for any thing, `things.history`, a server check's limits in What Whombat
 * watches with `things.setWatchLimit` and its Undo, and the pages, servers and Home read through them as the runtime
 * answers — a thing kept quiet has `keptQuiet`, its lines held (End now) and the hold's heads-up line first; a thing down
 * because of something else is grey with `causedBy`. With `monitoring` (`VITE_FIXTURE_MONITORING=1`, or
 * `localStorage['whombat:fixture-monitoring']` for the visual suite) the world starts with the states to look at:
 * blackbox kept quiet until 23:00 while Mara moves the NAS, UniFi kept quiet until tomorrow morning, Home Assistant not
 * answering while its machine is stopped, each page's week in one line and 30 days of what happened. Without it the
 * world starts calm: nothing kept quiet and nothing happened.
 */
import { localAt, untilText } from '@whombat/client';
import {
  HOST_WATCH_CHECKS,
  type HostAlert,
  type HostServerDetail,
  hostWatchLimit,
  type KeepQuietBody,
  type KeptQuiet,
  type NoticeQuiet,
  type SetThingWatchLimitBody,
  type ThingCause,
  type ThingHistory,
  type ThingHistoryAlert,
  type ThingIncident,
  type ThingPage,
  type ThingPageNotice,
  type ThingSummary,
  type ThingTextPart,
  type ThingUptime,
  type ThingWatch,
} from '@whombat/core';
import { burrow, mara } from '@whombat/fixtures';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = 'Europe/Amsterdam';

/** The visual suite's switch for the seeded states (as `whombat:fixture-looks`). */
export const MONITORING_FIXTURE_KEY = 'whombat:fixture-monitoring';

/** Whether the world starts with things kept quiet, a cause and history: `monitoring`, the env, or the visual key. */
export function monitoringSeeded(option: boolean | undefined): boolean {
  if (option !== undefined) return option;
  if (import.meta.env.VITE_FIXTURE_MONITORING === '1') return true;
  return typeof localStorage !== 'undefined' && localStorage.getItem(MONITORING_FIXTURE_KEY) === '1';
}

const HA = 'connection:con_home-assistant';
const UNIFI = 'connection:con_unifi';
const BLACKBOX = 'server:blackbox';
const PVE02 = 'server:pve-02';
const BY = { id: mara.id, name: 'Mara' } as NonNullable<KeptQuiet['by']>;

/** A server check's own limit or one item's: `server|check|subject`. */
type LimitKey = string;

interface Window {
  since: number;
  until: number;
  note?: string;
  by?: KeptQuiet['by'];
}

interface LimitChange {
  thing: string;
  check: string;
  subject?: { id: string; name: string };
  name: string;
  previous: number | null;
  limit: number | null;
  at: number;
}

/** pve-02's VM storage over its limit: a warning whose check has a limit. */
const VZ_ALERT: HostAlert = {
  id: 'al_pve02_vz',
  serverId: 'pve-02',
  severity: 'warning',
  title: 'Disk /var/lib/vz is 92 % full',
  detail: 'The VM storage on pve-02 has 38 GB left.',
  openedAt: '2026-09-23T07:22:00.000Z',
  rule: 'disk.space_high',
  state: 'open',
  section: 'storage',
  acknowledged: null,
  muted: false,
  attention: true,
  entity: 'fs:/var/lib/vz',
  key: 'disk.space_high:fs:/var/lib/vz',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function refused(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** “Up **98.9 %** this week” as a fact's parts: the bold bits between `**`. */
function marked(text: string): ThingTextPart[] {
  return text
    .split('**')
    .map((t, i) => (i % 2 ? { text: t, strong: true } : { text: t }))
    .filter((p) => p.text);
}

export function createMonitoringFixtures(opts: { now?: () => number; seeded: boolean }) {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, Window>();
  const causes = new Map<string, ThingCause>();
  const limits = new Map<LimitKey, number>();
  const changes = new Map<string, LimitChange>();
  /** Keeping quiet's changes: the window as it was before (none: the change made it) and the end it set. */
  const quietChanges = new Map<string, { thing: string; before: Window | null; until: number }>();
  let seq = 0;

  if (opts.seeded) {
    const t = now();
    windows.set(BLACKBOX, {
      since: t - 40 * MIN,
      until: Date.parse(localAt(t, TZ, '23:00')),
      note: 'Moving the NAS',
      by: BY,
    });
    windows.set(UNIFI, {
      since: t - 2 * HOUR,
      until: Date.parse(localAt(t, TZ, '09:00', 1)),
      note: 'Replacing the attic access point',
      by: BY,
    });
    causes.set(HA, {
      thing: 'server:pve-02/guest/pve%3A131',
      name: 'homeassistant',
      words: 'Not answering while homeassistant is stopped',
      href: '/things/server%3Apve-02?guest=pve%3A131',
    });
    limits.set(`${PVE02}|host.sensor.temp_high|`, 80);
    limits.set(`${BLACKBOX}|host.disk.space_high|/mnt/disk3`, 97);
  }

  /* Kept quiet --------------------------------------------------------------------------------------------------- */

  function window(thing: string): Window | null {
    const w = windows.get(thing);
    if (!w) return null;
    if (w.until <= now()) {
      windows.delete(thing);
      return null;
    }
    return w;
  }

  function keptOf(thing: string, w: Window): KeptQuiet {
    const until = new Date(w.until).toISOString();
    const head = `Quiet ${untilText(until, now(), TZ)}`;
    return {
      id: `qw_${thing.replace(/[^a-z0-9]/gi, '')}`.slice(0, 64),
      words: w.note ? `${head} · ${w.note}` : head,
      since: new Date(w.since).toISOString(),
      until,
      ...(w.note ? { note: w.note } : {}),
      ...(w.by ? { by: w.by } : { whombat: true }),
      canEnd: true,
    };
  }

  function keep(thing: string, body: KeepQuietBody): Response {
    const t = now();
    const until = body.until ? Date.parse(body.until) : t + (body.minutes ?? 60) * MIN;
    if (!(until > t)) return refused(400, 'invalid_request', 'Pick a time that is still ahead.');
    const before = window(thing);
    windows.set(thing, {
      since: before?.since ?? t,
      until,
      ...(body.note ? { note: body.note } : {}),
      by: BY,
    });
    const changeId = `chg_fx_quiet_${++seq}`;
    quietChanges.set(changeId, { thing, before, until });
    return json({ keptQuiet: keptOf(thing, windows.get(thing) as Window), changeId });
  }

  /** Undo of keeping quiet: the window as it was before, or none; a window changed again since stays. */
  function undoQuiet(changeId: string): Response | null {
    const change = quietChanges.get(changeId);
    if (!change) return null;
    if (window(change.thing)?.until !== change.until)
      return refused(409, 'conflict', 'It was changed again since.');
    if (change.before) windows.set(change.thing, change.before);
    else windows.delete(change.thing);
    quietChanges.delete(changeId);
    return json({
      state: 'undone',
      change: {
        id: changeId,
        title: 'Kept it quiet',
        at: new Date(now()).toISOString(),
        actor: { kind: 'person', id: mara.id, name: 'Mara' },
        undo: { state: 'undone' },
        thingId: change.thing,
      },
    });
  }

  function end(thing: string): Response {
    if (!window(thing)) return refused(404, 'not_found', 'It isn’t kept quiet.');
    windows.delete(thing);
    return json({ keptQuiet: null });
  }

  /** A line quiet with the whole thing: until the window's end, or while the cause lasts. */
  function heldQuiet(w: Window | null, cause: ThingCause | null): NoticeQuiet | null {
    if (w)
      return {
        state: 'snoozed',
        words: untilText(new Date(w.until).toISOString(), now(), TZ),
        until: new Date(w.until).toISOString(),
        ...(w.by ? { by: w.by } : {}),
        at: new Date(w.since).toISOString(),
        held: 'window',
      };
    if (cause)
      return {
        state: 'ignored',
        words: cause.words.replace(/^(Not answering|Quiet) /, ''),
        at: new Date(now() - 25 * MIN).toISOString(),
        held: 'cause',
      };
    return null;
  }

  /* Pages, servers and Home -------------------------------------------------------------------------------------- */

  function decoratePage(thing: string, page: ThingPage): ThingPage {
    let p = page;
    const w = window(thing);
    const cause = causes.get(thing) ?? null;
    const held = heldQuiet(w, cause);
    if (held) {
      const kept = w ? keptOf(thing, w) : null;
      const first: ThingPageNotice = kept
        ? { id: 'quiet-window', tone: 'info', icon: 'clock', title: kept.words.slice(0, 120), nature: 'fyi' }
        : {
            id: 'quiet-cause',
            tone: 'info',
            icon: 'power',
            title: (cause as ThingCause).words.slice(0, 120),
            nature: 'fyi',
            ...(cause?.href
              ? { link: { kind: 'href' as const, label: `See ${cause.name}`.slice(0, 30), href: cause.href } }
              : {}),
          };
      let lines = false;
      const tabs = p.tabs.map((t) => ({
        ...t,
        panels: t.panels.map((panel) => {
          if (panel.kind !== 'notices') return panel;
          // Every line is quiet with the whole thing, as the runtime holds them all.
          const items = panel.items.map((n) => (n.quiet ? n : { ...n, quiet: held }));
          lines = true;
          return { ...panel, items: [first, ...items] };
        }),
      }));
      p = {
        ...p,
        tabs: lines ? tabs : p.tabs,
        ...(kept
          ? { keptQuiet: kept, status: 'ok' as const, badge: kept.words.split(' · ')[0] as string }
          : {}),
        ...(cause ? { causedBy: cause } : {}),
        ...(cause && !kept && cause.kind !== 'quiet'
          ? { status: 'unknown' as const, badge: cause.words.slice(0, 60) }
          : {}),
      };
    }
    const uptime = uptimeOf(thing);
    if (uptime && !p.uptime) {
      const fact = marked(UPTIME_MARKED[thing] ?? 'Up **all week**');
      p = { ...p, uptime, facts: [...p.facts.slice(0, 1), fact, ...p.facts.slice(1)].slice(0, 6) };
    }
    return p;
  }

  function decorateServer(serverId: string, d: HostServerDetail): HostServerDetail {
    const thing = `server:${serverId}`;
    let out = d;
    // pve-02's VM storage filling up: a line whose check has a limit (Change the limit in its ⋯).
    if (opts.seeded && serverId === 'pve-02' && !(out.alerts ?? []).some((a) => a.id === VZ_ALERT.id))
      out = {
        ...out,
        alerts: [...(out.alerts ?? []), { ...VZ_ALERT, openedAt: new Date(now() - 2 * HOUR).toISOString() }],
      };
    const w = window(thing);
    if (w) {
      const held = heldQuiet(w, null) as NoticeQuiet;
      out = {
        ...out,
        keptQuiet: keptOf(thing, w),
        // Its alerts are muted by the maintenance window: its dot shows nothing, its banner goes.
        server: {
          ...out.server,
          status: out.server.status === 'offline' ? 'offline' : 'ok',
          statusNote: null,
        },
        banner: null,
        alerts: (out.alerts ?? []).map((a) => (a.quiet ? a : { ...a, quiet: held })),
        hints: out.hints.map((h) => (h.quiet ? h : { ...h, quiet: held })),
      };
    }
    const uptime = uptimeOf(thing);
    if (uptime && !out.uptime) out = { ...out, uptime };
    return out;
  }

  function decorateHome<T extends { things: ThingSummary[] }>(home: T): T {
    return {
      ...home,
      things: home.things.map((t) => {
        const cause = causes.get(t.id);
        const w = window(t.id);
        let s = t;
        if (cause && !w) {
          const { reason: _r, ...rest } = s;
          s = { ...rest, status: 'unknown', line: cause.words, causedBy: cause };
        }
        if (w) {
          // Its lines colour nothing while it is kept quiet.
          const { reason: _r, ...rest } = s;
          s = {
            ...rest,
            status: s.status === 'offline' ? 'offline' : 'ok',
            quietUntil: new Date(w.until).toISOString(),
          };
        }
        return s;
      }),
    };
  }

  /* What happened ------------------------------------------------------------------------------------------------ */

  const UPTIME_MARKED: Record<string, string> = {
    [HA]: 'Up **98.9 %** this week · down **twice**, **1 h 50 min**',
    [UNIFI]: 'Up **99.8 %** this week · down **once**, **12 min**',
    [PVE02]: 'Up **99.6 %** this week · down **3 times**, **41 min**',
    [BLACKBOX]: 'Up **99.1 %** this week · down **once**, **1 h 30 min**',
  };

  function uptimeOf(thing: string, days = 7): ThingUptime | null {
    if (!opts.seeded) return null;
    const text = (UPTIME_MARKED[thing] ?? 'Up **all week**').replace(/\*\*/g, '');
    const period =
      days === 7
        ? text
        : text.replace('this week', `in the last ${days} days`).replace('all week', `all ${days} days`);
    const pct = /([\d.]+) %/.exec(text)?.[1];
    const downs = /down (\w+) times|down (twice|once)/.exec(text);
    const n = downs ? (downs[2] === 'twice' ? 2 : downs[2] === 'once' ? 1 : Number(downs[1])) : 0;
    return {
      text: period,
      upPct: pct ? Number(pct) : 100,
      downs: n,
      downMinutes: n ? 41 : 0,
      from: new Date(now() - days * DAY).toISOString(),
    };
  }

  function incident(
    id: string,
    nature: ThingIncident['nature'],
    words: string,
    startAgo: number,
    minutes: number | null,
    cause?: ThingIncident['cause'],
  ): ThingIncident {
    const start = now() - startAgo;
    return {
      id,
      nature,
      words,
      startedAt: new Date(start).toISOString(),
      endedAt: minutes === null ? null : new Date(start + minutes * MIN).toISOString(),
      minutes: minutes ?? Math.round(startAgo / MIN),
      ...(cause ? { cause } : {}),
    };
  }

  function alert(
    title: string,
    severity: ThingHistoryAlert['severity'],
    rule: string,
    ago: number,
    minutes: number | null,
  ): ThingHistoryAlert {
    const opened = now() - ago;
    return {
      title,
      severity,
      rule,
      openedAt: new Date(opened).toISOString(),
      resolvedAt: minutes === null ? null : new Date(opened + minutes * MIN).toISOString(),
    };
  }

  function incidentsOf(thing: string): ThingIncident[] {
    if (!opts.seeded) return [];
    switch (thing) {
      case HA:
        return [
          incident('inc_fx_ha_3', 'down', 'Not answering', 25 * MIN, null, {
            thing: 'server:pve-02/guest/pve%3A131',
            name: 'homeassistant',
          }),
          incident('inc_fx_ha_2', 'problem', '2 integrations aren’t loading', 3 * DAY + 4 * HOUR, 95),
          incident('inc_fx_ha_1', 'down', 'Not answering', 9 * DAY + 2 * HOUR, 15),
        ];
      case UNIFI:
        return [
          incident('inc_fx_unifi_2', 'problem', 'Attic AP is offline', 2 * HOUR + 10 * MIN, null),
          incident('inc_fx_unifi_1', 'down', 'Not answering', 6 * DAY + 5 * HOUR, 12),
        ];
      case PVE02:
        return [
          incident('inc_fx_pve02_4', 'problem', 'Running warm', 5 * HOUR + 12 * MIN, null),
          incident('inc_fx_pve02_3', 'down', 'Not checking in', 2 * DAY + 3 * HOUR, 22),
          incident('inc_fx_pve02_2', 'down', 'Not checking in', 4 * DAY + 7 * HOUR, 11),
          incident('inc_fx_pve02_1', 'down', 'Not checking in', 6 * DAY + 1 * HOUR, 8),
          incident('inc_fx_pve02_0', 'problem', 'A disk is filling up', 19 * DAY, 3 * 60 + 5),
          incident('inc_fx_pve02_x', 'problem', 'Running warm', 26 * DAY, 47),
        ];
      case BLACKBOX:
        return [
          incident('inc_fx_blackbox_2', 'problem', 'A disk in the array failed', 3 * HOUR, null),
          incident('inc_fx_blackbox_1', 'down', 'Not checking in', 5 * DAY, 90),
        ];
      default:
        return [];
    }
  }

  function alertsOf(thing: string): ThingHistoryAlert[] {
    if (!opts.seeded) return [];
    if (thing === PVE02)
      return [
        alert('CPU temperature above 72 °C', 'warning', 'sensor.temp_high', 5 * HOUR + 12 * MIN, null),
        alert('pve-02 isn’t checking in', 'critical', 'agent.heartbeat_missing', 2 * DAY + 3 * HOUR, 22),
        alert('pve-02 isn’t checking in', 'critical', 'agent.heartbeat_missing', 4 * DAY + 7 * HOUR, 11),
        alert('Disk / is 91 % full', 'warning', 'disk.space_high', 19 * DAY, 3 * 60 + 5),
      ];
    if (thing === BLACKBOX)
      return [
        alert('Disk 3 failed in the array', 'critical', 'unraid.disk_failed', 3 * HOUR, null),
        alert('blackbox isn’t checking in', 'critical', 'agent.heartbeat_missing', 5 * DAY, 90),
      ];
    return [];
  }

  function history(thing: string, days: number): ThingHistory {
    const from = now() - days * DAY;
    const within = (at: string) => Date.parse(at) >= from;
    return {
      thing,
      days,
      from: new Date(from).toISOString(),
      uptime: uptimeOf(thing, days),
      incidents: incidentsOf(thing).filter((i) => within(i.startedAt) || i.endedAt === null),
      ...(thing.startsWith('server:') ? { alerts: alertsOf(thing).filter((a) => within(a.openedAt)) } : {}),
    };
  }

  /* Limits ------------------------------------------------------------------------------------------------------- */

  const ruleOf = (check: string) => HOST_WATCH_CHECKS.find((c) => c.check === check)?.rule;

  function decorateWatch(thing: string, watch: ThingWatch): ThingWatch {
    return {
      ...watch,
      checks: watch.checks.map((c) => {
        const range = hostWatchLimit(ruleOf(c.check));
        if (!range) return c;
        const prefix = `${thing}|${c.check}|`;
        const items = [...limits]
          .filter(([key]) => key.startsWith(prefix) && key.length > prefix.length)
          .map(([key, value]) => {
            const id = key.slice(prefix.length);
            return { subject: { id, name: id }, value };
          });
        return { ...c, limit: { ...range, value: limits.get(prefix) ?? null, items } };
      }),
    };
  }

  function setLimit(
    thing: string,
    body: SetThingWatchLimitBody,
    watch: ThingWatch,
    undoes?: string,
  ): Response {
    const c = watch.checks.find((x) => x.check === body.check);
    const range = hostWatchLimit(ruleOf(body.check));
    if (!c || !range) return refused(404, 'not_found', 'This check has no limit to change.');
    if (body.limit !== null && (body.limit < range.min || body.limit > range.max))
      return refused(
        400,
        'invalid_request',
        `Choose a limit from ${range.min} to ${range.max} ${range.unit}.`,
      );
    const key = `${thing}|${body.check}|${body.subject?.id ?? ''}`;
    const previous = limits.get(key) ?? null;
    if (body.limit === null) limits.delete(key);
    else limits.set(key, body.limit);
    const changeId = `chg_fx_limit_${++seq}`;
    if (!undoes)
      changes.set(changeId, {
        thing,
        check: body.check,
        ...(body.subject ? { subject: body.subject } : {}),
        name: body.subject?.name ?? c.name,
        previous,
        limit: body.limit,
        at: now(),
      });
    return json({ watch: decorateWatch(thing, watch), changeId });
  }

  function undo(changeId: string): Response | null {
    const change = changes.get(changeId);
    if (!change) return null;
    const key = `${change.thing}|${change.check}|${change.subject?.id ?? ''}`;
    if ((limits.get(key) ?? null) !== change.limit)
      return refused(409, 'conflict', 'The limit changed meanwhile, so Whombat won’t put it back.');
    if (change.previous === null) limits.delete(key);
    else limits.set(key, change.previous);
    changes.delete(changeId);
    return json({
      state: 'undone',
      change: {
        id: changeId,
        title: `Changed the limit for ${change.name}`,
        at: new Date(change.at).toISOString(),
        actor: { kind: 'person', id: mara.id, name: 'Mara' },
        undo: { state: 'undone' },
        thingId: change.thing,
      },
    });
  }

  /* The layer ---------------------------------------------------------------------------------------------------- */

  const base = `/api/v1/burrows/${burrow.slug}`;

  async function read<T>(res: Response): Promise<T | null> {
    if (!res.ok) return null;
    try {
      return (await res.clone().json()) as T;
    } catch {
      return null;
    }
  }

  return {
    /** Answers monitoring's own routes and reads the rest through it; `inner` is the world under it. */
    async fetch(req: Request, inner: (req: Request) => Promise<Response>): Promise<Response> {
      const url = new URL(req.url, 'http://fixtures.local');
      const path = url.pathname;
      if (!path.startsWith(`${base}/`)) return inner(req);
      const rest = path.slice(base.length);
      const own = /^\/things\/([^/]+)\/(keep-quiet|keep-quiet\/end|history|watch\/limit|watch)$/.exec(rest);
      if (own) {
        const thing = decodeURIComponent(own[1] as string);
        const what = own[2];
        if (what === 'keep-quiet' && req.method === 'POST')
          return keep(thing, (await req.json()) as KeepQuietBody);
        if (what === 'keep-quiet/end' && req.method === 'POST') return end(thing);
        if (what === 'history' && req.method === 'GET') {
          const days = Number(url.searchParams.get('days') ?? 30);
          return json(history(thing, days === 90 ? 90 : 30));
        }
        if (what === 'watch/limit' && req.method === 'PUT') {
          const watch = await read<ThingWatch>(
            await inner(new Request(new URL(`${base}/things/${own[1]}/watch`, url).toString())),
          );
          if (!watch) return refused(404, 'not_found', 'There’s nothing here.');
          return setLimit(thing, (await req.json()) as SetThingWatchLimitBody, watch);
        }
        if (what === 'watch' && req.method === 'GET') {
          const res = await inner(req);
          const watch = await read<ThingWatch>(res);
          return watch && thing.startsWith('server:') ? json(decorateWatch(thing, watch)) : res;
        }
      }
      const undone = /^\/changes\/(chg_fx_(?:limit|quiet)_\d+)\/undo$/.exec(rest);
      if (undone && req.method === 'POST') {
        const answer = undo(undone[1] as string) ?? undoQuiet(undone[1] as string);
        if (answer) return answer;
      }
      if (req.method !== 'GET') return inner(req);
      const res = await inner(req);
      const page = /^\/things\/([^/]+)$/.exec(rest);
      if (page) {
        const p = await read<ThingPage>(res);
        return p ? json(decoratePage(decodeURIComponent(page[1] as string), p)) : res;
      }
      const server = /^\/hosts\/servers\/([^/]+)$/.exec(rest);
      if (server) {
        const d = await read<HostServerDetail>(res);
        return d ? json(decorateServer(decodeURIComponent(server[1] as string), d)) : res;
      }
      if (rest === '/home') {
        const home = await read<{ things: ThingSummary[] }>(res);
        return home?.things ? json(decorateHome(home)) : res;
      }
      return res;
    },
  };
}
