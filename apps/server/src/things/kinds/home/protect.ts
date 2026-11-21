/**
 * UniFi Protect's page (service-dashboards.md SD-32, SD-S15; service-slots.md): its integration API under
 * `<console>/proxy/protect/integration` with the connection's API key — `/v1/meta/info` (its version), `/v1/cameras`
 * (each camera's state and name), `/v1/nvrs` (the alarm's arm mode, the console's name), `/v1/arm-profiles` (only with
 * the local Alarm Manager), `/v1/sensors` and `/v1/lights` — kept 30 seconds; the detections Whombat kept from
 * Protect's event stream over the last 14 days (`protect-events.ts`).
 *
 * Its Summary in slots: Today (the alarm with Arm or Disarm, `POST /v1/arm-profiles/enable|disable`, confirmed, then
 * today's newest detections) beside In Protect (cameras, detections today, sensors, lights); the cameras as one row of
 * snapshots (`/v1/cameras/<id>/snapshot` through the image route, a fresh picture every 5 seconds; the page asks again
 * every 10 while open), offline ones greyed with since when Whombat saw them go; detections per day this week beside
 * “UniFi Protect itself” (its version, whether Whombat follows its detections). Cameras aren't people: no People.
 * Protect's API has no storage or recording days: not shown.
 */
import type { ThingLine, ThingPageBar, ThingPageItem, ThingPageKpi } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import { startOfLocalDay } from '../../../home/time';
import { conflict } from '../../../lib/errors';
import type { Services } from '../../../services';
import { imageRef, thingImage } from '../../images';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { clip, clock, dateOf, line, list, plural, rec, str, thousands, when } from '../../words';
import { actAs } from '../act';
import { cachedRead, getJson, KIND_DEADLINE_MS, latestRead, problemOf, withDeadline } from '../read';
import { type KindAction, type KindModule, type KindSeen, seenFromView } from '../registry';
import {
  countLine,
  dayKey,
  daysWith,
  type InventoryPanel,
  inventory,
  type LivePanel,
  lastDays,
  liveList,
  type ShelfPanel,
  shelf,
  slotPanels,
  type TrendPanel,
  trend,
  weekChange,
} from '../slots';
import type { KindCtx, KindView } from '../types';
import { itemLines, lineId, subjectName } from './lines';
import {
  type EventDays,
  eventDays,
  type FollowState,
  type KeptEvent,
  protectEventsFor,
  recentEvents,
} from './protect-events';
import { type ButtonCtx, button, type ThingGalleryItem, type ThingPageButton } from './shapes';

const NAME = 'UniFi Protect';
/** A page with cameras asks again this often (SD-09): snapshots stay fresh. */
export const PROTECT_REFRESH_S = 10;
const CAMERAS_MAX = 48;
/** Today's newest detections under the alarm in Today. */
const TODAY_MAX = 6;
/** The kept detections per day are counted again after this long (Detections today runs a minute behind at most). */
const DAYS_KEEP_MS = 60_000;
const DAY_MS = 86_400_000;

export interface ProtectCamera {
  id: string;
  name: string;
  /** `CONNECTED`, `CONNECTING`, `DISCONNECTED`. */
  state: string;
  /** A doorbell, by its model (“UVC G4 Doorbell Pro”). */
  doorbell?: boolean;
}

/** A door, window or motion sensor (UP Sense). */
export interface ProtectSensor {
  id: string;
  name: string;
  state: string;
  /** `door`, `window`, `garage`, `leak`, `none`. */
  mountType: string | null;
  /** Whether its door or window is open; null when it doesn't say. */
  opened: boolean | null;
  lowBattery: boolean;
}

/** A floodlight. */
export interface ProtectLight {
  id: string;
  name: string;
  state: string;
  on: boolean;
}

export interface ProtectSnapshot {
  readAt: Date;
  version: string | null;
  /** The console's name (“UNVR Pro”). */
  nvrName?: string | null;
  /** Null when Protect couldn't say (an older Protect, a key without them). */
  sensors?: ProtectSensor[] | null;
  lights?: ProtectLight[] | null;
  cameras: ProtectCamera[];
  /** The alarm: `disabled`, `arming`, `armed`, `breach`; null without one. */
  arm: { status: string; armedAt: Date | null; breachAt: Date | null } | null;
  /** How many alarm profiles there are (the local Alarm Manager); null when it can't say. */
  profiles: number | null;
  /** The NVR couldn't be read: whether the alarm goes off is unknown (QN-S21). */
  nvrUnread?: boolean;
}

/* Reading ------------------------------------------------------------------------------------------------------------ */

export function parseProtect(
  parts: {
    info: unknown;
    cameras: unknown;
    nvr: unknown;
    profiles: unknown;
    sensors?: unknown;
    lights?: unknown;
  },
  now: Date,
): ProtectSnapshot {
  const nvr = parts.nvr === null ? null : rec(Array.isArray(parts.nvr) ? parts.nvr[0] : parts.nvr);
  const mode = nvr ? rec(nvr.armMode) : null;
  return {
    readAt: now,
    version: str(rec(parts.info).applicationVersion),
    cameras: list(parts.cameras)
      .map(rec)
      .map((c) => ({
        id: str(c.id) ?? '',
        name: str(c.name) ?? 'Camera',
        state: str(c.state) ?? 'DISCONNECTED',
        ...(/doorbell/i.test(str(c.type) ?? '') ? { doorbell: true } : {}),
      }))
      .filter((c) => c.id),
    arm:
      mode && str(mode.status)
        ? {
            status: str(mode.status) as string,
            armedAt: dateOf(mode.armedAt),
            breachAt: dateOf(mode.breachDetectedAt),
          }
        : null,
    profiles: parts.profiles === null ? null : list(parts.profiles).length,
    nvrName: nvr ? (str(nvr.name) ?? null) : null,
    sensors:
      parts.sensors == null || !Array.isArray(parts.sensors)
        ? null
        : list(parts.sensors)
            .map(rec)
            .map((x) => ({
              id: str(x.id) ?? '',
              name: str(x.name) ?? 'Sensor',
              state: str(x.state) ?? 'DISCONNECTED',
              mountType: str(x.mountType),
              opened: typeof x.isOpened === 'boolean' ? x.isOpened : null,
              lowBattery: rec(x.batteryStatus).isLow === true,
            }))
            .filter((x) => x.id),
    lights:
      parts.lights == null || !Array.isArray(parts.lights)
        ? null
        : list(parts.lights)
            .map(rec)
            .map((x) => ({
              id: str(x.id) ?? '',
              name: str(x.name) ?? 'Light',
              state: str(x.state) ?? 'DISCONNECTED',
              on: x.isLightOn === true,
            }))
            .filter((x) => x.id),
    ...(parts.nvr === null ? { nvrUnread: true } : {}),
  };
}

const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

async function readProtect(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<ProtectSnapshot> {
  const get = (path: string) => getJson(services, row, NAME, path);
  const [info, cameras, nvr, profiles, sensors, lights] = await Promise.all([
    get('/v1/meta/info'),
    get('/v1/cameras'),
    optional(get('/v1/nvrs')),
    optional(get('/v1/arm-profiles')),
    optional(get('/v1/sensors')),
    optional(get('/v1/lights')),
  ]);
  return parseProtect({ info, cameras, nvr, profiles, sensors, lights }, now);
}

function loadProtect(services: Services, row: CatalogConnectionRow, now: Date) {
  return async () => {
    try {
      return await withDeadline(
        readProtect(services, row, now),
        KIND_DEADLINE_MS,
        'UniFi Protect didn’t answer in time.',
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

export const protectLatest = (services: Services, row: CatalogConnectionRow, now = services.clock()) =>
  latestRead(services, `protect:${row.id}`, row, loadProtect(services, row, now));

export const protectSnapshot = (services: Services, row: CatalogConnectionRow, now = services.clock()) =>
  cachedRead(services, `protect:${row.id}`, row, loadProtect(services, row, now));

/**
 * When Whombat first saw each camera offline (Protect's API doesn't say since when): per connection and camera, kept
 * while it stays offline. A camera already offline when the server started counts from its first read.
 */
const offlineSeen = new Map<string, Map<string, number>>();

export function offlineSinceOf(connectionId: string, s: ProtectSnapshot): Map<string, Date> {
  const seen = offlineSeen.get(connectionId) ?? new Map<string, number>();
  const out = new Map<string, Date>();
  for (const c of s.cameras) {
    if (c.state === 'CONNECTED') seen.delete(c.id);
    else {
      const at = Math.min(seen.get(c.id) ?? s.readAt.getTime(), s.readAt.getTime());
      seen.set(c.id, at);
      out.set(c.id, new Date(at));
    }
  }
  offlineSeen.set(connectionId, seen);
  return out;
}

/* What it means ------------------------------------------------------------------------------------------------------- */

const SMART: Record<string, string> = {
  person: 'Person',
  vehicle: 'Vehicle',
  animal: 'Animal',
  package: 'Package',
  licensePlate: 'Licence plate',
  face: 'Face',
  alrmSmoke: 'Smoke alarm',
  alrmCmonx: 'CO alarm',
  alrmSiren: 'Siren',
  alrmBabyCry: 'Baby crying',
  alrmSpeak: 'Someone speaking',
  alrmBark: 'Barking',
  alrmBurglar: 'Burglar alarm',
  alrmCarHorn: 'Car horn',
  alrmGlassBreak: 'Glass breaking',
};

/** “Person at Front door”, “Doorbell rang at Front door”, “Smoke alarm heard at Hall”. */
export function detectionWords(e: Pick<KeptEvent, 'kind' | 'title' | 'payload'>): string {
  if (e.kind === 'ring') return clip(`Doorbell rang at ${e.title}`, 160);
  const what = (e.payload.detected ?? []).map((d) => SMART[d] ?? d).filter(Boolean);
  const words = what.length
    ? what.slice(0, 2).join(' and ')
    : e.kind === 'smartAudioDetect'
      ? 'A sound'
      : 'Something';
  return clip(`${words} ${e.kind === 'smartAudioDetect' ? 'heard' : 'seen'} at ${e.title}`, 160);
}

const ALARM_WORDS: Record<string, string> = {
  disabled: 'Disarmed',
  arming: 'Arming',
  armed: 'Armed',
  breach: 'Alarm going off',
};

export interface ProtectCtx {
  now: Date;
  timeZone: string;
  /** The newest kept detections of the last 24 hours (at most 100). */
  events: KeptEvent[] | null;
  /** The kept detections counted per day over the last 14 days; null when the database couldn't say. */
  days?: EventDays | null;
  offlineSince: Map<string, Date>;
  follow: FollowState | null;
}

/** Detections and rings since the start of today: the database's count, else the newest 100 read. */
export function todayCounts(ctx: Pick<ProtectCtx, 'now' | 'timeZone' | 'events' | 'days'>): {
  all: number;
  rings: number;
} | null {
  const day = ctx.days?.days.get(dayKey(ctx.now, ctx.timeZone));
  if (ctx.days) return day ?? { all: 0, rings: 0 };
  if (!ctx.events) return null;
  const today = todayEvents(ctx.events, ctx.now, ctx.timeZone);
  return { all: today.length, rings: today.filter((e) => e.kind === 'ring').length };
}

/** The kept detections since the start of today, newest first. */
function todayEvents(events: readonly KeptEvent[], now: Date, timeZone: string): KeptEvent[] {
  const start = startOfLocalDay(now, timeZone).getTime();
  return events.filter((e) => e.at.getTime() >= start);
}

/** The four figures (SD-32): Cameras, Alarm, Detections today, Protect. In slots only the card shows them. */
export function protectKpis(s: ProtectSnapshot, ctx: ProtectCtx): ThingPageKpi[] {
  const online = s.cameras.filter((c) => c.state === 'CONNECTED').length;
  const off = s.cameras.length - online;
  const out: ThingPageKpi[] = [
    {
      key: 'cameras',
      label: 'Cameras',
      value: String(online),
      rest: `of ${s.cameras.length}`,
      ...(s.cameras.length ? { meter: online / s.cameras.length } : {}),
      ...(off
        ? { sub: `${off} offline`, tone: 'warn' as const }
        : { sub: 'all online', color: 'green' as const }),
    },
  ];
  if (s.arm)
    out.push({
      key: 'alarm',
      label: 'Alarm',
      value: ALARM_WORDS[s.arm.status] ?? s.arm.status,
      ...(s.arm.status === 'armed' && s.arm.armedAt
        ? { sub: `since ${when(s.arm.armedAt, ctx.now, ctx.timeZone)}` }
        : {}),
      ...(s.arm.status === 'breach' ? { tone: 'bad' as const } : {}),
    });
  const today = todayCounts(ctx);
  if (today)
    out.push({
      key: 'detections',
      label: 'Detections today',
      value: thousands(today.all),
      sub: 'people, vehicles, rings',
    });
  if (s.version) out.push({ key: 'version', label: 'Protect', value: s.version });
  return out;
}

const moment = (at: Date, now: Date, timeZone: string) => {
  const w = when(at, now, timeZone);
  return w.startsWith('Today ') ? clock(at, timeZone) : w;
};

/** Every check UniFi Protect raises (What Whombat watches, QN-15). */
export const PROTECT_CHECKS: readonly KindCheck[] = [
  { check: 'protect.alarm', name: 'The alarm going off', nature: 'you', perItem: false, startsOn: true },
  {
    check: 'protect.camera_offline',
    name: 'Cameras going offline',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  { check: 'protect.events', name: 'Following detections', nature: 'fyi', perItem: false, startsOn: false },
];

/** A camera reconnecting (a firmware update, a reboot) counts as offline only after this long (QN-04). */
export const CONNECTING_MS = 10 * 60_000;

/** Offline as Worth a look counts it: disconnected at once, reconnecting only after `CONNECTING_MS`. */
export function camerasOffline(
  s: ProtectSnapshot,
  ctx: Pick<ProtectCtx, 'now' | 'offlineSince'>,
): ProtectCamera[] {
  return s.cameras.filter((c) => {
    if (c.state === 'CONNECTED') return false;
    if (c.state !== 'CONNECTING') return true;
    const since = ctx.offlineSince.get(c.id);
    return !!since && ctx.now.getTime() - since.getTime() > CONNECTING_MS;
  });
}

const cameraSubject = (c: ProtectCamera) => ({
  id: `camera:${c.id}`.slice(0, 160),
  name: subjectName(c.name),
});

/**
 * “Worth a look” (SD-32, QN-01…QN-04): the alarm going off, only a person's (the head has Disarm), until the next
 * time it goes off; one line per camera offline, a problem after two passes in a row, one reconnecting only after 10
 * minutes; detections Whombat can't follow, a heads-up.
 */
export function protectNotices(s: ProtectSnapshot, ctx: ProtectCtx): KindNotice[] {
  const out: KindNotice[] = [];
  if (s.arm?.status === 'breach')
    out.push({
      id: 'breach',
      tone: 'bad',
      icon: 'warn',
      title: 'The alarm is going off',
      ...(s.arm.breachAt ? { detail: `Since ${moment(s.arm.breachAt, ctx.now, ctx.timeZone)}` } : {}),
      nature: 'you',
      check: 'protect.alarm',
      // Each time it goes off is its own: an Ignore lasts until it stops.
      ignore: { lifts: 'newer', words: 'Until the alarm stops.' },
      episode: s.arm.breachAt?.toISOString() ?? '',
      badge: 'Alarm going off',
    });
  const offline = camerasOffline(s, ctx).sort((a, b) => a.name.localeCompare(b.name));
  out.push(
    ...itemLines(
      offline,
      (c) => cameraSubject(c).id,
      (c) => {
        const since = ctx.offlineSince.get(c.id);
        const title = clip(`${c.name} is offline`, 120);
        return {
          id: lineId('camera-offline', c.id),
          tone: 'warn',
          icon: 'camera',
          title,
          ...(since
            ? {
                detail: `${c.state === 'CONNECTING' ? 'Reconnecting since' : 'Since'} ${moment(since, ctx.now, ctx.timeZone)}`,
              }
            : {}),
          link: {
            kind: 'ask',
            label: 'Look into it',
            question: clip(`Why is my camera ${c.name} offline in UniFi Protect?`, 300),
          },
          nature: 'problem',
          check: 'protect.camera_offline',
          subject: cameraSubject(c),
          ignore: { lifts: 'fixed', words: 'Until it’s back online.' },
          confirm: 2,
          ...(title.length > 40 ? { badge: 'A camera is offline' } : {}),
        };
      },
      (more, subject, episode) => ({
        id: 'camera-offline-more',
        tone: 'warn',
        icon: 'camera',
        title: `${plural(more.length, 'more camera', 'more cameras')} offline`,
        detail: clip(more.map((c) => c.name).join(' · '), 200),
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: 'Why are some of my UniFi Protect cameras offline?',
        },
        nature: 'problem',
        check: 'protect.camera_offline',
        subject,
        episode,
        ignore: { lifts: 'newer', words: 'Until the list changes.' },
        confirm: 2,
        badge: 'Cameras are offline',
      }),
    ),
  );
  const failing = ctx.follow?.failingSince;
  if (failing && ctx.now.getTime() - failing.getTime() > 5 * 60_000)
    out.push({
      id: 'events',
      tone: 'info',
      icon: 'network',
      title: 'Whombat can’t follow Protect’s detections just now',
      detail: `Since ${moment(failing, ctx.now, ctx.timeZone)}: what the cameras see meanwhile isn’t counted.`,
      nature: 'fyi',
      check: 'protect.events',
      ignore: { lifts: 'fixed', words: 'Until Whombat follows them again.' },
    });
  return out;
}

/** The checks this read couldn't see (QN-S21): the NVR (the alarm), the event follower before it started. */
export function protectSkipped(s: ProtectSnapshot, ctx: Pick<ProtectCtx, 'follow'>): string[] {
  const out: string[] = [];
  if (s.nvrUnread) out.push('protect.alarm');
  if (!ctx.follow) out.push('protect.events');
  return out;
}

/** Each camera's last ring of the kept ones (newest first): a camera that rang is a doorbell. */
function lastRings(events: readonly KeptEvent[] | null): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const e of events ?? [])
    if (e.kind === 'ring' && e.device && !out.has(e.device)) out.set(e.device, e.at);
  return out;
}

/** “Rang at 14:02”, “Rang yesterday at 21:40”, “Hasn’t rung today”; null when the rings aren't followed. */
export function ringWords(
  at: Date | undefined,
  ctx: Pick<ProtectCtx, 'now' | 'timeZone' | 'events'>,
): string | null {
  if (!ctx.events) return null;
  const today = startOfLocalDay(ctx.now, ctx.timeZone).getTime();
  if (!at) return 'Hasn’t rung today';
  return at.getTime() >= today
    ? `Rang at ${clock(at, ctx.timeZone)}`
    : `Rang yesterday at ${clock(at, ctx.timeZone)}`;
}

/**
 * The cameras as snapshots (SD-32): online ones first with a fresh picture, the doorbells first of those with when they
 * last rang, offline ones greyed.
 */
export function cameraItems(
  s: ProtectSnapshot,
  ctx: ProtectCtx,
  picture: (cameraId: string, alt: string) => ThingGalleryItem['image'],
  openUrl: string | null,
): ThingGalleryItem[] {
  const rings = lastRings(ctx.events);
  const bell = (c: ProtectCamera) => !!c.doorbell || rings.has(c.id);
  return s.cameras
    .slice()
    .sort(
      (a, b) =>
        Number(a.state !== 'CONNECTED') - Number(b.state !== 'CONNECTED') ||
        Number(!bell(a)) - Number(!bell(b)) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, CAMERAS_MAX)
    .map((c) => {
      const online = c.state === 'CONNECTED';
      const since = ctx.offlineSince.get(c.id);
      const image = online ? picture(c.id, c.name) : undefined;
      const rang = online && bell(c) ? ringWords(rings.get(c.id), ctx) : null;
      return {
        id: c.id.slice(0, 200),
        title: clip(c.name, 120),
        // Under the picture: when the doorbell last rang (a shelf draws `sub`).
        ...(online
          ? rang
            ? { sub: rang }
            : {}
          : {
              sub:
                c.state === 'CONNECTING'
                  ? 'Connecting'
                  : since
                    ? `Offline since ${moment(since, ctx.now, ctx.timeZone)}`
                    : 'Offline',
              badge: { text: c.state === 'CONNECTING' ? 'Connecting' : 'Offline', tone: 'warn' as const },
              muted: true,
            }),
        ...(image ? { image } : {}),
        ...(openUrl ? { url: openUrl } : {}),
      };
    });
}

/** Detections as lines, newest first. */
export function detectionItems(events: readonly KeptEvent[], max = 50): ThingPageItem[] {
  return events.slice(0, max).map((e) => ({
    id: e.eventId.slice(0, 200),
    title: detectionWords(e),
    at: e.at.toISOString(),
    icon: e.kind === 'ring' ? ('door' as const) : ('camera' as const),
    ...(e.kind === 'ring' ? { tone: 'info' as const } : {}),
  }));
}

/** Arm or Disarm on the alarm's line, confirmed, when an alarm profile exists. */
export function armButtons(s: ProtectSnapshot, bctx: ButtonCtx): ThingPageButton[] {
  if (!s.arm || !s.profiles) return [];
  if (s.arm.status === 'disabled')
    return [
      button(bctx, {
        action: 'arm',
        label: 'Arm',
        icon: 'shield',
        confirm: {
          title: 'Arm the alarm?',
          body: 'UniFi Protect arms its alarm with the profile chosen in Protect. Motion then sets it off.',
          button: 'Arm',
        },
      }),
    ];
  return [
    button(bctx, {
      action: 'disarm',
      label: 'Disarm',
      icon: 'shield',
      tone: 'danger',
      confirm: {
        title: 'Disarm the alarm?',
        body: 'UniFi Protect disarms its alarm right away.',
        button: 'Disarm',
      },
    }),
  ];
}

function facts(s: ProtectSnapshot): ThingLine[] {
  const out: ThingLine[] = [];
  if (s.version) out.push(line(`Protect **${s.version}**`));
  if (s.arm) out.push(line(`Alarm **${(ALARM_WORDS[s.arm.status] ?? s.arm.status).toLowerCase()}**`));
  return out;
}

/** “Open Protect”: the console's Protect app. */
export function protectUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  const base = (row.fields.url ?? row.baseUrl.replace(/\/proxy\/protect\/integration\/?$/, '')).replace(
    /\/+$/,
    '',
  );
  return `${base}/protect/dashboard`;
}

/** The alarm's words for its line: what it does now. */
function alarmDetail(arm: NonNullable<ProtectSnapshot['arm']>, ctx: ProtectCtx): string {
  if (arm.status === 'breach')
    return arm.breachAt ? `Going off since ${moment(arm.breachAt, ctx.now, ctx.timeZone)}` : 'Going off now';
  if (arm.status === 'armed')
    return arm.armedAt
      ? `Armed since ${moment(arm.armedAt, ctx.now, ctx.timeZone)} · motion sets it off`
      : 'Motion sets it off';
  if (arm.status === 'arming') return 'Arms after its delay';
  return 'Motion doesn’t set it off';
}

/**
 * Live, “Today”: the alarm first with Arm or Disarm (its figure keeps a desk's Alarm), then today's newest detections.
 * Left out without an alarm and without detections followed.
 */
export function protectLive(s: ProtectSnapshot, ctx: ProtectCtx, bctx: ButtonCtx): LivePanel | null {
  const items: ThingPageItem[] = [];
  if (s.arm) {
    const words = ALARM_WORDS[s.arm.status] ?? s.arm.status;
    const breach = s.arm.status === 'breach';
    const actions = armButtons(s, bctx);
    items.push({
      id: 'alarm',
      title: 'Alarm',
      icon: 'shield',
      detail: clip(alarmDetail(s.arm, ctx), 300),
      right: clip(words, 40),
      figure: { value: clip(words, 20), ...(breach ? { tone: 'bad' as const } : {}) },
      ...(breach ? { tone: 'bad' as const } : s.arm.status === 'armed' ? { tone: 'ok' as const } : {}),
      ...(actions.length ? { actions } : {}),
    });
  }
  const counts = todayCounts(ctx);
  if (ctx.events) items.push(...detectionItems(todayEvents(ctx.events, ctx.now, ctx.timeZone), TODAY_MAX));
  if (!items.length && !ctx.events) return null;
  return liveList({
    id: 'detections',
    title: 'Today',
    ...(counts
      ? {
          meta: counts.all
            ? [plural(counts.all, 'detection'), counts.rings ? plural(counts.rings, 'ring') : '']
                .filter(Boolean)
                .join(' · ')
            : 'Nothing seen today',
        }
      : {}),
    items,
    empty: 'Nothing seen today.',
  });
}

/** The camera that saw the most today (of the newest read), for Detections today's line. */
function busiestToday(ctx: ProtectCtx): string | null {
  const by = new Map<string, number>();
  for (const e of todayEvents(ctx.events ?? [], ctx.now, ctx.timeZone))
    by.set(e.title, (by.get(e.title) ?? 0) + 1);
  const top = [...by].sort((a, b) => b[1] - a[1])[0];
  return top && by.size > 1 ? top[0] : null;
}

/** Inventory, “In Protect”: the cameras (offline ones amber), today's detections and rings, the sensors and lights. */
export function protectInventory(
  s: ProtectSnapshot,
  ctx: ProtectCtx,
  openUrl: string | null,
): InventoryPanel | null {
  const items: ThingPageItem[] = [];
  const url = openUrl ? { url: openUrl } : {};
  const off = camerasOffline(s, ctx).length;
  const bells = s.cameras.filter((c) => c.doorbell).length;
  items.push(
    countLine({
      id: 'cameras',
      title: 'Cameras',
      icon: 'camera',
      value: thousands(s.cameras.length),
      ...(bells ? { detail: plural(bells, 'doorbell') } : {}),
      ...(!s.cameras.length
        ? {}
        : off
          ? { note: `${off} offline`, noteTone: 'warn' as const }
          : { note: 'All online', noteTone: 'ok' as const }),
      ...url,
    }),
  );
  const today = todayCounts(ctx);
  if (today) {
    const busiest = busiestToday(ctx);
    items.push(
      countLine({
        id: 'detections-today',
        title: 'Detections today',
        icon: 'camera',
        value: thousands(today.all),
        ...(busiest ? { detail: `Most at ${busiest}` } : {}),
        ...(today.rings ? { note: plural(today.rings, 'ring') } : bells ? { note: 'No rings' } : {}),
      }),
    );
  }
  if (s.sensors?.length) {
    const offline = s.sensors.filter((x) => x.state !== 'CONNECTED').length;
    const low = s.sensors.filter((x) => x.lowBattery).length;
    const doors = s.sensors.filter(
      (x) => x.opened !== null && x.mountType !== 'leak' && x.mountType !== 'none',
    );
    const open = doors.filter((x) => x.opened).length;
    items.push(
      countLine({
        id: 'sensors',
        title: 'Sensors',
        icon: 'device',
        value: thousands(s.sensors.length),
        ...(open ? { detail: `${open} open` } : doors.length ? { detail: 'All closed' } : {}),
        ...(offline
          ? { note: `${offline} offline`, noteTone: 'warn' as const }
          : low
            ? { note: plural(low, 'low battery', 'low batteries'), noteTone: 'warn' as const }
            : { note: 'All connected' }),
        ...url,
      }),
    );
  }
  if (s.lights?.length) {
    const offline = s.lights.filter((x) => x.state !== 'CONNECTED').length;
    const on = s.lights.filter((x) => x.on).length;
    items.push(
      countLine({
        id: 'lights',
        title: 'Lights',
        icon: 'power',
        value: thousands(s.lights.length),
        ...(offline
          ? { note: `${offline} offline`, noteTone: 'warn' as const }
          : { note: on ? `${on} on` : 'All off' }),
        ...url,
      }),
    );
  }
  return inventory({ id: 'inventory', title: 'In Protect', items });
}

/** Shelf: every camera's snapshot in one row, online ones first; a link to all of them in Protect when there are many. */
export function protectShelf(
  s: ProtectSnapshot,
  ctx: ProtectCtx,
  opts: { picture: (cameraId: string, alt: string) => ThingGalleryItem['image']; openUrl: string | null },
): ShelfPanel | null {
  if (!s.cameras.length) return null;
  const online = s.cameras.filter((c) => c.state === 'CONNECTED').length;
  return shelf({
    id: 'cameras',
    title: 'Cameras',
    meta:
      online === s.cameras.length
        ? `All ${s.cameras.length} online`
        : `${online} of ${s.cameras.length} online`,
    shape: 'wide',
    items: cameraItems(s, ctx, opts.picture, opts.openUrl),
    ...(opts.openUrl && s.cameras.length > 4
      ? { link: { kind: 'url' as const, label: 'All cameras in Protect', url: opts.openUrl } }
      : {}),
    empty: 'No cameras in UniFi Protect yet.',
  });
}

/**
 * Trend, “This week”: detections per day over the last 7 days, and the change on the 7 before once Whombat followed
 * that long. Days before the oldest kept detection weren't followed: no bar. Left out under 2 days.
 */
export function protectTrend(ctx: ProtectCtx): TrendPanel | null {
  if (!ctx.days) return null;
  const days = lastDays(ctx.now, ctx.timeZone, 7);
  const before = lastDays(new Date(ctx.now.getTime() - 7 * DAY_MS), ctx.timeZone, 7);
  const firstDay = ctx.days.oldest ? dayKey(ctx.days.oldest, ctx.timeZone) : null;
  const count = (k: string) => (firstDay && k >= firstDay ? (ctx.days?.days.get(k)?.all ?? 0) : null);
  const values = days.keys.map(count);
  if (daysWith(values) < 2) return null;
  const total = values.reduce<number>((a, b) => a + (b ?? 0), 0);
  // The week before counts only when Whombat followed all of it.
  const whole = firstDay !== null && firstDay <= (before.keys[0] as string);
  const prior = whole ? before.keys.reduce((a, k) => a + (count(k) ?? 0), 0) : 0;
  return trend({
    id: 'week',
    title: 'This week',
    meta: daysWith(values) < 7 ? 'Detections per day, since Whombat follows them' : 'Detections per day',
    days,
    values,
    label: 'Detections',
    color: 'violet',
    figure: { value: thousands(total), rest: total === 1 ? 'detection' : 'detections' },
    change: whole ? weekChange(total, prior) : null,
    changeWords: ' on last week',
  });
}

/** Its own lines in “UniFi Protect itself”: its version on its console, and whether Whombat follows its detections. */
export function protectMachineLines(s: ProtectSnapshot, ctx: ProtectCtx): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  if (s.version)
    out.push({
      id: 'protect-version',
      label: 'Protect',
      value: clip(s.version, 40),
      pct: null,
      ...(s.nvrName ? { sub: clip(`On ${s.nvrName}`, 120) } : {}),
    });
  if (ctx.follow) {
    const failing = ctx.follow.failingSince;
    out.push({
      id: 'protect-follow',
      label: 'Detections',
      value: ctx.follow.connected ? 'Followed live' : 'Not followed now',
      pct: null,
      ...(ctx.follow.connected
        ? { sub: 'Whombat keeps two weeks of them', subTone: 'ok' as const }
        : failing
          ? { sub: clip(`Since ${moment(failing, ctx.now, ctx.timeZone)}`, 120), subTone: 'warn' as const }
          : {}),
    });
  }
  return out;
}

/** The sentence under the name while it is fine. */
export function protectVerdict(s: ProtectSnapshot): string {
  const parts: string[] = [];
  const n = s.cameras.length;
  const online = s.cameras.filter((c) => c.state === 'CONNECTED').length;
  if (n)
    parts.push(
      online === n
        ? n === 1
          ? 'the camera is online'
          : `all ${n} cameras are online`
        : `${online} of ${n} cameras are online`,
    );
  if (s.arm?.status === 'armed') parts.push('the alarm is armed');
  return parts.length ? `UniFi Protect is fine: ${parts.join(' and ')}.` : 'UniFi Protect is fine.';
}

export function protectView(
  s: ProtectSnapshot,
  ctx: ProtectCtx,
  opts: {
    buttons: ButtonCtx;
    picture: (cameraId: string, alt: string) => ThingGalleryItem['image'];
    openUrl: string;
  },
): Pick<
  KindView,
  'kpis' | 'charts' | 'notices' | 'panels' | 'slots' | 'facts' | 'status' | 'machine' | 'refreshS' | 'verdict'
> & {
  buttons: ThingPageButton[];
} {
  return {
    // In slots its counts are in Today and In Protect; the card keeps the figures (`protectSeen`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: protectNotices(s, ctx),
    ...slotPanels({
      live: protectLive(s, ctx, opts.buttons),
      inventory: protectInventory(s, ctx, opts.openUrl),
      shelf: protectShelf(s, ctx, opts),
      trend: protectTrend(ctx),
      machine: protectMachineLines(s, ctx),
    }),
    facts: facts(s),
    refreshS: PROTECT_REFRESH_S,
    verdict: protectVerdict(s),
    // Arm and Disarm are on the alarm's line in Today.
    buttons: [],
  };
}

/** The kept detections per day over the last 14 days, counted again every minute; null when the database can't say. */
function protectDays(ctx: Pick<KindCtx, 'services' | 'row' | 'now' | 'timeZone'>): Promise<EventDays | null> {
  const { services, row, now, timeZone } = ctx;
  return cachedRead(
    services,
    `protect-days:${row.id}:${timeZone}`,
    row,
    () => eventDays(services.db, row.id, new Date(now.getTime() - 15 * DAY_MS), timeZone),
    DAYS_KEEP_MS,
  ).catch(() => null);
}

export async function protectPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const [read, events, days] = await Promise.all([
    protectLatest(services, row, now),
    recentEvents(services.db, row.id, new Date(now.getTime() - 24 * 3600_000)).catch(() => null),
    protectDays(ctx),
  ]);
  const openUrl = protectUrl(row);
  const base: KindView = {
    notices: [],
    panels: [],
    tabs: [],
    facts: [],
    open: { label: 'Open Protect', url: openUrl },
    actions: [],
    readAt: null,
    charts: [],
    machine: 'after',
    suggestions: ['Detections this week', 'Which cameras went offline'],
    refreshing: read.refreshing,
  };
  if (!read.ok) return { ...base, problem: problemOf(read.error, NAME).message };
  const s = read.value;
  const view = protectView(
    s,
    {
      now,
      timeZone: ctx.timeZone,
      events,
      days,
      offlineSince: offlineSinceOf(row.id, s),
      follow: protectEventsFor(services).stateOf(row.id),
    },
    {
      buttons: ctx,
      openUrl,
      picture: (cameraId, alt) =>
        thingImage(
          imageRef(ctx, {
            path: `/v1/cameras/${encodeURIComponent(cameraId)}/snapshot?highQuality=false`,
            snapshot: true,
          }),
          alt,
          'wide',
        ),
    },
  );
  return { ...base, ...view, readAt: s.readAt };
}

/** The card (SD-32): Cameras, Detections today, from its own figures (the page in slots has none). */
export async function protectSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const [s, events, days] = await Promise.all([
    protectSnapshot(services, row, now),
    recentEvents(services.db, row.id, new Date(now.getTime() - 24 * 3600_000)).catch(() => null),
    protectDays({ services, row, now, timeZone }),
  ]);
  const ctx: ProtectCtx = {
    now,
    timeZone,
    events,
    days,
    offlineSince: offlineSinceOf(row.id, s),
    follow: protectEventsFor(services).stateOf(row.id),
  };
  const kpis = protectKpis(s, ctx).filter((k) => k.key === 'cameras' || k.key === 'detections');
  const notices = protectNotices(s, ctx);
  return {
    glance: seenFromView(
      { kpis, notices },
      { figures: 2, ...(s.version ? { line: `UniFi Protect ${s.version}` } : {}) },
    ),
    points: {},
    notices,
    skipped: protectSkipped(s, ctx),
  };
}

/* Buttons ------------------------------------------------------------------------------------------------------------ */

/** Arms or disarms Protect's alarm with its selected profile (local Alarm Manager only). */
function alarm(enable: boolean): KindAction {
  return async ({ services, row, now }) => {
    const s = await protectSnapshot(services, row, now).catch(() => null);
    if (s && (!s.arm || !s.profiles))
      throw conflict('UniFi Protect has no alarm profile to arm. Set one up in Protect.');
    await actAs(services, row, NAME, {
      method: 'POST',
      path: `/v1/arm-profiles/${enable ? 'enable' : 'disable'}`,
    });
    return enable
      ? {
          message: 'Arming the alarm. Protect arms it after its delay.',
          title: 'Armed the alarm in UniFi Protect',
        }
      : { message: 'The alarm is disarmed.', title: 'Disarmed the alarm in UniFi Protect' };
  };
}

export const PROTECT_ACTIONS: Record<string, KindAction> = { arm: alarm(true), disarm: alarm(false) };

export const PROTECT_KIND: KindModule = {
  page: protectPage,
  prefetch: (services, row, now) => protectLatest(services, row, now),
  seen: protectSeen,
  asksFirst: 'the alarm, doors and gates ask first',
  actions: PROTECT_ACTIONS,
  checks: PROTECT_CHECKS,
};
