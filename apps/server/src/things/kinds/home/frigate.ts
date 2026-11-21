/**
 * Frigate's page and card: cameras with live snapshots (`/api/<camera>/latest.jpg?h=360` through the signed image
 * route, refreshed every 10 seconds while open), today's detections (`/api/events`), detections per day this week
 * (`/api/events/summary`), detector inference speeds and recordings storage (`/api/stats`). Never reads `/api/config`
 * so camera RTSP credentials are never fetched.
 */
import type { ThingLine, ThingPageBar, ThingPageItem, ThingPageKpi } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import { startOfLocalDay } from '../../../home/time';
import type { Services } from '../../../services';
import { imageRef, thingImage } from '../../images';
import type { KindCheck, KindNotice } from '../../quiet/types';
import {
  bytes,
  clip,
  clock,
  dateOf,
  line,
  list,
  num,
  pct,
  plural,
  rec,
  span,
  str,
  thousands,
  when,
} from '../../words';
import { cachedRead, getJson, KIND_DEADLINE_MS, latestRead, problemOf, withDeadline } from '../read';
import { type KindModule, type KindSeen, seenFromView } from '../registry';
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
import type { ThingGalleryItem } from './shapes';

const NAME = 'Frigate';
/** Refresh interval for camera snapshots while the page is open. */
export const FRIGATE_REFRESH_S = 10;
const CAMERAS_MAX = 48;
const TODAY_MAX = 6;
const SUMMARY_KEEP_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const MIB = 1024 ** 2;
const DETECTOR_SLOW_MS = 100;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface FrigateCamera {
  id: string;
  name: string;
  online: boolean;
  cameraFps: number;
  detectionFps: number;
  skippedFps: number;
}

export interface FrigateDetector {
  name: string;
  inferenceMs: number;
}

export interface FrigateStorage {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

export interface FrigateEvent {
  id: string;
  camera: string;
  cameraName: string;
  label: string;
  subLabel: string | null;
  at: Date;
  score: number | null;
  zones: string[];
}

export interface FrigateSummaryRow {
  day: string;
  camera: string;
  label: string;
  count: number;
}

export interface FrigateSnapshot {
  readAt: Date;
  version: string | null;
  uptimeSeconds: number | null;
  cameras: FrigateCamera[];
  detectors: FrigateDetector[];
  storage: FrigateStorage | null;
}

/** Turns a Frigate camera slug (`front_door`) into readable words (`Front door`). */
export function prettyCameraName(slug: string): string {
  const words = slug.replace(/[_-]+/g, ' ').trim();
  if (!words) return 'Camera';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function prettyLabel(label: string): string {
  const clean = label.replace(/[_-]+/g, ' ').trim();
  if (!clean) return 'Something';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** `/api/stats`. */
export function parseStats(body: unknown, now: Date): FrigateSnapshot {
  const b = rec(body);
  const service = rec(b.service);
  const camerasObj = rec(b.cameras);
  const cameras: FrigateCamera[] = [];
  for (const [id, raw] of Object.entries(camerasObj).slice(0, CAMERAS_MAX)) {
    const c = rec(raw);
    const cameraFps = Math.max(0, num(c.camera_fps) ?? 0);
    const detectionFps = Math.max(0, num(c.detection_fps) ?? 0);
    const skippedFps = Math.max(0, num(c.skipped_fps) ?? 0);
    cameras.push({
      id: id.slice(0, 80),
      name: prettyCameraName(id).slice(0, 80),
      online: cameraFps > 0,
      cameraFps,
      detectionFps,
      skippedFps,
    });
  }
  const detectorsObj = rec(b.detectors);
  const detectors: FrigateDetector[] = [];
  for (const [name, raw] of Object.entries(detectorsObj).slice(0, 16)) {
    const d = rec(raw);
    const ms = num(d.inference_speed);
    if (ms !== null && ms >= 0) detectors.push({ name: name.slice(0, 40), inferenceMs: ms });
  }
  const storageObj = rec(service.storage);
  const recMount =
    Object.entries(storageObj).find(([k]) => k.includes('recordings')) ??
    Object.entries(storageObj).find(([k]) => k.includes('media/frigate'));
  let storage: FrigateStorage | null = null;
  if (recMount) {
    const [mount, raw] = recMount;
    const m = rec(raw);
    const totalMb = num(m.total);
    const usedMb = num(m.used);
    const freeMb = num(m.free);
    if (totalMb !== null && totalMb > 0 && freeMb !== null && freeMb >= 0) {
      const totalBytes = Math.round(totalMb * MIB);
      const freeBytes = Math.round(freeMb * MIB);
      const usedBytes =
        usedMb !== null && usedMb >= 0 ? Math.round(usedMb * MIB) : Math.max(0, totalBytes - freeBytes);
      storage = { mount, totalBytes, usedBytes, freeBytes };
    }
  }
  return {
    readAt: now,
    version: str(service.version)?.replace(/-.*$/, '') ?? null,
    uptimeSeconds: num(service.uptime),
    cameras,
    detectors,
    storage,
  };
}

/** `/api/events`. */
export function parseEvents(body: unknown): FrigateEvent[] {
  return list(body)
    .slice(0, 50)
    .map((raw): FrigateEvent | null => {
      const e = rec(raw);
      const id = str(e.id);
      const camera = str(e.camera);
      const label = str(e.label);
      const at = dateOf(num(e.start_time));
      if (!id || !camera || !label || !at) return null;
      const sub = Array.isArray(e.sub_label) ? str(e.sub_label[0]) : str(e.sub_label);
      return {
        id: id.slice(0, 120),
        camera: camera.slice(0, 80),
        cameraName: prettyCameraName(camera).slice(0, 80),
        label: label.slice(0, 40),
        subLabel: sub?.slice(0, 60) ?? null,
        at,
        score: num(e.top_score),
        zones: list(e.zones)
          .map(str)
          .filter((z): z is string => z !== null)
          .slice(0, 5),
      };
    })
    .filter((e): e is FrigateEvent => e !== null);
}

/** `/api/events/summary`. */
export function parseSummary(body: unknown): FrigateSummaryRow[] {
  return list(body)
    .slice(0, 2000)
    .map((raw): FrigateSummaryRow | null => {
      const r = rec(raw);
      const day = str(r.day);
      const count = num(r.count);
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || count === null || count < 0) return null;
      return {
        day,
        camera: str(r.camera) ?? '',
        label: str(r.label) ?? '',
        count,
      };
    })
    .filter((r): r is FrigateSummaryRow => r !== null);
}

const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

async function readStats(services: Services, row: CatalogConnectionRow, now: Date): Promise<FrigateSnapshot> {
  return parseStats(await getJson(services, row, NAME, '/api/stats'), now);
}

function loadStats(services: Services, row: CatalogConnectionRow, now: Date) {
  return async () => {
    try {
      return await withDeadline(
        readStats(services, row, now),
        KIND_DEADLINE_MS,
        'Frigate didn’t answer in time.',
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

export const frigateLatest = (services: Services, row: CatalogConnectionRow, now = services.clock()) =>
  latestRead(services, `frigate:${row.id}`, row, loadStats(services, row, now));

export const frigateSnapshot = (services: Services, row: CatalogConnectionRow, now = services.clock()) =>
  cachedRead(services, `frigate:${row.id}`, row, loadStats(services, row, now));

async function readTodayEvents(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<FrigateEvent[] | null> {
  const after = String(Math.floor(startOfLocalDay(now, timeZone).getTime() / 1000));
  return optional(getJson(services, row, NAME, '/api/events', { limit: '20', after }).then(parseEvents));
}

async function readSummary(
  services: Services,
  row: CatalogConnectionRow,
): Promise<FrigateSummaryRow[] | null> {
  return optional(
    cachedRead(
      services,
      `frigate-summary:${row.id}`,
      row,
      async () => parseSummary(await getJson(services, row, NAME, '/api/events/summary')),
      SUMMARY_KEEP_MS,
    ),
  );
}

/* Offline camera tracking -------------------------------------------------------------------------------------------- */

const offlineSeen = new Map<string, Map<string, number>>();

/** Remembers when each camera first stopped sending frames (Frigate's stats don't include an offline timestamp). */
export function offlineSinceOf(connectionId: string, s: FrigateSnapshot): Map<string, Date> {
  const seen = offlineSeen.get(connectionId) ?? new Map<string, number>();
  const out = new Map<string, Date>();
  for (const c of s.cameras) {
    if (c.online) seen.delete(c.id);
    else {
      const at = Math.min(seen.get(c.id) ?? s.readAt.getTime(), s.readAt.getTime());
      seen.set(c.id, at);
      out.set(c.id, new Date(at));
    }
  }
  offlineSeen.set(connectionId, seen);
  return out;
}

/* Checks and notices ------------------------------------------------------------------------------------------------- */

export const FRIGATE_CHECKS: readonly KindCheck[] = [
  {
    check: 'frigate.camera_offline',
    name: 'Cameras going offline',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'frigate.storage_full',
    name: 'Recordings disk filling up',
    nature: 'problem',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'frigate.detector_slow',
    name: 'Slow object detector',
    nature: 'fyi',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'frigate.skipped_fps',
    name: 'Cameras dropping frames',
    nature: 'fyi',
    perItem: true,
    startsOn: false,
  },
];

export function frigateSkipped(s: FrigateSnapshot): string[] {
  const out: string[] = [];
  if (!s.storage) out.push('frigate.storage_full');
  if (!s.detectors.length) out.push('frigate.detector_slow');
  return out;
}

export interface FrigateCtx {
  now: Date;
  timeZone: string;
  events: FrigateEvent[] | null;
  summary: FrigateSummaryRow[] | null;
  offlineSince: Map<string, Date>;
}

const moment = (at: Date, now: Date, timeZone: string) => {
  const w = when(at, now, timeZone);
  return w.startsWith('Today ') ? clock(at, timeZone) : w;
};

export function frigateNotices(s: FrigateSnapshot, ctx: FrigateCtx): KindNotice[] {
  const out: KindNotice[] = [];
  const offline = s.cameras.filter((c) => !c.online).sort((a, b) => a.name.localeCompare(b.name));
  out.push(
    ...itemLines(
      offline,
      (c) => `camera:${c.id}`,
      (c) => {
        const since = ctx.offlineSince.get(c.id);
        const title = clip(`${c.name} is offline`, 120);
        return {
          id: lineId('camera-offline', c.id),
          tone: 'warn',
          icon: 'camera',
          title,
          detail: since
            ? `No frames received since ${moment(since, ctx.now, ctx.timeZone)}. Check the camera’s power and network.`
            : 'No frames received from this camera. Check its power and network.',
          link: {
            kind: 'ask',
            label: 'Look into it',
            question: clip(`Why is my camera ${c.name} offline in Frigate?`, 300),
          },
          nature: 'problem',
          check: 'frigate.camera_offline',
          subject: { id: `camera:${c.id}`.slice(0, 160), name: subjectName(c.name) },
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
          question: 'Why are some of my Frigate cameras offline?',
        },
        nature: 'problem',
        check: 'frigate.camera_offline',
        subject,
        episode,
        ignore: { lifts: 'newer', words: 'Until the list changes.' },
        confirm: 2,
        badge: 'Cameras are offline',
      }),
    ),
  );
  if (s.storage && s.storage.totalBytes > 0) {
    const usedRatio = s.storage.usedBytes / s.storage.totalBytes;
    if (usedRatio >= 0.9) {
      const bad = usedRatio >= 0.95;
      out.push({
        id: 'storage-full',
        tone: bad ? 'bad' : 'warn',
        icon: 'disk',
        title: `Frigate recordings disk is ${pct(usedRatio * 100)} full`,
        detail: `${bytes(s.storage.freeBytes)} free. Shorten recording retention or free space so Frigate keeps recording.`,
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: 'Frigate’s recordings disk is nearly full. How should I free space or trim retention?',
        },
        nature: 'problem',
        check: 'frigate.storage_full',
        band: bad ? 95 : 90,
        ignore: { lifts: 'fixed', words: 'Until there’s more room.' },
        badge: `Disk ${pct(usedRatio * 100)} full`,
      });
    }
  }
  const slow = s.detectors.filter((d) => d.inferenceMs > DETECTOR_SLOW_MS);
  out.push(
    ...itemLines(
      slow,
      (d) => `detector:${d.name}`,
      (d) => ({
        id: lineId('detector-slow', d.name),
        tone: 'info',
        icon: 'device',
        title: clip(`Detector ${d.name} is slow (${Math.round(d.inferenceMs)} ms)`, 120),
        detail: 'High inference times can delay object detection. Check CPU load or hardware acceleration.',
        nature: 'fyi',
        check: 'frigate.detector_slow',
        subject: { id: `detector:${d.name}`.slice(0, 160), name: subjectName(d.name) },
        ignore: { lifts: 'fixed', words: 'Until detection speeds up.' },
      }),
      (more, subject, episode) => ({
        id: 'detector-slow-more',
        tone: 'info',
        icon: 'device',
        title: `${plural(more.length, 'more detector')} running slowly`,
        nature: 'fyi',
        check: 'frigate.detector_slow',
        subject,
        episode,
        ignore: { lifts: 'newer', words: 'Until the list changes.' },
      }),
    ),
  );
  const skipping = s.cameras.filter((c) => c.online && c.skippedFps >= 1);
  out.push(
    ...itemLines(
      skipping,
      (c) => `camera:${c.id}`,
      (c) => ({
        id: lineId('skipped-fps', c.id),
        tone: 'info',
        icon: 'camera',
        title: clip(`${c.name} is dropping frames`, 120),
        detail: `Skipping ${c.skippedFps.toFixed(1)} frames per second. Lower detect FPS or check detector load.`,
        nature: 'fyi',
        check: 'frigate.skipped_fps',
        subject: { id: `camera:${c.id}`.slice(0, 160), name: subjectName(c.name) },
        ignore: { lifts: 'fixed', words: 'Until frames stop dropping.' },
      }),
      (more, subject, episode) => ({
        id: 'skipped-fps-more',
        tone: 'info',
        icon: 'camera',
        title: `${plural(more.length, 'more camera', 'more cameras')} dropping frames`,
        nature: 'fyi',
        check: 'frigate.skipped_fps',
        subject,
        episode,
        ignore: { lifts: 'newer', words: 'Until the list changes.' },
      }),
    ),
  );
  return out;
}

/* View --------------------------------------------------------------------------------------------------------------- */

function todaySummaryCount(ctx: FrigateCtx): { total: number; busiest: string | null } | null {
  const todayKey = dayKey(ctx.now, ctx.timeZone);
  if (ctx.summary) {
    let total = 0;
    const byCam = new Map<string, number>();
    for (const r of ctx.summary) {
      if (r.day !== todayKey) continue;
      total += r.count;
      if (r.camera) byCam.set(r.camera, (byCam.get(r.camera) ?? 0) + r.count);
    }
    const top = [...byCam.entries()].sort((a, b) => b[1] - a[1])[0];
    return { total, busiest: top && byCam.size > 1 ? prettyCameraName(top[0]) : null };
  }
  if (!ctx.events) return null;
  const start = startOfLocalDay(ctx.now, ctx.timeZone).getTime();
  const today = ctx.events.filter((e) => e.at.getTime() >= start);
  const byCam = new Map<string, number>();
  for (const e of today) byCam.set(e.cameraName, (byCam.get(e.cameraName) ?? 0) + 1);
  const top = [...byCam.entries()].sort((a, b) => b[1] - a[1])[0];
  return { total: today.length, busiest: top && byCam.size > 1 ? top[0] : null };
}

function detectionWords(e: FrigateEvent): string {
  const who = e.subLabel ? `${prettyLabel(e.label)} (${e.subLabel})` : prettyLabel(e.label);
  return clip(`${who} seen at ${e.cameraName}`, 160);
}

export function frigateLive(ctx: FrigateCtx): LivePanel | null {
  if (!ctx.events && !ctx.summary) return null;
  const start = startOfLocalDay(ctx.now, ctx.timeZone).getTime();
  const today = (ctx.events ?? []).filter((e) => e.at.getTime() >= start).slice(0, TODAY_MAX);
  const counts = todaySummaryCount(ctx);
  return liveList({
    id: 'detections',
    title: 'Today',
    ...(counts ? { meta: counts.total > 0 ? plural(counts.total, 'detection') : 'Nothing seen today' } : {}),
    ask: { questions: ['What was detected today?', 'Which camera saw the most this week?'] },
    items: today.map(
      (e): ThingPageItem => ({
        id: e.id,
        title: detectionWords(e),
        ...(e.zones.length ? { detail: clip(e.zones.map(prettyCameraName).join(', '), 120) } : {}),
        at: e.at.toISOString(),
        icon: 'camera',
      }),
    ),
    empty: 'Nothing seen today.',
  });
}

export function frigateInventory(s: FrigateSnapshot, ctx: FrigateCtx, openUrl: string): InventoryPanel {
  const items: ThingPageItem[] = [];
  const off = s.cameras.filter((c) => !c.online).length;
  items.push(
    countLine({
      id: 'cameras',
      title: 'Cameras',
      icon: 'camera',
      value: thousands(s.cameras.length),
      ...(!s.cameras.length
        ? {}
        : off
          ? { note: `${off} offline`, noteTone: 'warn' as const }
          : { note: 'All online', noteTone: 'ok' as const }),
      url: openUrl,
    }),
  );
  const counts = todaySummaryCount(ctx);
  if (counts)
    items.push(
      countLine({
        id: 'detections-today',
        title: 'Detections today',
        icon: 'camera',
        value: thousands(counts.total),
        ...(counts.busiest ? { detail: `Most at ${counts.busiest}` } : {}),
      }),
    );
  if (s.detectors.length) {
    const worst = Math.max(...s.detectors.map((d) => d.inferenceMs));
    items.push(
      countLine({
        id: 'detectors',
        title: plural(s.detectors.length, 'Detector').replace(/^\d+ /, ''),
        icon: 'device',
        value: `${Math.round(worst)} ms`,
        detail: s.detectors.map((d) => d.name).join(', '),
        ...(worst > DETECTOR_SLOW_MS
          ? { note: 'Slow', noteTone: 'warn' as const }
          : { note: 'Healthy', noteTone: 'ok' as const }),
      }),
    );
  }
  if (s.storage && s.storage.totalBytes > 0) {
    const usedRatio = s.storage.usedBytes / s.storage.totalBytes;
    items.push(
      countLine({
        id: 'storage',
        title: 'Recordings',
        icon: 'disk',
        value: pct(usedRatio * 100),
        detail: `${bytes(s.storage.freeBytes)} free of ${bytes(s.storage.totalBytes)}`,
        ...(usedRatio >= 0.95
          ? { note: 'Almost full', noteTone: 'bad' as const }
          : usedRatio >= 0.9
            ? { note: 'Filling up', noteTone: 'warn' as const }
            : {}),
      }),
    );
  }
  return inventory({ id: 'inventory', title: 'In Frigate', items });
}

export function frigateShelf(
  s: FrigateSnapshot,
  ctx: FrigateCtx,
  opts: { picture: (cameraId: string, alt: string) => ThingGalleryItem['image']; openUrl: string },
): ShelfPanel | null {
  if (!s.cameras.length) return null;
  const online = s.cameras.filter((c) => c.online).length;
  return shelf({
    id: 'cameras',
    title: 'Cameras',
    meta:
      online === s.cameras.length
        ? `All ${s.cameras.length} online`
        : `${online} of ${s.cameras.length} online`,
    shape: 'wide',
    items: s.cameras
      .slice()
      .sort((a, b) => Number(!a.online) - Number(!b.online) || a.name.localeCompare(b.name))
      .map((c): ThingGalleryItem => {
        const since = ctx.offlineSince.get(c.id);
        const image = c.online ? opts.picture(c.id, c.name) : undefined;
        return {
          id: c.id,
          title: clip(c.name, 120),
          ...(c.online
            ? { sub: `${Math.round(c.cameraFps)} fps` }
            : {
                sub: since ? `Offline since ${moment(since, ctx.now, ctx.timeZone)}` : 'Offline',
                badge: { text: 'Offline', tone: 'warn' as const },
                muted: true,
              }),
          ...(image ? { image } : {}),
          url: opts.openUrl,
        };
      }),
    ...(s.cameras.length > 4
      ? { link: { kind: 'url' as const, label: 'All cameras in Frigate', url: opts.openUrl } }
      : {}),
    empty: 'No cameras in Frigate yet.',
  });
}

export function frigateTrend(ctx: FrigateCtx): TrendPanel | null {
  if (!ctx.summary?.length) return null;
  const byDay = new Map<string, number>();
  for (const r of ctx.summary) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.count);
  const days = lastDays(ctx.now, ctx.timeZone, 7);
  const before = lastDays(new Date(ctx.now.getTime() - 7 * DAY_MS), ctx.timeZone, 7);
  const allDays = [...byDay.keys()].sort();
  const earliest = allDays[0] ?? null;
  const count = (k: string) => (earliest && k >= earliest ? (byDay.get(k) ?? 0) : null);
  const values = days.keys.map(count);
  if (daysWith(values) < 2) return null;
  const total = values.reduce<number>((a, b) => a + (b ?? 0), 0);
  const whole = earliest !== null && earliest <= (before.keys[0] as string);
  const prior = whole ? before.keys.reduce((a, k) => a + (count(k) ?? 0), 0) : 0;
  return trend({
    id: 'week',
    title: 'This week',
    meta: 'Detections per day',
    days,
    values,
    label: 'Detections',
    color: 'violet',
    figure: { value: thousands(total), rest: total === 1 ? 'detection' : 'detections' },
    change: whole ? weekChange(total, prior) : null,
    changeWords: ' on last week',
  });
}

export function frigateMachineLines(s: FrigateSnapshot): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  if (s.version)
    out.push({
      id: 'frigate-version',
      label: 'Frigate',
      value: clip(s.version, 40),
      pct: null,
      ...(s.uptimeSeconds && s.uptimeSeconds > 60 ? { sub: `Up ${span(s.uptimeSeconds * 1000)}` } : {}),
    });
  for (const d of s.detectors.slice(0, 2))
    out.push({
      id: lineId('detector', d.name),
      label: clip(`Detector (${d.name})`, 60),
      value: `${Math.round(d.inferenceMs)} ms`,
      pct: null,
      ...(d.inferenceMs > DETECTOR_SLOW_MS
        ? { sub: 'Running slowly', subTone: 'warn' as const }
        : { sub: 'Fast', subTone: 'ok' as const }),
    });
  if (s.storage && s.storage.totalBytes > 0) {
    const usedRatio = s.storage.usedBytes / s.storage.totalBytes;
    out.push({
      id: 'frigate-storage',
      label: 'Recordings disk',
      value: clip(`${bytes(s.storage.usedBytes)} of ${bytes(s.storage.totalBytes)}`, 40),
      pct: Math.max(0, Math.min(1, usedRatio)),
      sub: `${bytes(s.storage.freeBytes)} free`,
      ...(usedRatio >= 0.95 ? { tone: 'bad' as const } : usedRatio >= 0.9 ? { tone: 'warn' as const } : {}),
    });
  }
  return out;
}

export function frigateVerdict(s: FrigateSnapshot): string {
  const n = s.cameras.length;
  const online = s.cameras.filter((c) => c.online).length;
  if (!n) return 'Frigate is fine.';
  const cams =
    online === n
      ? n === 1
        ? 'the camera is online'
        : `all ${n} cameras are online`
      : `${online} of ${n} cameras are online`;
  return `Frigate is fine: ${cams}.`;
}

export function frigateKpis(s: FrigateSnapshot, ctx: FrigateCtx): ThingPageKpi[] {
  const online = s.cameras.filter((c) => c.online).length;
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
  const counts = todaySummaryCount(ctx);
  if (counts)
    out.push({
      key: 'detections',
      label: 'Detections today',
      value: thousands(counts.total),
      sub: counts.busiest ? `most at ${counts.busiest}` : 'objects detected',
    });
  return out;
}

export function frigateView(
  s: FrigateSnapshot,
  ctx: FrigateCtx,
  opts: {
    picture: (cameraId: string, alt: string) => ThingGalleryItem['image'];
    openUrl: string;
  },
): Pick<
  KindView,
  | 'kpis'
  | 'charts'
  | 'notices'
  | 'panels'
  | 'slots'
  | 'facts'
  | 'machine'
  | 'refreshS'
  | 'verdict'
  | 'suggestions'
> {
  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`Frigate **${s.version}**`));
  if (s.cameras.length) facts.push(line(`**${plural(s.cameras.length, 'camera')}**`));
  return {
    kpis: [],
    charts: [],
    machine: 'after',
    notices: frigateNotices(s, ctx),
    ...slotPanels({
      live: frigateLive(ctx),
      inventory: frigateInventory(s, ctx, opts.openUrl),
      shelf: frigateShelf(s, ctx, opts),
      trend: frigateTrend(ctx),
      machine: frigateMachineLines(s),
    }),
    facts,
    refreshS: FRIGATE_REFRESH_S,
    verdict: frigateVerdict(s),
    suggestions: ['Detections this week', 'Which cameras went offline', 'Storage used by recordings'],
  };
}

/* Page & seen -------------------------------------------------------------------------------------------------------- */

export function frigateUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  return (str(row.fields.url) ?? row.baseUrl).replace(/\/+$/, '');
}

export async function frigatePage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const openUrl = frigateUrl(row);
  const [read, events, summary] = await Promise.all([
    frigateLatest(services, row, now),
    readTodayEvents(services, row, now, ctx.timeZone),
    readSummary(services, row),
  ]);
  const base: KindView = {
    notices: [],
    panels: [],
    tabs: [],
    facts: [],
    open: { label: 'Open Frigate', url: openUrl },
    actions: [],
    readAt: null,
    charts: [],
    machine: 'after',
    suggestions: ['Detections this week', 'Which cameras went offline', 'Storage used by recordings'],
    refreshing: read.refreshing,
  };
  if (!read.ok) return { ...base, problem: problemOf(read.error, NAME).message };
  const s = read.value;
  const view = frigateView(
    s,
    { now, timeZone: ctx.timeZone, events, summary, offlineSince: offlineSinceOf(row.id, s) },
    {
      openUrl,
      picture: (cameraId, alt) =>
        thingImage(
          imageRef(ctx, {
            path: `/api/${encodeURIComponent(cameraId)}/latest.jpg?h=360`,
            snapshot: true,
          }),
          alt,
          'wide',
        ),
    },
  );
  return { ...base, ...view, readAt: s.readAt };
}

export async function frigateSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const [s, summary] = await Promise.all([frigateSnapshot(services, row, now), readSummary(services, row)]);
  const ctx: FrigateCtx = {
    now,
    timeZone,
    events: null,
    summary,
    offlineSince: offlineSinceOf(row.id, s),
  };
  const kpis = frigateKpis(s, ctx);
  const notices = frigateNotices(s, ctx);
  return {
    glance: seenFromView(
      { kpis, notices },
      { figures: 2, ...(s.version ? { line: `Frigate ${s.version}` } : {}) },
    ),
    points: {},
    notices,
    skipped: frigateSkipped(s),
  };
}

export const FRIGATE_KIND: KindModule = {
  page: frigatePage,
  prefetch: (services, row, now) => frigateLatest(services, row, now),
  seen: frigateSeen,
  asksFirst: 'configuration, deleting events and restarting Frigate ask first',
  checks: FRIGATE_CHECKS,
};
