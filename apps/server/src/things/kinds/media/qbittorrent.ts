/**
 * qBittorrent's page and card: download and upload speeds, active torrent queue with Pause all / Resume all and Slow
 * down / Full speed buttons, seeding and completed counts, all-time transfer and ratio, connection status, download
 * disk free space, errored torrents, and speed over time (`qbt_mbps`). Read with WebUI API v2 (`/api/v2/sync/maindata`
 * and `/api/v2/app/version`). Supports both qBittorrent v5 (`stoppedDL`/`stoppedUP`, `/torrents/stop|start`) and v4
 * (`pausedDL`/`pausedUP`, `/torrents/pause|resume`). Never deletes torrents or files, never changes settings or shuts
 * qBittorrent down. Its Trend, downloaded per day, comes from Whombat's own readings of the all-time downloaded figure
 * the same read has (`qbt_dl_gb`): each day's last less the day before's.
 */
import type { ThingLine, ThingPageBar, ThingPageKpi } from '@whombat/core';
import { signedConnectionFetch } from '../../../connections/http';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { ConnectionActivity } from '../../../home/types';
import { ApiError } from '../../../lib/errors';
import type { Services } from '../../../services';
import { readPoints } from '../../points';
import type { KindCheck, KindNotice } from '../../quiet/types';
import {
  avgPeakLines,
  downsample,
  drawable,
  lastValue,
  onRange,
  type PageRange,
  RANGE_MS,
  type RawPoint,
  seriesStats,
  statFigure,
  statsOf,
} from '../../series';
import { bytes, clip, dateOf, line, num, plural, rec, span, str, thousands } from '../../words';
import { actAs } from '../act';
import { cachedRead, getJson, KIND_DEADLINE_MS, liveRead, problemOf, withDeadline } from '../read';
import type { KindAction, KindActionCtx, KindModule, KindSeen } from '../registry';
import { seenFromView } from '../registry';
import {
  countLine,
  dayKey,
  daysWith,
  inventory,
  lastDays,
  liveRows,
  pointsByDay,
  slotPanels,
  type TrendPanel,
  trend,
  weekChange,
} from '../slots';
import type { KindCtx, KindView } from '../types';
import {
  idOf,
  itemLines,
  leftWords,
  linesSeen,
  optional,
  share,
  speedWords,
  statusFrom,
  uniqueById,
  worstFirst,
} from './common';
import {
  asNotices,
  type Button,
  type ButtonCtx,
  button,
  type GalleryItem,
  type Item,
  type Panel,
} from './ui';

const NAME = 'qBittorrent';
export const QBT_MBPS_KEY = 'qbt_mbps';
/** qBittorrent's all-time downloaded figure in GB, kept every pass: it keeps no history per day of its own. */
export const QBT_DL_KEY = 'qbt_dl_gb';
export const QBT_LIVE_MS = 4_000;
const VERSION_KEEP_MS = 5 * 60_000;
const GIB = 1024 ** 3;
const DISK_WARN_BYTES = 10 * GIB;
const DISK_BAD_BYTES = 2 * GIB;
/** qBittorrent reports 8,640,000 seconds (100 days) when ETA is infinite/unknown. */
const ETA_INFINITY = 8_640_000;
const QUEUE_ROWS = 20;
const DONE_ROWS = 10;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface QbtTorrent {
  hash: string;
  name: string;
  sizeBytes: number;
  leftBytes: number;
  /** 0…1. */
  progress: number;
  dlSpeedBps: number;
  upSpeedBps: number;
  etaMs: number | null;
  state: string;
  category: string | null;
  ratio: number | null;
  seeds: number;
  peers: number;
  completedAt: Date | null;
  addedAt: Date | null;
}

export interface QbtServerState {
  dlSpeedBps: number;
  upSpeedBps: number;
  alltimeDlBytes: number | null;
  alltimeUlBytes: number | null;
  globalRatio: string | null;
  freeSpaceBytes: number | null;
  connectionStatus: 'connected' | 'firewalled' | 'disconnected' | string;
  altSpeedLimits: boolean;
  dlRateLimitBps: number;
  upRateLimitBps: number;
}

export interface QbtSnapshot {
  readAt: Date;
  version: string | null;
  state: QbtServerState;
  torrents: QbtTorrent[];
}

const ACTIVE_DL_STATES = new Set([
  'downloading',
  'forcedDL',
  'metaDL',
  'allocating',
  'checkingDL',
  'checkingResumeData',
  'moving',
]);
const PAUSED_DL_STATES = new Set(['pausedDL', 'stoppedDL']);
const QUEUE_STATES = new Set([
  ...ACTIVE_DL_STATES,
  ...PAUSED_DL_STATES,
  'queuedDL',
  'stalledDL',
  'error',
  'missingFiles',
]);
const SEEDING_STATES = new Set(['uploading', 'forcedUP', 'stalledUP', 'queuedUP']);
const COMPLETED_PAUSED_STATES = new Set(['pausedUP', 'stoppedUP', 'checkingUP']);
const ERROR_STATES = new Set(['error', 'missingFiles']);

export const isDownloading = (t: QbtTorrent) => ACTIVE_DL_STATES.has(t.state) || t.dlSpeedBps > 0;
export const isInQueue = (t: QbtTorrent) => QUEUE_STATES.has(t.state);
export const isSeeding = (t: QbtTorrent) => SEEDING_STATES.has(t.state);
export const isErrored = (t: QbtTorrent) => ERROR_STATES.has(t.state);
export const isPausedDl = (t: QbtTorrent) => PAUSED_DL_STATES.has(t.state);

/** `/api/v2/sync/maindata`. */
export function parseMaindata(body: unknown, now: Date, version: string | null = null): QbtSnapshot {
  const b = rec(body);
  const s = rec(b.server_state);
  const ratioRaw = str(s.global_ratio);
  const ratioNum = num(s.global_ratio);
  const state: QbtServerState = {
    dlSpeedBps: Math.max(0, num(s.dl_info_speed) ?? 0),
    upSpeedBps: Math.max(0, num(s.up_info_speed) ?? 0),
    alltimeDlBytes: num(s.alltime_dl),
    alltimeUlBytes: num(s.alltime_ul),
    globalRatio: ratioRaw ?? (ratioNum !== null ? ratioNum.toFixed(2) : null),
    freeSpaceBytes: num(s.free_space_on_disk),
    connectionStatus: (str(s.connection_status) ?? 'unknown').toLowerCase(),
    altSpeedLimits: s.use_alt_speed_limits === true,
    dlRateLimitBps: Math.max(0, num(s.dl_rate_limit) ?? 0),
    upRateLimitBps: Math.max(0, num(s.up_rate_limit) ?? 0),
  };
  const torrentsMap = rec(b.torrents);
  const torrents: QbtTorrent[] = [];
  for (const [hash, raw] of Object.entries(torrentsMap).slice(0, 500)) {
    const t = rec(raw);
    const name = str(t.name);
    if (!hash || !name) continue;
    const size = Math.max(0, num(t.size) ?? num(t.total_size) ?? 0);
    const left = Math.max(0, num(t.amount_left) ?? 0);
    const progress = num(t.progress);
    const eta = num(t.eta);
    const completedOn = num(t.completion_on);
    const addedOn = num(t.added_on);
    torrents.push({
      hash: hash.slice(0, 80),
      name: name.slice(0, 200),
      sizeBytes: size,
      leftBytes: left,
      progress: progress !== null ? Math.max(0, Math.min(1, progress)) : size > 0 ? 1 - left / size : 0,
      dlSpeedBps: Math.max(0, num(t.dlspeed) ?? 0),
      upSpeedBps: Math.max(0, num(t.upspeed) ?? 0),
      etaMs: eta !== null && eta > 0 && eta < ETA_INFINITY ? eta * 1000 : null,
      state: str(t.state) ?? 'unknown',
      category: str(t.category),
      ratio: num(t.ratio),
      seeds: Math.max(0, num(t.num_seeds) ?? 0),
      peers: Math.max(0, num(t.num_leechs) ?? 0),
      completedAt: completedOn !== null && completedOn > 0 ? dateOf(completedOn) : null,
      addedAt: addedOn !== null && addedOn > 0 ? dateOf(addedOn) : null,
    });
  }
  return { readAt: now, version, state, torrents };
}

async function readVersion(services: Services, row: CatalogConnectionRow): Promise<string | null> {
  const res = await signedConnectionFetch(
    services,
    row,
    {
      method: 'GET',
      url: `${row.baseUrl.replace(/\/+$/, '')}/api/v2/app/version`,
      headers: { Accept: '*/*' },
    },
    { maxBytes: 1024, deadlineMs: 5_000 },
  );
  if (res.status < 200 || res.status >= 300) return null;
  const text = res.body.toString('utf8').trim().replace(/^v/i, '');
  return text ? text.slice(0, 40) : null;
}

async function readMaindata(services: Services, row: CatalogConnectionRow, now: Date): Promise<QbtSnapshot> {
  const [maindata, version] = await Promise.all([
    getJson(services, row, NAME, '/api/v2/sync/maindata'),
    optional(
      cachedRead(services, `qbt-version:${row.id}`, row, () => readVersion(services, row), VERSION_KEEP_MS),
    ),
  ]);
  return parseMaindata(maindata, now, version);
}

function deadline<T>(work: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await withDeadline(work(), KIND_DEADLINE_MS, 'qBittorrent didn’t answer in time.');
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

const liveKey = (row: CatalogConnectionRow) => `qbittorrent-live:${row.id}`;

export function qbtSnapshot(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
): Promise<QbtSnapshot> {
  return cachedRead(
    services,
    liveKey(row),
    row,
    deadline(() => readMaindata(services, row, now)),
    QBT_LIVE_MS,
  );
}

/* Checks and notices ------------------------------------------------------------------------------------------------- */

export const QBT_CHECKS: readonly KindCheck[] = [
  {
    check: 'qbittorrent.disk_low',
    name: 'Download disk low on space',
    nature: 'problem',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'qbittorrent.disconnected',
    name: 'No network connection',
    nature: 'problem',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'qbittorrent.errored',
    name: 'Torrents with errors',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'qbittorrent.firewalled',
    name: 'Incoming connections firewalled',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'qbittorrent.stalled',
    name: 'Stalled downloads',
    nature: 'fyi',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'qbittorrent.alt_speed',
    name: 'Slow speed limits left on',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
];

export function qbtSkipped(s: QbtSnapshot): string[] {
  const out: string[] = [];
  if (s.state.freeSpaceBytes === null) out.push('qbittorrent.disk_low');
  if (s.state.connectionStatus === 'unknown') out.push('qbittorrent.disconnected', 'qbittorrent.firewalled');
  return out;
}

export interface QbtInput {
  snapshot: QbtSnapshot;
  now: Date;
  timeZone: string;
  range: PageRange;
  speed: { timestamps: string[]; values: (number | null)[] };
  who: ButtonCtx;
  url: string;
  /** Whombat's own readings of the all-time downloaded figure (`qbt_dl_gb`), the last 15 days. */
  downloaded?: readonly RawPoint[];
}

export function qbtNotices(input: QbtInput): KindNotice[] {
  const { snapshot: s, who } = input;
  const out: KindNotice[] = [];
  const free = s.state.freeSpaceBytes;
  if (free !== null && free < DISK_WARN_BYTES) {
    const bad = free < DISK_BAD_BYTES;
    out.push({
      id: 'disk-low',
      tone: bad ? 'bad' : 'warn',
      icon: 'disk',
      title: `Only ${bytes(free)} free on qBittorrent’s download disk`,
      detail: 'Downloads stop when the disk fills up. Remove finished torrents or free space on the disk.',
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: 'qBittorrent’s download disk is low on space. Which torrents take the most room?',
      },
      nature: 'problem',
      check: 'qbittorrent.disk_low',
      band: bad ? 98 : 90,
      ignore: { lifts: 'fixed', words: 'Until there’s more room.' },
      badge: 'Disk low on space',
    });
  }
  if (s.state.connectionStatus === 'disconnected')
    out.push({
      id: 'disconnected',
      tone: 'bad',
      icon: 'network',
      title: 'qBittorrent has no network connection',
      detail:
        'It can’t reach peers or trackers. Check its network interface or VPN in qBittorrent’s settings.',
      link: { kind: 'url', label: 'Open qBittorrent', url: input.url },
      nature: 'problem',
      check: 'qbittorrent.disconnected',
      confirm: 2,
      ignore: { lifts: 'fixed', words: 'Until it reconnects.' },
      badge: 'Disconnected',
    });
  else if (s.state.connectionStatus === 'firewalled')
    out.push({
      id: 'firewalled',
      tone: 'info',
      icon: 'network',
      title: 'qBittorrent is firewalled',
      detail:
        'Incoming connections are blocked, which can slow downloads and seeding. Check port forwarding or UPnP.',
      link: { kind: 'url', label: 'Open qBittorrent', url: input.url },
      nature: 'fyi',
      check: 'qbittorrent.firewalled',
      ignore: { lifts: 'fixed', words: 'Until incoming connections work.' },
    });
  const errored = s.torrents.filter(isErrored).sort((a, b) => a.name.localeCompare(b.name));
  out.push(
    ...itemLines(
      errored.map(
        (t): KindNotice => ({
          id: idOf('error', t.hash).slice(0, 120),
          tone: 'warn',
          icon: 'download',
          title: clip(
            t.state === 'missingFiles'
              ? `${t.name} is missing its files`
              : `${t.name} has an error in qBittorrent`,
            120,
          ),
          detail:
            t.state === 'missingFiles'
              ? 'qBittorrent can’t find its files on disk. Check where they moved or recheck the torrent.'
              : 'Open qBittorrent to see the error or force a recheck.',
          link: { kind: 'url', label: 'Open qBittorrent', url: input.url },
          nature: 'problem',
          check: 'qbittorrent.errored',
          subject: { id: `torrent:${t.hash}`, name: clip(t.name, 80) },
          ignore: { lifts: 'fixed', words: 'Until the error clears.' },
        }),
      ),
      (more) => ({
        id: 'error-more',
        title: `${plural(more.length, 'more torrent')} have errors in qBittorrent`,
        link: { kind: 'url', label: 'Open qBittorrent', url: input.url },
      }),
    ),
  );
  const stalled = s.torrents
    .filter((t) => t.state === 'stalledDL' && t.dlSpeedBps === 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  out.push(
    ...itemLines(
      stalled.map(
        (t): KindNotice => ({
          id: idOf('stalled', t.hash).slice(0, 120),
          tone: 'info',
          icon: 'clock',
          title: clip(`${t.name} is stalled`, 120),
          detail:
            'No peers are sending data right now. It may pick up when a seed comes online, or need another release.',
          nature: 'fyi',
          check: 'qbittorrent.stalled',
          subject: { id: `torrent:${t.hash}`, name: clip(t.name, 80) },
          ignore: { lifts: 'fixed', words: 'Until it starts moving again.' },
        }),
      ),
      (more) => ({
        id: 'stalled-more',
        title: `${plural(more.length, 'more download')} stalled in qBittorrent`,
      }),
    ),
  );
  if (s.state.altSpeedLimits)
    out.push({
      id: 'alt-speed',
      tone: 'info',
      icon: 'clock',
      title: 'qBittorrent is using slow speed limits',
      detail: 'Alternative speed limits are turned on. Switch back to full speed when you’re ready.',
      action: button(who, { action: 'toggle_alt_speed', label: 'Full speed', icon: 'speed' }),
      nature: 'fyi',
      check: 'qbittorrent.alt_speed',
      ignore: { lifts: 'fixed', words: 'Until full speed is back.' },
    });
  return worstFirst(uniqueById(out));
}

/* View --------------------------------------------------------------------------------------------------------------- */

const STATE_LABEL: Record<string, string> = {
  stalledDL: 'Stalled',
  metaDL: 'Fetching info',
  checkingDL: 'Checking',
  checkingResumeData: 'Checking',
  queuedDL: 'Queued',
  pausedDL: 'Paused',
  stoppedDL: 'Paused',
  allocating: 'Allocating',
  moving: 'Moving',
  error: 'Error',
  missingFiles: 'Missing files',
};

function queueButtons(s: QbtSnapshot, who: ButtonCtx): Button[] {
  const queue = s.torrents.filter(isInQueue);
  const allPaused = queue.length > 0 && queue.every(isPausedDl);
  const out: Button[] = [];
  if (allPaused)
    out.push(button(who, { action: 'resume', label: 'Resume all', icon: 'play', tone: 'primary' }));
  else if (s.torrents.length > 0)
    out.push(button(who, { action: 'pause', label: 'Pause all', icon: 'pause' }));
  out.push(
    button(who, {
      action: 'toggle_alt_speed',
      label: s.state.altSpeedLimits ? 'Full speed' : 'Slow down',
      icon: 'speed',
    }),
  );
  return out;
}

export function qbtQueueMeta(s: QbtSnapshot): string | undefined {
  const queue = s.torrents.filter(isInQueue);
  if (!queue.length)
    return s.state.upSpeedBps > 0 ? `Seeding · ${speedWords(s.state.upSpeedBps)} up` : undefined;
  const active = queue.filter(isDownloading);
  const allPaused = queue.every(isPausedDl);
  const leftBytes = queue.reduce((a, t) => a + t.leftBytes, 0);
  const maxEta = active.reduce((a, t) => Math.max(a, t.etaMs ?? 0), 0);
  if (allPaused)
    return ['Paused', plural(queue.length, 'download'), leftBytes > 0 ? `${bytes(leftBytes)} left` : null]
      .filter(Boolean)
      .join(' · ');
  return [
    s.state.dlSpeedBps > 0 ? speedWords(s.state.dlSpeedBps) : null,
    s.state.altSpeedLimits ? 'slow limit' : null,
    plural(queue.length, 'download'),
    leftBytes > 0 ? `${bytes(leftBytes)} left` : null,
    maxEta > 0 ? `about ${span(maxEta)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function queueRank(t: QbtTorrent): number {
  if (isErrored(t)) return 0;
  if (isDownloading(t)) return 1;
  if (t.state === 'stalledDL') return 2;
  if (t.state === 'queuedDL') return 3;
  return 4;
}

function downloadingRows(input: QbtInput) {
  const s = input.snapshot;
  const queue = s.torrents
    .filter(isInQueue)
    .sort(
      (a, b) => queueRank(a) - queueRank(b) || b.dlSpeedBps - a.dlSpeedBps || a.name.localeCompare(b.name),
    );
  const shown = queue.slice(0, QUEUE_ROWS);
  const meta = qbtQueueMeta(s);
  return liveRows({
    id: 'queue',
    title: 'Downloading now',
    shape: 'square',
    ...(meta ? { meta } : {}),
    buttons: queueButtons(s, input.who),
    ...(queue.length > shown.length ? { total: queue.length } : {}),
    items: shown.map((t): GalleryItem => {
      const paused = isPausedDl(t);
      const err = isErrored(t);
      const sub = [
        t.category,
        t.sizeBytes > 0 ? bytes(t.sizeBytes) : null,
        t.dlSpeedBps > 0 ? speedWords(t.dlSpeedBps) : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const have = Math.max(0, t.sizeBytes - t.leftBytes);
      const got = have > 0 && t.sizeBytes > 0 ? `${bytes(have)} of ${bytes(t.sizeBytes)}` : share(t.progress);
      const label = STATE_LABEL[t.state];
      return {
        id: t.hash,
        title: clip(t.name, 120),
        ...(sub ? { sub: clip(sub, 120) } : {}),
        ...(err
          ? { badge: { text: label ?? 'Error', tone: 'bad' as const } }
          : label && !paused && t.state !== 'queuedDL'
            ? { badge: { text: label, tone: 'warn' as const } }
            : {}),
        progress: t.progress,
        ...(paused ? { paused: true } : {}),
        note: clip(got, 80),
        ...(paused
          ? { noteEnd: 'Paused' }
          : t.etaMs
            ? { noteEnd: leftWords(t.etaMs) }
            : t.state === 'queuedDL'
              ? { noteEnd: 'Waiting' }
              : {}),
      };
    }),
    empty: 'Nothing downloading.',
  });
}

function torrentsInventory(input: QbtInput) {
  const s = input.snapshot;
  const queue = s.torrents.filter(isInQueue);
  const active = queue.filter(isDownloading);
  const seeding = s.torrents.filter(isSeeding);
  const completed = s.torrents.filter((t) => COMPLETED_PAUSED_STATES.has(t.state));
  const errored = s.torrents.filter(isErrored);
  const items: Item[] = [
    countLine({
      id: 'downloading',
      title: 'Downloading',
      icon: 'download',
      value: thousands(queue.length),
      ...(s.state.dlSpeedBps > 0
        ? { detail: speedWords(s.state.dlSpeedBps) }
        : queue.length > 0 && active.length === 0
          ? { detail: 'Paused or waiting' }
          : {}),
    }),
    countLine({
      id: 'seeding',
      title: 'Seeding',
      icon: 'network',
      value: thousands(seeding.length),
      ...(s.state.upSpeedBps > 0 ? { detail: `${speedWords(s.state.upSpeedBps)} up` } : {}),
    }),
    countLine({
      id: 'completed',
      title: 'Completed',
      icon: 'download',
      value: thousands(completed.length),
      ...(completed.length > 0 ? { detail: 'Paused after finishing' } : {}),
    }),
  ];
  if (errored.length > 0)
    items.push(
      countLine({
        id: 'errored',
        title: 'Errors',
        icon: 'warn',
        tone: 'warn',
        value: thousands(errored.length),
        detail: 'Need attention in qBittorrent',
        url: input.url,
      }),
    );
  if (s.state.alltimeDlBytes !== null)
    items.push(
      countLine({
        id: 'transfer',
        title: 'All-time transfer',
        icon: 'network',
        value: bytes(s.state.alltimeDlBytes),
        detail: [
          s.state.alltimeUlBytes !== null ? `${bytes(s.state.alltimeUlBytes)} uploaded` : null,
          s.state.globalRatio ? `ratio ${s.state.globalRatio}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }),
    );
  return inventory({
    id: 'torrents',
    title: 'Torrents',
    meta: plural(s.torrents.length, 'torrent'),
    items,
  });
}

export function qbtMachineLines(s: QbtSnapshot): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  if (s.version) out.push({ id: 'qbt-version', label: 'qBittorrent', value: clip(s.version, 40), pct: null });
  if (s.state.connectionStatus !== 'unknown') {
    const conn = s.state.connectionStatus;
    out.push({
      id: 'qbt-connection',
      label: 'Connection',
      value: conn === 'connected' ? 'Connected' : conn === 'firewalled' ? 'Firewalled' : 'Disconnected',
      pct: null,
      ...(conn === 'connected'
        ? { sub: 'Incoming peers ok', subTone: 'ok' as const }
        : conn === 'firewalled'
          ? { sub: 'Incoming blocked', subTone: 'warn' as const }
          : { sub: 'Offline', subTone: 'bad' as const }),
    });
  }
  if (s.state.freeSpaceBytes !== null) {
    const free = s.state.freeSpaceBytes;
    out.push({
      id: 'download-disk',
      label: 'Download disk',
      value: `${bytes(free)} free`,
      pct: null,
      ...(free < DISK_BAD_BYTES
        ? { sub: 'Almost full', subTone: 'bad' as const }
        : free < DISK_WARN_BYTES
          ? { sub: 'Running low', subTone: 'warn' as const }
          : {}),
    });
  }
  return out;
}

function qbtMore(input: QbtInput): Panel[] {
  const { snapshot: s, now, timeZone } = input;
  const panels: Panel[] = [];
  const errored = s.torrents.filter(isErrored);
  if (errored.length > 0)
    panels.push({
      kind: 'table',
      id: 'errored',
      title: 'Torrents with errors',
      meta: plural(errored.length, 'torrent'),
      columns: [
        { key: 'name', label: 'Torrent' },
        { key: 'why', label: 'Problem' },
        { key: 'size', label: 'Size' },
      ],
      rows: errored.slice(0, 20).map((t) => ({
        id: t.hash,
        cells: {
          name: { text: clip(t.name, 200), ...(t.category ? { note: t.category } : {}) },
          why: { text: t.state === 'missingFiles' ? 'Missing files' : 'Error', tone: 'bad' },
          size: { text: t.sizeBytes > 0 ? bytes(t.sizeBytes) : '—' },
        },
      })),
    });
  const today = dayKey(now, timeZone);
  const done = s.torrents
    .filter((t) => !isInQueue(t) && t.completedAt && dayKey(t.completedAt, timeZone) === today)
    .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
    .slice(0, DONE_ROWS);
  if (done.length > 0)
    panels.push({
      kind: 'list',
      id: 'done',
      title: 'Done today',
      meta: plural(done.length, 'download'),
      items: done.map((t) => ({
        id: t.hash,
        title: clip(t.name, 160),
        ...(t.category ? { detail: t.category } : {}),
        ...(t.completedAt ? { at: t.completedAt.toISOString(), right: bytes(t.sizeBytes) } : {}),
        tone: 'ok' as const,
        icon: 'download' as const,
      })),
    });
  if (drawable(input.speed.values)) {
    const stats = seriesStats(input.speed.values, input.speed.timestamps);
    const latest = lastValue(input.speed.values);
    const lines: ThingLine[] = stats
      ? avgPeakLines(stats, (n) => `${statFigure(n)} MB/s`, now, timeZone)
      : [];
    panels.push({
      kind: 'chart',
      id: 'speed',
      title: 'Speed',
      timestamps: input.speed.timestamps,
      series: [
        {
          key: 'speed',
          label: 'Speed',
          unit: 'MB/s',
          values: input.speed.values,
          color: 'green',
          fill: true,
          ...(latest !== null ? { latest: `${statFigure(latest)} MB/s` } : {}),
        },
      ],
      figure: { value: speedWords(s.state.dlSpeedBps), rest: 'now' },
      ...statsOf(lines),
      axis: { min: 0, unit: 'MB/s' },
    });
  }
  return panels;
}

export function qbtVerdict(s: QbtSnapshot): string {
  const active = s.torrents.filter(isDownloading);
  const seeding = s.torrents.filter(isSeeding).length;
  if (active.length > 0) {
    const dl = `downloading ${plural(active.length, 'torrent')}${s.state.dlSpeedBps > 0 ? ` at ${speedWords(s.state.dlSpeedBps)}` : ''}`;
    return clip(
      seeding > 0 ? `qBittorrent is fine: ${dl} and seeding ${seeding}.` : `qBittorrent is fine: ${dl}.`,
      200,
    );
  }
  if (seeding > 0)
    return clip(`qBittorrent is fine: nothing downloading, seeding ${plural(seeding, 'torrent')}.`, 200);
  return 'qBittorrent is fine: nothing downloading.';
}

export function qbtKpis(input: Pick<QbtInput, 'snapshot' | 'speed'>): ThingPageKpi[] {
  const s = input.snapshot;
  const queue = s.torrents.filter(isInQueue);
  const leftBytes = queue.reduce((a, t) => a + t.leftBytes, 0);
  const spark = drawable(input.speed.values)
    ? { spark: downsample(input.speed.values), color: 'green' as const }
    : {};
  const out: ThingPageKpi[] = [
    {
      key: 'speed',
      label: 'Speed',
      value: speedWords(s.state.dlSpeedBps),
      sub:
        s.state.upSpeedBps > 0
          ? `${speedWords(s.state.upSpeedBps)} up`
          : queue.length
            ? plural(queue.length, 'download')
            : 'Nothing downloading',
      ...spark,
    },
    {
      key: 'left',
      label: 'Left',
      value: leftBytes > 0 ? bytes(leftBytes) : '0',
      sub: leftBytes > 0 ? plural(queue.length, 'download') : 'Queue is empty',
    },
  ];
  if (s.state.freeSpaceBytes !== null)
    out.push({
      key: 'disk',
      label: 'Disk free',
      value: bytes(s.state.freeSpaceBytes),
      ...(s.state.freeSpaceBytes < DISK_BAD_BYTES
        ? { tone: 'bad' as const }
        : s.state.freeSpaceBytes < DISK_WARN_BYTES
          ? { tone: 'warn' as const }
          : { color: 'blue' as const }),
    });
  return out;
}

/** The all-time downloaded figure as the pass keeps it: GB, two decimals. */
export function downloadedPoint(s: QbtSnapshot): Record<string, number> {
  const b = s.state.alltimeDlBytes;
  return b !== null && b >= 0 ? { [QBT_DL_KEY]: Math.round(b / 1e7) / 100 } : {};
}

const sumOf = (xs: readonly (number | null)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);

/**
 * Trend, downloaded per day this week: each day's last reading of the all-time figure less the day before's, today's
 * from what qBittorrent says now. A day the figure went down (its statistics were reset) draws no bar. Left out with
 * fewer than two days to draw; the change on last week once all seven days before have one.
 */
export function downloadedWeek(
  input: Pick<QbtInput, 'snapshot' | 'now' | 'timeZone' | 'downloaded'>,
): TrendPanel | null {
  const { now, timeZone } = input;
  const days = lastDays(now, timeZone, 15);
  const levels = pointsByDay(input.downloaded ?? [], days.keys, timeZone, 'last');
  const nowGb = downloadedPoint(input.snapshot)[QBT_DL_KEY];
  if (nowGb !== undefined) levels[levels.length - 1] = nowGb;
  const perDay = levels.map((v, i) => {
    const before = i ? levels[i - 1] : null;
    return v === null || before == null || v < before ? null : Math.round((v - before) * 100) / 100;
  });
  const week = perDay.slice(8);
  if (daysWith(week) < 2) return null;
  const before = perDay.slice(1, 8);
  const total = sumOf(week);
  return trend({
    id: 'week',
    title: 'This week',
    meta: 'Downloaded per day',
    days: { at: days.at.slice(-7), labels: days.labels.slice(-7) },
    values: week,
    label: 'Downloaded',
    unit: 'GB',
    figure: { value: bytes(total * 1e9), rest: 'this week' },
    change: daysWith(before) === 7 ? weekChange(total, sumOf(before)) : null,
    color: 'green',
  });
}

export function qbtSlots(input: QbtInput): Pick<KindView, 'panels' | 'slots'> {
  return slotPanels({
    live: downloadingRows(input),
    inventory: torrentsInventory(input),
    trend: downloadedWeek(input),
    more: qbtMore(input),
    machine: qbtMachineLines(input.snapshot),
  });
}

export function qbtView(input: QbtInput): KindView {
  const s = input.snapshot;
  const active = s.torrents.some(isDownloading);
  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`qBittorrent **${s.version}**`));
  if (s.state.globalRatio) facts.push(line(`Ratio **${s.state.globalRatio}**`));
  const notices = qbtNotices(input);
  return {
    kpis: [],
    charts: [],
    machine: 'after',
    notices: asNotices(notices),
    ...qbtSlots(input),
    tabs: [],
    facts,
    ...statusFrom(active ? `Downloading · ${speedWords(s.state.dlSpeedBps)}` : null),
    open: { label: 'Open qBittorrent', url: input.url },
    actions: [],
    readAt: s.readAt,
    ...(active ? { refreshS: 5 } : {}),
    suggestions: ['Slowest or stalled downloads', 'Biggest torrents on disk', 'Upload ratio this month'],
    verdict: qbtVerdict(s),
  };
}

/* Page & seen -------------------------------------------------------------------------------------------------------- */

export function qbtUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  return (str(row.fields.url) ?? row.baseUrl).replace(/\/+$/, '');
}

/** The last 15 days of the all-time downloaded figure; none when they can't be read (no Trend). */
async function downloadedPoints(services: Services, rowId: string, now: Date): Promise<RawPoint[]> {
  const got = await readPoints(services.db, rowId, [QBT_DL_KEY], now, 15 * 86_400_000).catch(() => null);
  return got?.get(QBT_DL_KEY) ?? [];
}

async function speedLine(services: Services, rowId: string, range: PageRange, now: Date) {
  const points = await readPoints(services.db, rowId, [QBT_MBPS_KEY], now, RANGE_MS[range]).catch(
    () => new Map<string, RawPoint[]>(),
  );
  const grid = onRange([points.get(QBT_MBPS_KEY) ?? []], range, now);
  return { timestamps: grid.timestamps, values: grid.values[0] ?? [] };
}

export async function qbtPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = qbtUrl(row);
  const [main, speed, downloaded] = await Promise.all([
    liveRead(
      services,
      liveKey(row),
      row,
      deadline(() => readMaindata(services, row, now)),
      { liveS: QBT_LIVE_MS / 1000 },
    ),
    speedLine(services, row.id, ctx.range, now),
    downloadedPoints(services, row.id, now),
  ]);
  if (!main.ok)
    return {
      charts: [],
      machine: 'after',
      notices: [],
      panels: [],
      tabs: [],
      facts: [],
      open: { label: 'Open qBittorrent', url },
      actions: [],
      readAt: null,
      suggestions: [],
      problem: problemOf(main.error, NAME).message,
      refreshing: main.refreshing,
    };
  const view = qbtView({
    snapshot: main.value,
    now,
    timeZone: ctx.timeZone,
    range: ctx.range,
    speed,
    who: { row },
    url,
    downloaded,
  });
  return { ...view, refreshing: main.refreshing };
}

export function qbtActivity(s: QbtSnapshot): ConnectionActivity {
  const queue = s.torrents.filter(isInQueue);
  if (!queue.length) return { active: false, value: 'Nothing downloading' };
  const active = queue.filter(isDownloading);
  const first = (active[0] ?? queue[0])?.name;
  const totalSize = queue.reduce((a, t) => a + t.sizeBytes, 0);
  const totalLeft = queue.reduce((a, t) => a + t.leftBytes, 0);
  const more = {
    ...(first ? { detail: clip(first, 120) } : {}),
    ...(totalSize > 0
      ? { progress: Math.max(0, Math.min(100, Math.round((1 - totalLeft / totalSize) * 100))) }
      : {}),
  };
  const left = `${queue.length} left`;
  if (active.length === 0) return { active: false, value: `Paused · ${left}`, ...more };
  const maxEta = active.reduce((a, t) => Math.max(a, t.etaMs ?? 0), 0);
  const time = maxEta >= 60_000 ? ` · ${span(maxEta)}` : '';
  return { active: true, value: `${left}${time}`, ...more };
}

export async function qbtSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const snapshot = await qbtSnapshot(services, row, now);
  const input: QbtInput = {
    snapshot,
    now,
    timeZone,
    range: '24h',
    speed: { timestamps: [], values: [] },
    who: { row },
    url: qbtUrl(row),
  };
  const view = { ...qbtView(input), kpis: qbtKpis(input) };
  const queue = snapshot.torrents.filter(isInQueue);
  return {
    glance: {
      ...seenFromView(view, {
        line: queue.length ? plural(queue.length, 'download') : 'Nothing downloading',
      }),
      activity: qbtActivity(snapshot),
    },
    points: {
      [QBT_MBPS_KEY]: Math.round((snapshot.state.dlSpeedBps / 1e6) * 100) / 100,
      ...downloadedPoint(snapshot),
    },
    ...linesSeen(view, qbtSkipped(snapshot)),
  };
}

/* Actions ------------------------------------------------------------------------------------------------------------ */

/** Calls qBittorrent v5's endpoint first, falling back to v4's name if the server answered with an HTTP error (404). */
async function postWithV4Fallback(
  ctx: KindActionCtx,
  v5Path: string,
  v4Path: string,
  body: string,
): Promise<void> {
  const call = (path: string) =>
    actAs(ctx.services, ctx.row, NAME, {
      method: 'POST',
      path,
      contentType: 'application/x-www-form-urlencoded',
      body,
    });
  try {
    await call(v5Path);
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.code === 'unavailable' &&
      err.message.includes('answered with an error')
    ) {
      await call(v4Path);
      return;
    }
    throw err;
  }
}

export const QBT_ACTIONS: Record<string, KindAction> = {
  async pause(ctx) {
    await postWithV4Fallback(ctx, '/api/v2/torrents/stop', '/api/v2/torrents/pause', 'hashes=all');
    return { message: 'Torrents paused.', title: 'Paused all torrents in qBittorrent', everyday: true };
  },
  async resume(ctx) {
    await postWithV4Fallback(ctx, '/api/v2/torrents/start', '/api/v2/torrents/resume', 'hashes=all');
    return { message: 'Torrents resumed.', title: 'Resumed all torrents in qBittorrent', everyday: true };
  },
  async toggle_alt_speed(ctx) {
    await actAs(ctx.services, ctx.row, NAME, {
      method: 'POST',
      path: '/api/v2/transfer/toggleSpeedLimitsMode',
    });
    return {
      message: 'Switched qBittorrent’s speed limit mode.',
      title: 'Switched speed limit mode in qBittorrent',
      everyday: true,
    };
  },
};

export const QBITTORRENT_KIND: KindModule = {
  activityLine: 'The queue and time left',
  page: qbtPage,
  prefetch: (services, row, now) => qbtSnapshot(services, row, now),
  seen: qbtSeen,
  asksFirst: 'deleting torrents, settings and shutting down ask first',
  actions: QBT_ACTIONS,
  liveS: QBT_LIVE_MS / 1000,
  checks: QBT_CHECKS,
};
