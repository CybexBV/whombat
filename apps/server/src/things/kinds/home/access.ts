/**
 * UniFi Access's page (service-dashboards.md SD-33, SD-04, SD-S15): its developer API on port 12445 with the
 * connection's bearer token — `GET /api/v1/developer/doors` (locked or not, open or closed when the door has a sensor),
 * each door's `GET …/doors/<id>/lock_rule` (Access 1.24.6 and later: kept locked or unlocked, unlocked until a time, its
 * schedule), `GET …/devices` (the readers; online when the answer says so) and today's door openings (`POST
 * …/system/logs {topic: "door_openings", since, until}`, which only reads). Answers are `{code, msg, data}`, `SUCCESS`
 * or an error code, sometimes with status 200. Kept 30 seconds; a part that fails is left out. The week (each earlier
 * day's and the week before's `total` with `page_size=1`, the week's newest 100 openings, and `GET …/users`) is kept
 * 10 minutes (service-slots.md; the calls as Access's API reference 3.1.41 describes them).
 *
 * Its Summary in slots: the doors, each with **Unlock** (once) or **Back to schedule** when held open, both confirmed,
 * beside In Access (doors, readers, openings today, people); openings per day this week beside Who came in; Today's
 * openings (who opened which door) below. Never a lockdown or an evacuation.
 */
import type { ThingLine, ThingPageItem, ThingPageKpi } from '@whombat/core';
import { externalEffect } from '../../../commit/scope';
import { ConnectionChangedError } from '../../../connections/call-target';
import { signedConnectionFetch } from '../../../connections/http';
import { type CatalogConnectionRow, ConnectionAuthError } from '../../../connections/types';
import { startOfLocalDay } from '../../../home/time';
import { ApiError, badRequest, conflict, forbidden } from '../../../lib/errors';
import type { Services } from '../../../services';
import { VaultCallError } from '../../../vault/net';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { clip, clock, dateOf, line, list, plural, rec, str, thousands, when } from '../../words';
import {
  cachedRead,
  getJson,
  KIND_DEADLINE_MS,
  KIND_MAX_BYTES,
  latestRead,
  problemOf,
  ReadProblem,
  withDeadline,
} from '../read';
import { type KindAction, type KindModule, type KindSeen, seenFromView } from '../registry';
import {
  countLine,
  daysWith,
  type InventoryPanel,
  inventory,
  type LivePanel,
  lastDays,
  liveList,
  type PeoplePanel,
  people,
  slotPanels,
  type TrendPanel,
  trend,
  weekChange,
} from '../slots';
import type { KindCtx, KindView } from '../types';
import { itemLines, lineId, subjectName } from './lines';
import { type ButtonCtx, button, type ThingPageButton } from './shapes';

const NAME = 'UniFi Access';
const API = '/api/v1/developer';
/**
 * A door open longer than this is worth a look: twice the health pass's 5 minutes, so a door held for a delivery isn't
 * (quiet-notices.md QN-04).
 */
export const OPEN_TOO_LONG_MS = 10 * 60_000;
const DOORS_MAX = 60;
/** The week's reads are kept this long: a home opens its doors a few dozen times a day. */
const WEEK_KEEP_MS = 10 * 60_000;
const OPENINGS_READ = 100;
const DAY_MS = 86_400_000;

export interface AccessDoor {
  id: string;
  name: string;
  locked: boolean | null;
  /** Open or closed by its sensor; null without one. */
  open: boolean | null;
  /** Its lock rule (`schedule`, `keep_lock`, `keep_unlock`, `custom`, `lock_early`) and when it ends. */
  rule: { type: string; endsAt: Date | null } | null;
}

export interface AccessDevice {
  id: string;
  name: string;
  type: string;
  /** Null when the answer doesn't say. */
  online: boolean | null;
}

export interface AccessOpening {
  id: string;
  at: Date;
  door: string;
  who: string | null;
  how: string | null;
  granted: boolean;
}

export interface AccessSnapshot {
  readAt: Date;
  doors: AccessDoor[];
  devices: AccessDevice[] | null;
  openings: AccessOpening[] | null;
  /** More openings today than the read took. */
  moreOpenings: boolean;
  /** Today's openings as Access counts them, refused ones too; null when it didn't say. */
  openingsTotal?: number | null;
  /** Some doors' lock rules weren't read (a read failed, more doors than read): kept unlocked can't be told for them. */
  rulesUnread?: boolean;
}

/* Reading ------------------------------------------------------------------------------------------------------------ */

/** An answer's `data` when its code is `SUCCESS`; otherwise a `ReadProblem` (a missing scope says so). */
export function accessData(body: unknown): unknown {
  const b = rec(body);
  if (b.code === 'SUCCESS') return b.data;
  if (b.code === 'CODE_UNAUTHORIZED')
    throw new ReadProblem('UniFi Access refused: Whombat’s token lacks the permission to read this.');
  throw new ReadProblem('UniFi Access answered with an error.');
}

export function parseDoors(data: unknown, rules: ReadonlyMap<string, unknown>): AccessDoor[] {
  return list(data)
    .map(rec)
    .map((d) => {
      const id = str(d.id) ?? '';
      const relay = str(d.door_lock_relay_status);
      const position = str(d.door_position_status);
      const rule = rules.has(id) ? rec(rules.get(id)) : null;
      return {
        id,
        name: str(d.name) ?? str(d.full_name) ?? 'Door',
        locked: relay === 'lock' ? true : relay === 'unlock' ? false : null,
        open: position === 'open' ? true : position === 'close' ? false : null,
        rule:
          rule && str(rule.type) ? { type: str(rule.type) as string, endsAt: dateOf(rule.ended_time) } : null,
      };
    })
    .filter((d) => d.id);
}

/** `GET /devices` answers lists of lists (by hub); the online flag isn't documented there, so it is read if present. */
export function parseDevices(data: unknown): AccessDevice[] {
  const flat = list(data).flatMap((x) => (Array.isArray(x) ? x : [x]));
  return flat
    .map(rec)
    .map((d) => {
      const flag = d.online ?? d.is_online ?? d.connected;
      const state = str(d.state) ?? str(d.status);
      return {
        id: str(d.id) ?? '',
        name: str(d.alias) && str(d.alias) !== str(d.name) ? `${str(d.alias)}` : (str(d.name) ?? 'Reader'),
        type: str(d.type) ?? str(d.device_type) ?? '',
        online: typeof flag === 'boolean' ? flag : state ? /^(online|connected|ok)$/i.test(state) : null,
      };
    })
    .filter((d) => d.id);
}

const HOW: Record<string, string> = {
  NFC: 'card',
  PIN_CODE: 'PIN',
  MOBILE_TAP: 'app',
  MOBILE_BUTTON: 'app',
  MOBILE_SHAKE: 'app',
  MOBILE_WAVE: 'app',
  BT_TAP: 'app',
  BT_BUTTON: 'app',
  TOUCH_PASS: 'phone wallet',
  REMOTE_THROUGH_UAH: 'remotely',
  REMOTE: 'remotely',
  BUTTON: 'button',
  EXIT_BUTTON: 'button',
  REX: 'button',
  FACE: 'face',
  QR_CODE: 'QR code',
  CALL: 'doorbell call',
  WAVE: 'hand wave',
  LICENSE_PLATE: 'number plate',
};

/** How someone opened it: “card”, “PIN”, “app”, “button”. */
export function howWords(provider: string | null): string | null {
  if (!provider) return null;
  return HOW[provider.toUpperCase()] ?? provider.toLowerCase().replace(/_/g, ' ');
}

/** `system/logs` door openings, newest first. */
export function parseOpenings(data: unknown): AccessOpening[] {
  return list(rec(data).hits)
    .map(rec)
    .map((h, i) => {
      const src = rec(h._source);
      const event = rec(src.event);
      const actor = rec(src.actor);
      const targets = list(src.target).map(rec);
      const door = targets.find((t) => t.type === 'door');
      const at = dateOf(event.published) ?? dateOf(h['@timestamp']);
      const who = str(actor.display_name);
      return {
        id: (str(h._id) || `${at?.getTime() ?? 0}-${i}`).slice(0, 200),
        at: at as Date,
        door: str(door?.display_name) ?? str(targets[0]?.display_name) ?? 'A door',
        who: who && who !== 'N/A' ? who : null,
        how: howWords(str(rec(src.authentication).credential_provider)),
        granted: str(event.result) === 'ACCESS',
      };
    })
    .filter((o) => o.at)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** A POST that only reads (the logs), as the connection. */
async function postRead(
  services: Services,
  row: CatalogConnectionRow,
  path: string,
  query: string,
  body: unknown,
) {
  let res: Awaited<ReturnType<typeof signedConnectionFetch>>;
  try {
    res = await externalEffect(
      'things.read',
      () =>
        signedConnectionFetch(
          services,
          row,
          {
            method: 'POST',
            url: `${row.baseUrl.replace(/\/+$/, '')}${path}?${query}`,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
          },
          { maxBytes: KIND_MAX_BYTES, deadlineMs: KIND_DEADLINE_MS },
        ),
      { idempotent: true },
    );
  } catch (err) {
    throw problemOf(err, NAME);
  }
  if (res.status >= 400) throw new ReadProblem('UniFi Access answered with an error.');
  return JSON.parse(res.body.toString('utf8')) as unknown;
}

async function readAccess(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<AccessSnapshot> {
  const get = async (path: string) => accessData(await getJson(services, row, NAME, `${API}${path}`));
  const since = Math.floor(startOfLocalDay(now, timeZone).getTime() / 1000);
  const [doors, devices, logs] = await Promise.all([
    get('/doors'),
    optional(get('/devices')),
    optional(
      postRead(services, row, `${API}/system/logs`, 'page_num=1&page_size=100', {
        topic: 'door_openings',
        since,
        until: Math.floor(now.getTime() / 1000),
      }),
    ),
  ]);
  const ids = list(doors)
    .map((d) => str(rec(d).id))
    .filter((id): id is string => !!id)
    .slice(0, DOORS_MAX);
  const rules = new Map<string, unknown>();
  let rulesUnread = list(doors).length > ids.length;
  await Promise.all(
    ids.map((id) =>
      optional(get(`/doors/${encodeURIComponent(id)}/lock_rule`)).then((r) => {
        if (r) rules.set(id, r);
        else rulesUnread = true;
      }),
    ),
  );
  let openings: AccessOpening[] | null = null;
  let more = false;
  let total: number | null = null;
  if (logs) {
    try {
      openings = parseOpenings(accessData(logs));
      total = logsTotal(logs);
      more = total !== null && total > openings.length;
    } catch {
      openings = null;
    }
  }
  return {
    readAt: now,
    doors: parseDoors(doors, rules),
    devices: devices ? parseDevices(devices) : null,
    openings,
    moreOpenings: more,
    openingsTotal: total ?? openings?.length ?? null,
    ...(rulesUnread ? { rulesUnread: true } : {}),
  };
}

/** A logs answer's `total` (it sits beside `data`); null when it doesn't say. */
function logsTotal(body: unknown): number | null {
  const n = Number(rec(body).total);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The week as Access says it, kept 10 minutes; each part null when it couldn't be read. */
export interface AccessWeek {
  /** Openings (refused ones too) on each of the 6 days before today, the oldest first. */
  days: (number | null)[];
  /** All openings of the 7 days before those 7. */
  before: number | null;
  /** The week's newest openings, and whether there were more. */
  openings: AccessOpening[] | null;
  moreOpenings: boolean;
  /** The people in Access: active ones, and how many came this week; null without the `view:user` scope. */
  users: { active: number; added: number; all: number } | null;
}

/** People in Access from `GET /users` (`status`, `onboard_time`; its `pagination.total` when there are more). */
export function parseUsers(body: unknown, now: Date): AccessWeek['users'] {
  const users = list(accessData(body)).map(rec);
  const all = Number(rec(rec(body).pagination).total);
  const active = users.filter((u) => str(u.status) !== 'DEACTIVATED');
  const added = active.filter((u) => {
    const at = dateOf(u.onboard_time);
    return at && now.getTime() - at.getTime() < 7 * DAY_MS;
  }).length;
  const total = Number.isFinite(all) && all > users.length ? all : null;
  return { active: total ?? active.length, added, all: total ?? users.length };
}

async function readAccessWeek(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<AccessWeek> {
  const starts = lastDays(now, timeZone, 7).at.map((d) => startOfLocalDay(d, timeZone));
  const first = starts[0] as Date;
  const beforeStart = startOfLocalDay(new Date(first.getTime() - 7 * DAY_MS + 3 * 3600_000), timeZone);
  const s = (d: Date) => Math.floor(d.getTime() / 1000);
  const logs = (since: Date, until: Date, size: number) =>
    optional(
      postRead(services, row, `${API}/system/logs`, `page_num=1&page_size=${size}`, {
        topic: 'door_openings',
        since: s(since),
        until: s(until),
      }),
    );
  const totalOf = (body: unknown) => {
    if (!body) return null;
    try {
      accessData(body);
      return logsTotal(body);
    } catch {
      return null;
    }
  };
  const [days, before, week, users] = await Promise.all([
    Promise.all(starts.slice(0, 6).map((d, i) => logs(d, starts[i + 1] as Date, 1).then(totalOf))),
    logs(beforeStart, first, 1).then(totalOf),
    logs(first, now, OPENINGS_READ),
    optional(getJson(services, row, NAME, `${API}/users?page_num=1&page_size=100`)),
  ]);
  let openings: AccessOpening[] | null = null;
  let more = false;
  if (week)
    try {
      openings = parseOpenings(accessData(week));
      const n = logsTotal(week);
      more = n !== null && n > openings.length;
    } catch {
      openings = null;
    }
  let people: AccessWeek['users'] = null;
  if (users)
    try {
      people = parseUsers(users, now);
    } catch {
      people = null;
    }
  return { days, before, openings, moreOpenings: more, users: people };
}

/** The week's reads, kept 10 minutes; null when none could be made. */
export function accessWeek(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<AccessWeek | null> {
  return cachedRead(
    services,
    `access-week:${row.id}:${timeZone}`,
    row,
    () =>
      withDeadline(
        readAccessWeek(services, row, now, timeZone),
        KIND_DEADLINE_MS,
        'UniFi Access didn’t answer in time.',
      ),
    WEEK_KEEP_MS,
  ).catch(() => null);
}

function loadAccess(services: Services, row: CatalogConnectionRow, now: Date, timeZone: string) {
  return async () => {
    try {
      return await withDeadline(
        readAccess(services, row, now, timeZone),
        KIND_DEADLINE_MS,
        'UniFi Access didn’t answer in time.',
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

export const accessLatest = (services: Services, row: CatalogConnectionRow, now: Date, timeZone: string) =>
  latestRead(services, `access:${row.id}`, row, loadAccess(services, row, now, timeZone));

export const accessSnapshot = (services: Services, row: CatalogConnectionRow, now: Date, timeZone: string) =>
  cachedRead(services, `access:${row.id}`, row, loadAccess(services, row, now, timeZone));

/** Since when Whombat has seen each door open (Access doesn't say): per connection, kept while it stays open. */
const openSeen = new Map<string, Map<string, number>>();

export function openSinceOf(connectionId: string, s: AccessSnapshot): Map<string, Date> {
  const seen = openSeen.get(connectionId) ?? new Map<string, number>();
  const out = new Map<string, Date>();
  for (const d of s.doors) {
    if (d.open !== true) seen.delete(d.id);
    else {
      const at = Math.min(seen.get(d.id) ?? s.readAt.getTime(), s.readAt.getTime());
      seen.set(d.id, at);
      out.set(d.id, new Date(at));
    }
  }
  openSeen.set(connectionId, seen);
  return out;
}

/* What it means ------------------------------------------------------------------------------------------------------- */

/** Held open: kept unlocked, or unlocked for a while by hand. */
export const heldOpen = (d: AccessDoor) => d.rule?.type === 'keep_unlock' || d.rule?.type === 'custom';

/** A door's rule in words: “Unlocked until 18:00”, “Kept unlocked”, “Kept locked”, “On its schedule”. */
export function ruleWords(d: AccessDoor, now: Date, timeZone: string): string | null {
  const r = d.rule;
  if (!r) return null;
  // “Kept” rules end far in the future (Access answers a date decades on).
  const until =
    r.endsAt && r.endsAt.getTime() - now.getTime() < 7 * 86_400_000 && r.endsAt > now
      ? when(r.endsAt, now, timeZone).replace(/^Today /, '')
      : null;
  switch (r.type) {
    case 'keep_unlock':
      return until ? `Unlocked until ${until}` : 'Kept unlocked';
    case 'keep_lock':
      return until ? `Locked until ${until}` : 'Kept locked';
    case 'custom':
      return until ? `Unlocked until ${until}` : 'Unlocked for a while';
    case 'schedule':
      return until ? `Unlocked on schedule until ${until}` : 'Unlocked on its schedule';
    case 'lock_early':
      return 'Locked early';
    default:
      return null;
  }
}

const readerOf = (d: AccessDevice) => !/^UAH/i.test(d.type);

export interface AccessCtx {
  now: Date;
  timeZone: string;
  openSince: Map<string, Date>;
}

/** The four figures (SD-33): Doors, Readers, Openings today, Unlocked now. In slots only the card shows them. */
export function accessKpis(s: AccessSnapshot): ThingPageKpi[] {
  const locked = s.doors.filter((d) => d.locked === true).length;
  const unlocked = s.doors.filter((d) => d.locked === false).length;
  const out: ThingPageKpi[] = [
    {
      key: 'doors',
      label: 'Doors',
      value: String(locked),
      rest: 'locked',
      sub: plural(s.doors.length, 'door'),
    },
  ];
  if (s.devices) {
    const readers = s.devices.filter(readerOf);
    const known = readers.filter((d) => d.online !== null);
    if (known.length) {
      const online = known.filter((d) => d.online).length;
      out.push({
        key: 'readers',
        label: 'Readers',
        value: String(online),
        rest: `of ${readers.length}`,
        sub: 'online',
        ...(online < known.length ? { tone: 'warn' as const } : {}),
      });
    } else out.push({ key: 'readers', label: 'Readers', value: String(readers.length) });
  }
  if (s.openings) {
    const granted = s.openings.filter((o) => o.granted).length;
    const refused = s.openings.length - granted;
    out.push({
      key: 'openings',
      label: 'Openings today',
      value: `${granted}${s.moreOpenings ? '+' : ''}`,
      ...(refused ? { sub: `${refused} refused` } : {}),
    });
  }
  out.push({
    key: 'unlocked',
    label: 'Unlocked now',
    value: String(unlocked),
    ...(s.doors.some(heldOpen) ? { sub: 'held open', tone: 'warn' as const } : {}),
  });
  return out;
}

const moment = (at: Date, now: Date, timeZone: string) => {
  const w = when(at, now, timeZone);
  return w.startsWith('Today ') ? clock(at, timeZone) : w;
};

/** Every check UniFi Access raises (What Whombat watches, QN-15). */
export const ACCESS_CHECKS: readonly KindCheck[] = [
  { check: 'access.door_open', name: 'Doors left open', nature: 'you', perItem: true, startsOn: true },
  {
    check: 'access.reader_offline',
    name: 'Readers and hubs going offline',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'access.door_unlocked',
    name: 'Doors kept unlocked',
    nature: 'you',
    perItem: true,
    startsOn: true,
  },
];

const doorSubject = (d: AccessDoor) => ({ id: `door:${d.id}`.slice(0, 160), name: subjectName(d.name) });
const readerSubject = (d: AccessDevice) => ({
  id: `reader:${d.id}`.slice(0, 160),
  name: subjectName(d.name),
});
const short = (title: string, badge: string) => (title.length > 40 ? { badge } : {});

/**
 * “Worth a look” (SD-33, QN-01…QN-04): a door open over 10 minutes and a door kept unlocked, only a person's to do
 * (the door's row has its button); a reader or hub offline, a problem after two passes in a row. One line per door and
 * per device (QN-03).
 */
export function accessNotices(s: AccessSnapshot, ctx: AccessCtx): KindNotice[] {
  const out: KindNotice[] = [];
  const open = s.doors.filter((d) => {
    const since = ctx.openSince.get(d.id);
    return since && ctx.now.getTime() - since.getTime() > OPEN_TOO_LONG_MS;
  });
  out.push(
    ...itemLines(
      open,
      (d) => doorSubject(d).id,
      (d) => {
        const title = clip(`${d.name} is open`, 120);
        return {
          id: lineId('open', d.id),
          tone: 'warn',
          icon: 'door',
          title,
          detail: `Open since ${moment(ctx.openSince.get(d.id) as Date, ctx.now, ctx.timeZone)}`,
          nature: 'you',
          check: 'access.door_open',
          subject: doorSubject(d),
          ignore: { lifts: 'fixed', words: 'Until it’s closed.' },
          ...short(title, 'A door is open'),
        };
      },
      (more, subject, episode) => ({
        id: 'open-more',
        tone: 'warn',
        icon: 'door',
        title: `${more.length} more doors are open`,
        detail: clip(more.map((d) => d.name).join(' · '), 200),
        nature: 'you',
        check: 'access.door_open',
        subject,
        episode,
        ignore: { lifts: 'newer', words: 'Until the list changes.' },
      }),
    ),
  );
  const offline = (s.devices ?? [])
    .filter((d) => d.online === false)
    .sort((a, b) => a.name.localeCompare(b.name));
  out.push(
    ...itemLines(
      offline,
      (d) => readerSubject(d).id,
      (d) => {
        const title = clip(`${d.name} is offline`, 120);
        return {
          id: lineId('offline', d.id),
          tone: 'warn',
          icon: 'device',
          title,
          ...(d.type ? { detail: clip(d.type, 200) } : {}),
          link: {
            kind: 'ask',
            label: 'Look into it',
            question: clip(`Why is ${d.name} offline in UniFi Access?`, 300),
          },
          nature: 'problem',
          check: 'access.reader_offline',
          subject: readerSubject(d),
          ignore: { lifts: 'fixed', words: 'Until it’s back online.' },
          confirm: 2,
          ...short(title, 'A reader is offline'),
        };
      },
      (more, subject, episode) => ({
        id: 'offline-more',
        tone: 'warn',
        icon: 'device',
        title: `${more.length} more readers offline`,
        detail: clip(more.map((d) => d.name).join(' · '), 200),
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: 'Why are some of my UniFi Access readers offline?',
        },
        nature: 'problem',
        check: 'access.reader_offline',
        subject,
        episode,
        ignore: { lifts: 'newer', words: 'Until the list changes.' },
        confirm: 2,
      }),
    ),
  );
  out.push(
    ...itemLines(
      s.doors.filter((x) => x.rule?.type === 'keep_unlock'),
      (d) => doorSubject(d).id,
      (d) => {
        const title = clip(`${d.name} is kept unlocked`, 120);
        return {
          id: lineId('held', d.id),
          tone: 'warn',
          icon: 'door',
          title,
          detail: 'Anyone can open it until it goes back to its schedule.',
          nature: 'you',
          check: 'access.door_unlocked',
          subject: doorSubject(d),
          ignore: { lifts: 'fixed', words: 'Until it’s back on schedule.' },
          ...short(title, 'A door is kept unlocked'),
        };
      },
      (more, subject, episode) => ({
        id: 'held-more',
        tone: 'warn',
        icon: 'door',
        title: `${more.length} more doors are kept unlocked`,
        detail: clip(more.map((d) => d.name).join(' · '), 200),
        nature: 'you',
        check: 'access.door_unlocked',
        subject,
        episode,
        ignore: { lifts: 'newer', words: 'Until the list changes.' },
      }),
    ),
  );
  return out;
}

/** The checks this read couldn't fully see (QN-S21): devices not read, doors whose lock rule wasn't read. */
export function accessSkipped(s: AccessSnapshot): string[] {
  const out: string[] = [];
  if (!s.devices) out.push('access.reader_offline');
  if (s.rulesUnread) out.push('access.door_unlocked');
  return out;
}

/** A door's button (SD-33): Back to schedule when held open, else Unlock (once); both confirmed. */
export function doorButton(d: AccessDoor, bctx: ButtonCtx): ThingPageButton {
  if (heldOpen(d))
    return button(bctx, {
      action: 'schedule',
      target: d.id,
      label: 'Back to schedule',
      icon: 'lock',
      confirm: {
        title: clip(`Set ${d.name} back to its schedule?`, 80),
        body: 'It locks again unless its schedule keeps it unlocked now.',
        button: 'Back to schedule',
      },
    });
  return button(bctx, {
    action: 'unlock',
    target: d.id,
    label: 'Unlock',
    icon: 'unlock',
    confirm: {
      title: clip(`Unlock ${d.name}?`, 80),
      body: 'It unlocks once, for the few seconds it does for a card, then locks again.',
      button: 'Unlock',
    },
  });
}

/** Today's openings (SD-33): which door, who, how, when. */
export function openingItems(s: AccessSnapshot): ThingPageItem[] {
  return (s.openings ?? []).slice(0, 50).map((o) => ({
    id: o.id,
    title: clip(o.door, 160),
    detail: clip([o.granted ? (o.who ?? 'Someone') : 'Refused', o.how].filter(Boolean).join(' · '), 300),
    at: o.at.toISOString(),
    icon: 'door' as const,
    ...(o.granted ? {} : { tone: 'warn' as const }),
  }));
}

function facts(s: AccessSnapshot): ThingLine[] {
  const unlocked = s.doors.filter((d) => d.locked === false).length;
  return [
    line(
      unlocked
        ? `**${unlocked}** of ${s.doors.length} doors unlocked`
        : `All **${s.doors.length}** doors locked`,
    ),
  ];
}

/** The doors by what needs a look: held open, unlocked or open first, then by name. */
function doorOrder(s: AccessSnapshot): AccessDoor[] {
  const rank = (d: AccessDoor) => (heldOpen(d) ? 0 : d.locked === false ? 1 : d.open ? 2 : 3);
  return s.doors
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, DOORS_MAX);
}

/** Live, “Doors”: one line per door, locked or not, open or closed, its rule, and its button. */
export function accessLive(s: AccessSnapshot, ctx: AccessCtx, bctx: ButtonCtx): LivePanel | null {
  if (!s.doors.length) return null;
  const unlocked = s.doors.filter((d) => d.locked === false).length;
  return liveList({
    id: 'doors',
    title: 'Doors',
    meta: unlocked
      ? `${unlocked} of ${s.doors.length} unlocked`
      : s.doors.length === 1
        ? 'Locked'
        : `All ${s.doors.length} locked`,
    items: doorOrder(s).map((d) => {
      const since = ctx.openSince.get(d.id);
      const openLong = !!since && ctx.now.getTime() - since.getTime() > OPEN_TOO_LONG_MS;
      const rule = ruleWords(d, ctx.now, ctx.timeZone);
      const state =
        d.open === null
          ? null
          : d.open
            ? since
              ? `Open since ${moment(since, ctx.now, ctx.timeZone)}`
              : 'Open'
            : 'Closed';
      const detail = [state, rule].filter(Boolean).join(' · ');
      return {
        id: d.id.slice(0, 200),
        title: clip(d.name, 160),
        icon: 'door' as const,
        ...(detail ? { detail: clip(detail, 300) } : {}),
        ...(d.locked === null ? {} : { right: d.locked ? 'Locked' : 'Unlocked' }),
        ...(heldOpen(d) || openLong ? { tone: 'warn' as const } : {}),
        actions: [doorButton(d, bctx)],
      };
    }),
  });
}

/** Inventory, “In Access”: the doors, the readers, today's openings and the people who may come in. */
export function accessInventory(s: AccessSnapshot, week: AccessWeek | null): InventoryPanel | null {
  const items: ThingPageItem[] = [];
  const unlocked = s.doors.filter((d) => d.locked === false).length;
  const held = s.doors.filter(heldOpen).length;
  items.push(
    countLine({
      id: 'doors',
      title: 'Doors',
      icon: 'door',
      value: thousands(s.doors.length),
      ...(held ? { detail: `${held} kept unlocked` } : {}),
      ...(!s.doors.length
        ? {}
        : unlocked
          ? { note: `${unlocked} unlocked`, ...(held ? { noteTone: 'warn' as const } : {}) }
          : { note: 'All locked', noteTone: 'ok' as const }),
    }),
  );
  if (s.devices) {
    const readers = s.devices.filter(readerOf);
    const known = readers.filter((d) => d.online !== null);
    const off = known.filter((d) => !d.online).length;
    items.push(
      countLine({
        id: 'readers',
        title: 'Readers',
        icon: 'device',
        value: thousands(readers.length),
        ...(!known.length
          ? {}
          : off
            ? { note: `${off} offline`, noteTone: 'warn' as const }
            : { note: 'All online', noteTone: 'ok' as const }),
      }),
    );
  }
  if (s.openings) {
    const granted = s.openings.filter((o) => o.granted).length;
    const refused = s.openings.length - granted;
    items.push(
      countLine({
        id: 'openings',
        title: 'Openings today',
        icon: 'door',
        value: `${thousands(granted)}${s.moreOpenings ? '+' : ''}`,
        note: refused ? `${refused} refused` : 'None refused',
        ...(refused ? { noteTone: 'warn' as const } : {}),
      }),
    );
  }
  if (week?.users)
    items.push(
      countLine({
        id: 'people',
        title: 'People',
        icon: 'key',
        value: thousands(week.users.active),
        ...(week.users.added ? { note: `+${week.users.added} this week`, noteTone: 'ok' as const } : {}),
      }),
    );
  return inventory({ id: 'inventory', title: 'In Access', items });
}

/**
 * Trend, “This week”: door openings per day (refused ones too, as Access counts them), today's from the page's read,
 * and the change on the week before. Left out with fewer than 2 days.
 */
export function accessTrend(s: AccessSnapshot, week: AccessWeek | null, ctx: AccessCtx): TrendPanel | null {
  if (!week) return null;
  const values = [...week.days, s.openingsTotal ?? null];
  if (daysWith(values) < 2) return null;
  const total = values.reduce<number>((a, b) => a + (b ?? 0), 0);
  const whole = daysWith(values) === values.length;
  return trend({
    id: 'week',
    title: 'This week',
    meta: 'Door openings per day',
    days: lastDays(ctx.now, ctx.timeZone, 7),
    values,
    label: 'Openings',
    color: 'green',
    figure: { value: thousands(total), rest: total === 1 ? 'opening' : 'openings' },
    change: whole && week.before !== null ? weekChange(total, week.before) : null,
    changeWords: ' on last week',
  });
}

/** People, “Who came in”: who opened a door most this week (today's openings when the week couldn't be read). */
export function whoCameIn(s: AccessSnapshot, week: AccessWeek | null): PeoplePanel | null {
  const openings = week?.openings ?? s.openings;
  if (!openings) return null;
  const by = new Map<string, { n: number; doors: Map<string, number>; how: Map<string, number> }>();
  for (const o of openings) {
    if (!o.granted || !o.who) continue;
    const p = by.get(o.who) ?? { n: 0, doors: new Map(), how: new Map() };
    p.n += 1;
    p.doors.set(o.door, (p.doors.get(o.door) ?? 0) + 1);
    if (o.how) p.how.set(o.how, (p.how.get(o.how) ?? 0) + 1);
    by.set(o.who, p);
  }
  const most = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const ofWeek = !!week?.openings;
  const more = ofWeek ? week?.moreOpenings : s.moreOpenings;
  return people({
    id: 'people',
    title: 'Who came in',
    meta: `${ofWeek ? 'this week' : 'today'}${more ? ` · the newest ${OPENINGS_READ}` : ''}`,
    unit: ['time'],
    items: [...by]
      .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
      .map(([name, p]) => ({
        name,
        n: p.n,
        note: [most(p.doors), most(p.how)].filter(Boolean).join(' · '),
      })),
  });
}

/** The sentence under the name while it is fine. */
export function accessVerdict(s: AccessSnapshot): string {
  const n = s.doors.length;
  if (!n) return 'UniFi Access is fine.';
  const unlocked = s.doors.filter((d) => d.locked === false).length;
  if (!unlocked) return `UniFi Access is fine: ${n === 1 ? 'the door is' : `all ${n} doors are`} locked.`;
  return `UniFi Access is fine: ${unlocked} of ${n} ${n === 1 ? 'door is' : 'doors are'} unlocked.`;
}

export function accessView(
  s: AccessSnapshot,
  ctx: AccessCtx,
  bctx: ButtonCtx,
  week: AccessWeek | null = null,
): Pick<
  KindView,
  'kpis' | 'charts' | 'notices' | 'panels' | 'slots' | 'facts' | 'status' | 'machine' | 'verdict'
> {
  const more: KindView['panels'] = [];
  if (s.openings)
    more.push({
      kind: 'list',
      id: 'today',
      place: 'main',
      title: 'Today',
      meta: s.moreOpenings ? `the newest ${OPENINGS_READ}` : 'door openings',
      items: openingItems(s),
      empty: 'Nobody opened a door today.',
    });
  return {
    // In slots its counts are in In Access; the card keeps the figures (`accessSeen`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: accessNotices(s, ctx),
    ...slotPanels({
      live: accessLive(s, ctx, bctx),
      inventory: accessInventory(s, week),
      trend: accessTrend(s, week, ctx),
      people: whoCameIn(s, week),
      more,
    }),
    facts: facts(s),
    verdict: accessVerdict(s),
  };
}

/** “Open Access”: the console's Access app (the API's port 12445 left off). */
export function accessUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  const base = (row.fields.url ?? row.baseUrl).replace(/\/+$/, '').replace(/:12445$/, '');
  return `${base}/access/`;
}

export async function accessPage(ctx: KindCtx): Promise<KindView> {
  const [read, week] = await Promise.all([
    accessLatest(ctx.services, ctx.row, ctx.now, ctx.timeZone),
    accessWeek(ctx.services, ctx.row, ctx.now, ctx.timeZone),
  ]);
  const base: KindView = {
    notices: [],
    panels: [],
    tabs: [],
    facts: [],
    open: { label: 'Open Access', url: accessUrl(ctx.row) },
    actions: [],
    readAt: null,
    charts: [],
    machine: 'after',
    suggestions: ['Who opened the front door this week', 'Doors left open'],
    refreshing: read.refreshing,
  };
  if (!read.ok) return { ...base, problem: problemOf(read.error, NAME).message };
  const s = read.value;
  const view = accessView(
    s,
    { now: ctx.now, timeZone: ctx.timeZone, openSince: openSinceOf(ctx.row.id, s) },
    ctx,
    week,
  );
  return { ...base, ...view, readAt: s.readAt };
}

/** The card (SD-33): Doors, Openings today, from its own figures (the page in slots has none). */
export async function accessSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const s = await accessSnapshot(services, row, now, timeZone);
  const kpis = accessKpis(s).filter((k) => k.key === 'doors' || k.key === 'openings');
  const notices = accessNotices(s, { now, timeZone, openSince: openSinceOf(row.id, s) });
  return {
    glance: seenFromView({ kpis, notices }, { figures: 2 }),
    points: {},
    notices,
    skipped: accessSkipped(s),
  };
}

/* Buttons ------------------------------------------------------------------------------------------------------------ */

/**
 * One write as the connection; Access documents `PUT` for unlocking where some versions answer `POST`, so a 405 is tried
 * once more with `POST`. Its answer's code must be `SUCCESS`.
 */
async function accessWrite(
  services: Services,
  row: CatalogConnectionRow,
  path: string,
  body: unknown,
  methods: readonly ('PUT' | 'POST')[] = ['PUT'],
): Promise<void> {
  for (const [i, method] of methods.entries()) {
    let res: Awaited<ReturnType<typeof signedConnectionFetch>>;
    try {
      res = await externalEffect(
        'things.action',
        () =>
          signedConnectionFetch(
            services,
            row,
            {
              method,
              url: `${row.baseUrl.replace(/\/+$/, '')}${API}${path}`,
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify(body),
            },
            { maxBytes: 64 * 1024, deadlineMs: 15_000 },
          ),
        { refused: (err) => err instanceof ConnectionAuthError || err instanceof ConnectionChangedError },
      );
    } catch (err) {
      if (err instanceof ConnectionAuthError)
        throw conflict('UniFi Access needs you to sign in again first.');
      if (err instanceof VaultCallError && err.reason === 'timeout')
        throw new ApiError(
          'unavailable',
          'UniFi Access didn’t answer in time. Look again in a moment: it may have done it.',
        );
      throw new ApiError('unavailable', 'Whombat couldn’t reach UniFi Access just now.');
    }
    if (res.status === 405 && i < methods.length - 1) continue;
    if (res.status === 401 || res.status === 403)
      throw forbidden('UniFi Access refused: Whombat’s token may not do that.');
    let code: unknown = null;
    try {
      code = rec(JSON.parse(res.body.toString('utf8'))).code;
    } catch {
      code = null;
    }
    if (code === 'CODE_UNAUTHORIZED')
      throw forbidden(
        'UniFi Access refused: Whombat’s token lacks the permission to change doors (edit:space).',
      );
    if (res.status >= 400 || (code !== null && code !== 'SUCCESS'))
      throw new ApiError('unavailable', 'UniFi Access answered with an error and didn’t do it.');
    return;
  }
}

/** The door a button names, among the doors read now. */
async function doorOf(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
  target: unknown,
) {
  if (typeof target !== 'string' || !target) throw badRequest('Say which door.');
  let s: AccessSnapshot;
  try {
    s = await accessSnapshot(services, row, now, timeZone);
  } catch (err) {
    throw conflict(problemOf(err, NAME).message);
  }
  const d = s.doors.find((x) => x.id === target);
  if (!d) throw badRequest('UniFi Access has no such door any more.');
  return d;
}

/** Unlocks a door once (SD-33). */
const unlock: KindAction = async ({ services, row, now, timeZone }, { target }) => {
  const d = await doorOf(services, row, now, timeZone, target);
  await accessWrite(services, row, `/doors/${encodeURIComponent(d.id)}/unlock`, {}, ['PUT', 'POST']);
  return { message: `${d.name} is unlocked for a few seconds.`, title: clip(`Unlocked ${d.name}`, 200) };
};

/** Sets a door held open back to its schedule (SD-33): its lock rule `reset`. */
const schedule: KindAction = async ({ services, row, now, timeZone }, { target }) => {
  const d = await doorOf(services, row, now, timeZone, target);
  if (!heldOpen(d)) throw conflict(`${d.name} already follows its schedule.`);
  await accessWrite(services, row, `/doors/${encodeURIComponent(d.id)}/lock_rule`, { type: 'reset' });
  return {
    message: `${d.name} follows its schedule again.`,
    title: clip(`Set ${d.name} back to its schedule`, 200),
  };
};

export const ACCESS_ACTIONS: Record<string, KindAction> = { unlock, schedule };

export const ACCESS_KIND: KindModule = {
  page: accessPage,
  prefetch: (services, row, now, timeZone) => accessLatest(services, row, now, timeZone),
  seen: accessSeen,
  asksFirst: 'unlocking, lock rules and people ask first',
  actions: ACCESS_ACTIONS,
  checks: ACCESS_CHECKS,
};
