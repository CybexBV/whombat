/**
 * ESPHome's page (service-dashboards.md SD-31, SD-S14): its Device Builder (2026.6 and later) over its WebSocket `/ws`,
 * the same dialect and sign-in as the connection's `call` tool (connections-more.md CM-07, CM-13; `connections/socket/
 * esphome.ts`): `devices/list` (each device's runtime state — online, offline or not seen, since when, the ESPHome it
 * runs, its addresses — whether it was built with an older ESPHome, whether its YAML changed since it was installed) and
 * `firmware/get_jobs` (installs that run now, with how far, and those that failed), one socket per read, kept 30 seconds.
 *
 * Its Summary in slots: To update (installs running, then each device to update or install with its **Update** or
 * **Install** button, confirmed, and **Update all** on the card: `firmware/install`, `firmware/install_bulk` over the
 * network, which builds, flashes and restarts the device), or Devices now while nothing waits (offline ones first) beside
 * In ESPHome (devices, up to date, changed since
 * installed, found on the network); its version in the machine's card when Whombat knows that machine (else only in
 * the head); every device in a table below. ESPHome keeps no
 * history and knows no people: no Trend, Shelf or People. Nothing else is ever sent from here (no renames, secrets or
 * deletes).
 */
import type {
  JsonValue,
  ThingLine,
  ThingPageBar,
  ThingPageItem,
  ThingPageKpi,
  ThingPageRow,
} from '@whombat/core';
import { catalogEntry } from '@whombat/core';
import { externalEffect } from '../../../commit/scope';
import { resolveCredential } from '../../../connections/credentials';
import { connectionPolicy } from '../../../connections/destination';
import { pinOf } from '../../../connections/http';
import { socketLogin } from '../../../connections/socket/call';
import { openChannel, SocketClosed, SocketUpgradeRefused } from '../../../connections/socket/channel';
import {
  SocketProtocolError,
  type SocketSession,
  SocketSignInRefused,
} from '../../../connections/socket/dialect';
import { esphomeSession } from '../../../connections/socket/esphome';
import { fillLoginParams, socketHttpUrl } from '../../../connections/socket/spec';
import type { CatalogConnectionRow } from '../../../connections/types';
import { ApiError, badRequest, conflict } from '../../../lib/errors';
import { OutboundError } from '../../../lib/outbound';
import type { Services } from '../../../services';
import { summarise } from '../../../vault/net';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { clip, clock, dateOf, line, list, num, plural, rec, span, str, thousands, when } from '../../words';
import { cachedRead, KIND_DEADLINE_MS, latestRead, problemOf, ReadProblem, withDeadline } from '../read';
import { type KindAction, type KindModule, type KindSeen, seenFromView } from '../registry';
import { countLine, type InventoryPanel, inventory, type LivePanel, liveList, slotPanels } from '../slots';
import type { KindCtx, KindView } from '../types';
import { itemLines, lineId, subjectName } from './lines';
import { type ButtonCtx, button, type ThingPageButton } from './shapes';

const NAME = 'ESPHome';
const DAY_S = 86_400;

export interface EspDevice {
  /** Its YAML file: how ESPHome names a device (`kitchen.yaml`). */
  config: string;
  name: string;
  state: 'online' | 'offline' | 'unknown';
  /** How long it has been offline when it was read. */
  offlineSeconds: number | null;
  /** The ESPHome it runs, and the one the Builder has. */
  deployed: string | null;
  current: string | null;
  address: string | null;
  /** Built with an older ESPHome than the Builder's. */
  update: boolean;
  /** Its YAML changed since it was installed. */
  pending: boolean;
  /** Its chip (`esp32`, `esp8266`, `rp2040`). */
  platform?: string | null;
  /** An update waits for it to come back online. */
  queued?: boolean;
}

export interface EspJob {
  id: string;
  config: string;
  type: string;
  /** `queued`, `running`, `completed`, `failed`, `cancelled`. */
  status: string;
  at: Date | null;
  /** How far a running one is, 0–100; null while the build doesn't say. */
  progress?: number | null;
}

export interface EspSnapshot {
  readAt: Date;
  version: string | null;
  devices: EspDevice[];
  jobs: EspJob[] | null;
  /** Devices the Builder found on the network that aren't added yet. */
  importable?: number;
}

/* Reading ------------------------------------------------------------------------------------------------------------ */

/** `devices/list`'s configured devices. */
export function parseDevices(raw: unknown): EspDevice[] {
  return list(rec(raw).configured)
    .map(rec)
    .map((d): EspDevice => {
      const rs = rec(d.runtime_state);
      const state = str(rs.state);
      return {
        config: str(d.configuration) ?? '',
        name: str(d.friendly_name) ?? str(d.name) ?? str(d.configuration) ?? 'Device',
        state: state === 'online' || state === 'offline' ? state : 'unknown',
        offlineSeconds: num(rs.offline_seconds),
        deployed: str(rs.deployed_version),
        current: str(d.current_version),
        address:
          list(rs.ip_addresses).find((a): a is string => typeof a === 'string') ??
          str(d.ip) ??
          str(d.address),
        update: d.update_available === true,
        pending: d.has_pending_changes === true,
        platform: str(d.target_platform),
        queued: rs.queued_update === true,
      };
    })
    .filter((d) => d.config);
}

/** How many devices `devices/list` found on the network that aren't added (`importable`). */
export const importableOf = (raw: unknown): number => list(rec(raw).importable).length;

/** `firmware/get_jobs`. */
export function parseJobs(raw: unknown): EspJob[] {
  return list(raw)
    .map(rec)
    .map((j) => ({
      id: str(j.job_id) ?? '',
      config: str(j.configuration) ?? '',
      type: str(j.job_type) ?? '',
      status: str(j.status) ?? '',
      at: dateOf(j.completed_at) ?? dateOf(j.started_at) ?? dateOf(j.created_at),
      progress: num(j.progress),
    }))
    .filter((j) => j.id && j.config);
}

/** Why a socket failed, as a `ReadProblem` (or an `ApiError` for a button). */
function socketProblem(err: unknown): ReadProblem {
  const missing = catalogEntry('esphome')?.socket?.missing ?? 'This ESPHome dashboard is too old.';
  if (err instanceof ReadProblem) return err;
  if (err instanceof SocketSignInRefused)
    return err.reason === 'locked'
      ? new ReadProblem('ESPHome paused sign-ins after too many tries. Try again in a few minutes.')
      : new ReadProblem('ESPHome refused Whombat’s sign-in.', true);
  if (err instanceof SocketUpgradeRefused)
    return err.refused
      ? new ReadProblem('ESPHome refused Whombat’s sign-in.', true)
      : new ReadProblem(missing);
  if (err instanceof SocketProtocolError)
    return new ReadProblem(err.missing ? missing : 'ESPHome didn’t answer as expected.');
  if (err instanceof SocketClosed)
    return new ReadProblem('ESPHome closed the connection before it answered.');
  if (err instanceof OutboundError) return problemOf(summarise(err), NAME);
  return problemOf(err, NAME);
}

/** A call on an open session: its result, or the Builder's error code as an `Error`. */
export type EspCall = (method: string, args?: JsonValue) => Promise<unknown>;

export class EspCallFailed extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'EspCallFailed';
  }
}

/**
 * Opens the Builder's socket as the connection (its policy and pinned certificate), signs in when it asks, and runs
 * `work` with its commands one after another; the socket is closed whatever happens. Throws `ReadProblem`.
 */
export async function withEsphome<T>(
  services: Services,
  row: CatalogConnectionRow,
  deadlineMs: number,
  work: (call: EspCall, version: string | null) => Promise<T>,
  effect = 'things.read',
): Promise<T> {
  const spec = catalogEntry('esphome')?.socket;
  if (!spec) throw new ReadProblem('Whombat doesn’t know ESPHome’s socket.');
  const deadlineAt = Date.now() + deadlineMs;
  try {
    const { credential } = await resolveCredential(services, row);
    const login = socketLogin(credential, row.fields);
    return await externalEffect(
      effect,
      async () => {
        const url = socketHttpUrl(row.baseUrl, spec);
        const policy = await connectionPolicy(services, url, { ...pinOf(row), deadlineMs });
        const channel = await openChannel(url, policy, { connectMs: Math.min(10_000, deadlineMs) });
        try {
          const session: SocketSession = await esphomeSession(channel, deadlineAt);
          const signIn = spec.login;
          if (signIn && (signIn.when !== 'asked' || session.hello.asksSignIn)) {
            if (!login) throw new SocketSignInRefused('needed');
            const params = fillLoginParams(signIn.params, login);
            if (params === null) throw new SocketSignInRefused('needed');
            await session.signIn(signIn.method, params, deadlineAt);
          }
          const call: EspCall = async (method, args) => {
            const reply = await session.call(method, args ?? {}, { deadlineAt });
            if (!reply.ok) throw new EspCallFailed(reply.code ?? 'error');
            return reply.result;
          };
          return await work(call, session.hello.version);
        } finally {
          channel.close();
        }
      },
      { idempotent: effect === 'things.read' },
    );
  } catch (err) {
    if (err instanceof EspCallFailed || err instanceof ApiError) throw err;
    throw socketProblem(err);
  }
}

async function readEsphome(services: Services, row: CatalogConnectionRow, now: Date): Promise<EspSnapshot> {
  return withEsphome(services, row, KIND_DEADLINE_MS, async (call, version) => {
    const raw = await call('devices/list');
    const devices = parseDevices(raw);
    const jobs = await call('firmware/get_jobs').then(parseJobs, () => null);
    return { readAt: now, version, devices, jobs, importable: importableOf(raw) };
  });
}

function loadEsphome(services: Services, row: CatalogConnectionRow, now: Date) {
  return async (): Promise<EspSnapshot> => {
    try {
      return await withDeadline(
        readEsphome(services, row, now),
        KIND_DEADLINE_MS,
        'ESPHome didn’t answer in time.',
      );
    } catch (err) {
      if (err instanceof EspCallFailed) {
        if (err.code === 'not_authenticated')
          throw new ReadProblem('ESPHome refused Whombat’s sign-in.', true);
        throw new ReadProblem('ESPHome answered with an error.');
      }
      throw socketProblem(err);
    }
  };
}

export const esphomeLatest = (services: Services, row: CatalogConnectionRow, now = services.clock()) =>
  latestRead(services, `esphome:${row.id}`, row, loadEsphome(services, row, now));

export const esphomeSnapshot = (services: Services, row: CatalogConnectionRow, now = services.clock()) =>
  cachedRead(services, `esphome:${row.id}`, row, loadEsphome(services, row, now));

/* What it means ------------------------------------------------------------------------------------------------------- */

/** When it went offline, from its age at the read. */
export function offlineSince(d: EspDevice, readAt: Date): Date | null {
  return d.state === 'offline' && d.offlineSeconds !== null
    ? new Date(readAt.getTime() - d.offlineSeconds * 1000)
    : null;
}

/** Installs whose last job failed within the last day, one per device. */
export function failedInstalls(s: EspSnapshot, now: Date): EspJob[] {
  const last = new Map<string, EspJob>();
  for (const j of (s.jobs ?? []).slice().sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0)))
    if (j.status !== 'cancelled') last.set(j.config, j);
  const known = new Set(s.devices.map((d) => d.config));
  return [...last.values()].filter(
    (j) =>
      j.status === 'failed' && known.has(j.config) && j.at && now.getTime() - j.at.getTime() < DAY_S * 1000,
  );
}

/** A device needs an install: built with an older ESPHome, or its YAML changed. */
export const needsInstall = (d: EspDevice) => d.update || d.pending;

/** The four figures (SD-31). In slots only the card shows them. */
export function esphomeKpis(s: EspSnapshot): ThingPageKpi[] {
  const online = s.devices.filter((d) => d.state === 'online').length;
  const offline = s.devices.filter((d) => d.state === 'offline').length;
  const unseen = s.devices.length - online - offline;
  const updates = s.devices.filter((d) => d.update).length;
  const pending = s.devices.filter((d) => d.pending).length;
  const out: ThingPageKpi[] = [
    {
      key: 'online',
      label: 'Online',
      value: String(online),
      rest: `of ${s.devices.length}`,
      ...(s.devices.length ? { meter: online / s.devices.length } : {}),
      ...(offline
        ? { sub: `${offline} offline`, tone: 'warn' as const }
        : unseen
          ? { sub: `${unseen} not seen yet` }
          : { sub: 'all online', color: 'green' as const }),
    },
    {
      key: 'updates',
      label: 'Updates',
      value: String(updates),
      sub: updates ? 'built with an older ESPHome' : 'all up to date',
    },
    {
      key: 'pending',
      label: 'Not installed',
      value: String(pending),
      sub: pending ? 'changed since' : 'all installed',
    },
  ];
  if (s.version) out.push({ key: 'version', label: 'ESPHome', value: s.version });
  return out;
}

/** Every check ESPHome raises (What Whombat watches, QN-15). */
export const ESPHOME_CHECKS: readonly KindCheck[] = [
  {
    check: 'esphome.device_offline',
    name: 'Devices going offline',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'esphome.install_failed',
    name: 'Installs that fail',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'esphome.older',
    name: 'Devices on an older ESPHome',
    nature: 'fyi',
    perItem: true,
    startsOn: false,
  },
];

/** Offline longer than this, a device is most likely unplugged on purpose: a heads-up (QN-04). */
export const AWAY_S = 7 * DAY_S;

const deviceSubject = (config: string, name: string) => ({
  id: `device:${config}`.slice(0, 160),
  name: subjectName(name),
});

/**
 * “Worth a look” (SD-31, QN-01…QN-04), one line per device: offline, a problem after two passes in a row (a restart, a
 * flash) and a heads-up after a week (unplugged for the season, a sensor on a shelf); the last install failed within
 * the day, until another one fails; built with an older ESPHome, a heads-up until the next ESPHome.
 */
export function esphomeNotices(s: EspSnapshot, now: Date, timeZone: string): KindNotice[] {
  const out: KindNotice[] = [];
  const offline = s.devices
    .filter((d) => d.state === 'offline')
    .sort((a, b) => (a.offlineSeconds ?? 0) - (b.offlineSeconds ?? 0) || a.name.localeCompare(b.name));
  out.push(
    ...itemLines(
      offline,
      (d) => deviceSubject(d.config, d.name).id,
      (d) => {
        const since = offlineSince(d, s.readAt);
        const away = (d.offlineSeconds ?? 0) > AWAY_S;
        const title = clip(
          `${d.name} is offline${since ? ` since ${moment(since, now, timeZone)}` : ''}`,
          120,
        );
        return {
          id: lineId('offline', d.config),
          tone: away ? 'info' : 'warn',
          icon: 'device',
          title,
          ...(away
            ? {
                detail: clip(
                  `Gone for ${span((d.offlineSeconds ?? 0) * 1000)}. Unplugged on purpose? Stop watching it.`,
                  200,
                ),
              }
            : {
                link: {
                  kind: 'ask' as const,
                  label: 'Look into it',
                  question: clip(`Why is my ESPHome device ${d.name} offline?`, 300),
                },
              }),
          nature: away ? 'fyi' : 'problem',
          check: 'esphome.device_offline',
          subject: deviceSubject(d.config, d.name),
          ignore: { lifts: 'fixed', words: 'Until it’s back online.' },
          confirm: 2,
          ...(title.length > 40 ? { badge: 'A device is offline' } : {}),
        };
      },
      (more, subject, episode) => {
        const away = more.every((d) => (d.offlineSeconds ?? 0) > AWAY_S);
        return {
          id: 'offline-more',
          tone: away ? 'info' : 'warn',
          icon: 'device',
          title: `${more.length} more devices offline`,
          detail: clip(more.map((d) => d.name).join(' · '), 200),
          ...(away
            ? {}
            : {
                link: {
                  kind: 'ask' as const,
                  label: 'Look into it',
                  question: `Why are ${more.length} of my ESPHome devices offline?`,
                },
              }),
          nature: away ? 'fyi' : 'problem',
          check: 'esphome.device_offline',
          subject,
          episode,
          ignore: { lifts: 'newer', words: 'Until the list changes.' },
          confirm: 2,
          badge: 'Devices are offline',
        };
      },
    ),
  );
  const names = new Map(s.devices.map((d) => [d.config, d.name]));
  out.push(
    ...itemLines(
      failedInstalls(s, now),
      (j) => `${j.config}@${j.id}`,
      (j) => {
        const name = names.get(j.config) ?? j.config;
        const title = clip(`Installing ${name} failed`, 120);
        return {
          id: lineId('failed', j.config),
          tone: 'warn',
          icon: 'update',
          title,
          ...(j.at
            ? {
                detail: `${j.type === 'compile' ? 'Building it' : 'Sending it to the device'} failed · ${when(j.at, now, timeZone)}`,
              }
            : {}),
          link: {
            kind: 'ask',
            label: 'Look into it',
            question: clip(`Why did installing ${name} (${j.config}) in ESPHome fail?`, 300),
          },
          nature: 'problem',
          check: 'esphome.install_failed',
          subject: deviceSubject(j.config, name),
          // Each install is a job of its own: another one failing is a new line.
          ignore: { lifts: 'newer', words: 'Until an install fails again.' },
          episode: j.id,
          ...(title.length > 40 ? { badge: 'An install failed' } : {}),
        };
      },
      (more, subject, episode) => ({
        id: 'failed-more',
        tone: 'warn',
        icon: 'update',
        title: `${more.length} more installs failed`,
        detail: clip(more.map((j) => names.get(j.config) ?? j.config).join(' · '), 200),
        link: { kind: 'ask', label: 'Look into it', question: 'Why do my ESPHome installs fail?' },
        nature: 'problem',
        check: 'esphome.install_failed',
        subject,
        episode,
        ignore: { lifts: 'newer', words: 'Until an install fails again.' },
        badge: 'Installs failed',
      }),
    ),
  );
  const builder = s.version ?? '';
  out.push(
    ...itemLines(
      s.devices.filter((d) => d.update),
      (d) => `${deviceSubject(d.config, d.name).id}@${builder}`,
      (d) => ({
        id: lineId('older', d.config),
        tone: 'info',
        icon: 'update',
        title: clip(`${d.name} is built with an older ESPHome`, 120),
        ...(s.version
          ? { detail: `ESPHome ${s.version} is here${d.deployed ? `; it runs ${d.deployed}` : ''}.` }
          : {}),
        nature: 'fyi',
        check: 'esphome.older',
        subject: deviceSubject(d.config, d.name),
        ignore: { lifts: 'newer', words: 'Until the next ESPHome.' },
        episode: builder,
      }),
      (more, subject, episode) => ({
        id: 'older-more',
        tone: 'info',
        icon: 'update',
        title: `${more.length} more devices built with an older ESPHome`,
        ...(s.version ? { detail: `ESPHome ${s.version} is here: Update all builds them again.` } : {}),
        nature: 'fyi',
        check: 'esphome.older',
        subject,
        episode,
        ignore: { lifts: 'newer', words: 'Until the list changes.' },
      }),
    ),
  );
  return out;
}

/** The checks this read couldn't see (QN-S21): the Builder's jobs. */
export function esphomeSkipped(s: EspSnapshot): string[] {
  return s.jobs ? [] : ['esphome.install_failed'];
}

/** “14:02” today, else “Yesterday 22:10” or “17 Oct”. */
function moment(at: Date, now: Date, timeZone: string): string {
  const w = when(at, now, timeZone);
  return w.startsWith('Today ') ? clock(at, timeZone) : w;
}

/** A device's Update (or Install) button, confirmed (SD-31). */
export function installButton(d: EspDevice, bctx: ButtonCtx): ThingPageButton | null {
  if (!needsInstall(d)) return null;
  const label = d.update ? 'Update' : 'Install';
  return button(bctx, {
    action: 'install',
    target: d.config,
    label,
    icon: 'up',
    confirm: {
      title: clip(`${label} ${d.name}?`, 80),
      body: 'ESPHome builds its firmware and sends it over the network. The device restarts and is gone for a moment.',
      button: label,
    },
  });
}

/** **Update all** on To update (SD-31): every device built with an older ESPHome. */
export function updateAllButton(s: EspSnapshot, bctx: ButtonCtx): ThingPageButton | null {
  const n = s.devices.filter((d) => d.update).length;
  if (!n) return null;
  return button(bctx, {
    action: 'install-all',
    label: 'Update all',
    icon: 'up',
    confirm: {
      title: `Update ${plural(n, 'device')}?`,
      body: 'ESPHome builds each one’s firmware and sends it over the network, one after another. Each restarts; one that is offline gets it when it is back.',
      button: 'Update all',
    },
  });
}

const STATE_RANK = { offline: 0, unknown: 1, online: 2 } as const;

/** The devices (SD-31): offline first, then those that need an install. */
export function deviceRows(s: EspSnapshot, now: Date, timeZone: string, bctx: ButtonCtx): ThingPageRow[] {
  return s.devices
    .slice()
    .sort(
      (a, b) =>
        STATE_RANK[a.state] - STATE_RANK[b.state] ||
        Number(needsInstall(b)) - Number(needsInstall(a)) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 300)
    .map((d) => {
      const since = offlineSince(d, s.readAt);
      const install = installButton(d, bctx);
      return {
        id: d.config.slice(0, 200),
        cells: {
          name: { text: clip(d.name, 200), note: clip(d.config, 80) },
          state:
            d.state === 'online'
              ? { text: 'Online', dot: 'ok' as const }
              : d.state === 'offline'
                ? {
                    text: 'Offline',
                    dot: (d.offlineSeconds ?? 0) > DAY_S ? ('bad' as const) : ('warn' as const),
                    ...(since ? { note: `since ${moment(since, now, timeZone)}` } : {}),
                  }
                : { text: 'Not seen', dot: 'off' as const },
          version: {
            text: d.deployed ?? '',
            mono: true,
            ...(d.update ? { note: 'older', tone: 'warn' as const } : d.pending ? { note: 'changed' } : {}),
          },
          address: { text: d.address ?? '', mono: true },
          ...(install ? { install: { text: install.label, action: install } } : {}),
        },
      };
    });
}

function facts(s: EspSnapshot): ThingLine[] {
  return s.version ? [line(`ESPHome **${s.version}**`)] : [];
}

/** Installs going on now, one per device: the running one first, else the one waiting its turn. */
export function activeJobs(s: EspSnapshot): Map<string, EspJob> {
  const out = new Map<string, EspJob>();
  for (const j of s.jobs ?? []) {
    if (j.status !== 'running' && j.status !== 'queued') continue;
    const had = out.get(j.config);
    if (!had || (had.status !== 'running' && j.status === 'running')) out.set(j.config, j);
  }
  return out;
}

/** What a device's install does now: “Building it”, “Sending it to the device”, “Waiting its turn”. */
function jobWords(j: EspJob): string {
  if (j.status === 'queued') return 'Waiting its turn';
  if (j.type === 'upload') return 'Sending it to the device';
  if (j.type === 'compile') return 'Building it';
  return 'Working on it';
}

/** A device's line in To update: what it runs and why it needs an install, offline ones amber. */
function needWords(d: EspDevice, s: EspSnapshot, now: Date, timeZone: string): string {
  const why = d.update
    ? d.deployed
      ? `Runs ${d.deployed}`
      : 'Built with an older ESPHome'
    : 'Changed since it was installed';
  const since = offlineSince(d, s.readAt);
  const where =
    d.state === 'offline'
      ? d.queued
        ? 'Waits until it’s back'
        : since
          ? `Offline since ${moment(since, now, timeZone)}`
          : 'Offline'
      : d.state === 'unknown'
        ? 'Not seen yet'
        : null;
  return [why, where].filter(Boolean).join(' · ');
}

/** How many devices Devices now lists: about as tall as In ESPHome beside it. */
const NOW_ROWS = 6;

/**
 * Live while nothing waits for an install, “Devices now” (id `now`): the devices offline longest first, then those not
 * seen yet, then the online ones by name, each with what it runs and where. Null without devices.
 */
export function devicesNow(s: EspSnapshot, ctx: { now: Date; timeZone: string }): LivePanel | null {
  if (!s.devices.length) return null;
  const sorted = s.devices
    .slice()
    .sort(
      (a, b) =>
        STATE_RANK[a.state] - STATE_RANK[b.state] ||
        (b.offlineSeconds ?? 0) - (a.offlineSeconds ?? 0) ||
        a.name.localeCompare(b.name),
    );
  const online = s.devices.filter((d) => d.state === 'online').length;
  const offline = s.devices.filter((d) => d.state === 'offline').length;
  const items: ThingPageItem[] = sorted.slice(0, NOW_ROWS).map((d) => {
    const since = offlineSince(d, s.readAt);
    const state =
      d.state === 'online'
        ? 'Online'
        : d.state === 'offline'
          ? since
            ? `Offline since ${moment(since, ctx.now, ctx.timeZone)}`
            : 'Offline'
          : 'Not seen yet';
    return {
      id: clip(`now-${d.config}`, 200),
      title: clip(d.name, 160),
      icon: 'device',
      detail: clip([state, d.deployed, d.address].filter(Boolean).join(' · '), 300),
      ...(d.state === 'offline'
        ? { tone: 'warn' as const }
        : d.state === 'online'
          ? { tone: 'ok' as const }
          : {}),
    };
  });
  const meta =
    online === s.devices.length
      ? `All ${s.devices.length} online`
      : [`${online} online`, offline ? `${offline} offline` : null].filter(Boolean).join(' · ');
  return liveList({
    id: 'now',
    title: 'Devices now',
    // Every device is in the table below.
    meta: clip(meta, 120),
    items,
  });
}

/**
 * Live, “To update”: installs going on now with how far they are, then each device built with an older ESPHome or
 * changed since it was installed, with its button; **Update all** on the card. While nothing waits or runs, Devices now.
 */
export function esphomeLive(
  s: EspSnapshot,
  ctx: { now: Date; timeZone: string; buttons: ButtonCtx },
): LivePanel | null {
  const active = activeJobs(s);
  const items: ThingPageItem[] = [];
  const byConfig = new Map(s.devices.map((d) => [d.config, d]));
  for (const [config, j] of active) {
    const d = byConfig.get(config);
    items.push({
      id: `job-${j.id}`.slice(0, 200),
      title: clip(d?.name ?? config, 160),
      icon: 'update',
      detail: jobWords(j),
      ...(j.status === 'running' && j.progress != null ? { right: `${Math.round(j.progress)} %` } : {}),
      tone: 'info',
    });
  }
  const waiting = s.devices
    .filter((d) => needsInstall(d) && !active.has(d.config))
    .sort(
      (a, b) =>
        STATE_RANK[b.state] - STATE_RANK[a.state] ||
        Number(b.update) - Number(a.update) ||
        a.name.localeCompare(b.name),
    );
  for (const d of waiting.slice(0, 40)) {
    const b = installButton(d, ctx.buttons);
    items.push({
      id: d.config.slice(0, 200),
      title: clip(d.name, 160),
      icon: 'device',
      detail: clip(needWords(d, s, ctx.now, ctx.timeZone), 300),
      ...(d.state === 'offline' && !d.queued ? { tone: 'warn' as const } : {}),
      ...(b ? { actions: [b] } : {}),
    });
  }
  if (!items.length) return devicesNow(s, ctx);
  const all = updateAllButton(s, ctx.buttons);
  const meta = [
    active.size ? `${active.size} installing` : '',
    waiting.length ? `${waiting.length} waiting` : '',
    s.version && s.devices.some((d) => d.update) ? `ESPHome ${s.version} is here` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return liveList({
    id: 'updates',
    title: 'To update',
    ...(meta ? { meta: clip(meta, 120) } : {}),
    ...(all ? { buttons: [all] } : {}),
    items,
  });
}

const PLATFORM: Record<string, string> = {
  esp32: 'ESP32',
  esp8266: 'ESP8266',
  rp2040: 'RP2040',
  bk72xx: 'BK72xx',
  rtl87xx: 'RTL87xx',
  ln882x: 'LN882x',
  nrf52: 'nRF52',
  host: 'computer',
};

/** “18 ESP32 · 6 ESP8266”: the chips, most first. */
function platformWords(s: EspSnapshot): string | null {
  const by = new Map<string, number>();
  for (const d of s.devices)
    if (d.platform) {
      const k = PLATFORM[d.platform.toLowerCase()] ?? d.platform;
      by.set(k, (by.get(k) ?? 0) + 1);
    }
  if (!by.size) return null;
  return [...by]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, n]) => `${n} ${k}`)
    .join(' · ');
}

/** Inventory, “In ESPHome”: the devices (offline ones amber), how many run this ESPHome, changed ones, found ones. */
export function esphomeInventory(s: EspSnapshot, openUrl: string | null): InventoryPanel | null {
  const url = openUrl ? { url: openUrl } : {};
  const online = s.devices.filter((d) => d.state === 'online').length;
  const offline = s.devices.filter((d) => d.state === 'offline').length;
  const unseen = s.devices.length - online - offline;
  const platforms = platformWords(s);
  const items: ThingPageItem[] = [
    countLine({
      id: 'devices',
      title: 'Devices',
      icon: 'device',
      value: thousands(s.devices.length),
      ...(platforms ? { detail: platforms } : {}),
      ...(!s.devices.length
        ? {}
        : offline
          ? { note: `${offline} offline`, noteTone: 'warn' as const }
          : unseen
            ? { note: `${unseen} not seen yet` }
            : { note: 'All online', noteTone: 'ok' as const }),
      ...url,
    }),
  ];
  if (s.devices.length) {
    const older = s.devices.filter((d) => d.update).length;
    items.push(
      countLine({
        id: 'up-to-date',
        title: 'Up to date',
        icon: 'update',
        value: thousands(s.devices.length - older),
        ...(older
          ? { note: `${older} on an older ESPHome`, noteTone: 'warn' as const }
          : { note: s.version ? `All on ${s.version}` : 'All of them', noteTone: 'ok' as const }),
        ...url,
      }),
    );
  }
  const pending = s.devices.filter((d) => d.pending).length;
  if (pending)
    items.push(
      countLine({
        id: 'changed',
        title: 'Changed since installed',
        icon: 'log',
        value: thousands(pending),
        note: 'Install to use it',
        ...url,
      }),
    );
  if (s.importable)
    items.push(
      countLine({
        id: 'found',
        title: 'Found on the network',
        icon: 'network',
        value: thousands(s.importable),
        note: 'Not added yet',
        ...url,
      }),
    );
  return inventory({ id: 'inventory', title: 'In ESPHome', items });
}

/** Its own line in the machine's card: the Builder's ESPHome and how many devices run it. */
export function esphomeMachineLines(s: EspSnapshot): ThingPageBar[] {
  if (!s.version) return [];
  const on = s.devices.filter((d) => !d.update && d.deployed).length;
  const known = s.devices.filter((d) => d.deployed).length;
  return [
    {
      id: 'esphome-version',
      label: 'ESPHome',
      value: clip(s.version, 40),
      pct: null,
      ...(known
        ? {
            sub: clip(`${on} of ${known} devices on it`, 120),
            ...(on === known ? { subTone: 'ok' as const } : {}),
          }
        : {}),
    },
  ];
}

/** The sentence under the name while it is fine. */
export function esphomeVerdict(s: EspSnapshot): string {
  const n = s.devices.length;
  if (!n) return 'ESPHome is fine.';
  const online = s.devices.filter((d) => d.state === 'online').length;
  const older = s.devices.filter((d) => d.update).length;
  const all = n === 1 ? 'the device is' : `all ${n} devices are`;
  if (online === n && !older) return `ESPHome is fine: ${all} online and up to date.`;
  if (online === n) return `ESPHome is fine: ${all} online, ${older} can be updated.`;
  return `ESPHome is fine: ${online} of ${n} devices are online.`;
}

export function esphomeView(
  s: EspSnapshot,
  ctx: {
    now: Date;
    timeZone: string;
    buttons: ButtonCtx;
    openUrl?: string | null;
    /** Whombat knows the machine it runs on (Docker on a server it watches): its card gets ESPHome's line. */
    knownMachine?: boolean;
  },
): Pick<
  KindView,
  'kpis' | 'charts' | 'notices' | 'panels' | 'slots' | 'facts' | 'status' | 'machine' | 'verdict' | 'refreshS'
> & {
  buttons: ThingPageButton[];
} {
  const running = [...activeJobs(s).values()].some((j) => j.status === 'running');
  return {
    // In slots its counts are in In ESPHome; the card keeps the figures (`esphomeSeen`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: esphomeNotices(s, ctx.now, ctx.timeZone),
    ...slotPanels({
      live: esphomeLive(s, ctx),
      inventory: esphomeInventory(s, ctx.openUrl ?? null),
      more: [
        {
          kind: 'table',
          id: 'devices',
          place: 'main',
          title: 'Devices',
          meta: plural(s.devices.length, 'device'),
          columns: [
            { key: 'name', label: 'Device' },
            { key: 'state', label: 'State' },
            { key: 'version', label: 'ESPHome' },
            { key: 'address', label: 'Address' },
            { key: 'install', label: '' },
          ],
          rows: deviceRows(s, ctx.now, ctx.timeZone, ctx.buttons),
          empty: 'No devices in ESPHome yet.',
        },
      ],
      // Without a known machine the head says the version and Up to date how many run it: no card of one line.
      machine: ctx.knownMachine ? esphomeMachineLines(s) : [],
    }),
    facts: facts(s),
    verdict: esphomeVerdict(s),
    // An install running: the page asks again every 5 seconds for how far it is.
    ...(running ? { refreshS: 5 } : {}),
    // Update all is on To update.
    buttons: [],
  };
}

export async function esphomePage(ctx: KindCtx): Promise<KindView> {
  const read = await esphomeLatest(ctx.services, ctx.row, ctx.now);
  const base: KindView = {
    notices: [],
    panels: [],
    tabs: [],
    facts: [],
    open: { label: 'Open ESPHome', url: (ctx.row.fields.url ?? ctx.row.baseUrl).replace(/\/+$/, '') },
    actions: [],
    readAt: null,
    charts: [],
    machine: 'after',
    suggestions: ['Devices offline this week', 'Which devices need an update'],
    refreshing: read.refreshing,
  };
  if (!read.ok) return { ...base, problem: problemOf(read.error, NAME).message };
  const view = esphomeView(read.value, {
    now: ctx.now,
    timeZone: ctx.timeZone,
    buttons: ctx,
    openUrl: base.open?.url ?? null,
    knownMachine: !!ctx.machine,
  });
  return { ...base, ...view, readAt: read.value.readAt };
}

/** The card (SD-31): Online, Updates, from its own figures (the page in slots has none). */
export async function esphomeSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const s = await esphomeSnapshot(services, row, now);
  const notices = esphomeNotices(s, now, timeZone);
  return {
    glance: seenFromView(
      { kpis: esphomeKpis(s), notices },
      { figures: 2, ...(s.version ? { line: `ESPHome ${s.version}` } : {}) },
    ),
    points: {},
    notices,
    skipped: esphomeSkipped(s),
  };
}

/* Buttons ------------------------------------------------------------------------------------------------------------ */

/** A button's socket failure in plain words. */
function actionError(err: unknown, what: string): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof EspCallFailed)
    return err.code === 'not_authenticated'
      ? conflict('ESPHome refused Whombat’s sign-in. Connect it again first.')
      : new ApiError('unavailable', `ESPHome answered with an error and didn’t ${what}.`);
  if (err instanceof ReadProblem)
    return err.refused
      ? conflict(`${err.message} Connect it again first.`)
      : new ApiError('unavailable', err.message);
  return new ApiError('unavailable', 'Whombat couldn’t reach ESPHome just now.');
}

/** Builds and installs one device's firmware over the network (SD-31): only a device of the list that needs it. */
const install: KindAction = async ({ services, row }, { target }) => {
  if (typeof target !== 'string' || !target) throw badRequest('Say which device to update.');
  try {
    return await withEsphome(
      services,
      row,
      30_000,
      async (call) => {
        const devices = parseDevices(await call('devices/list'));
        const d = devices.find((x) => x.config === target);
        if (!d) throw badRequest('ESPHome has no such device any more.');
        if (!needsInstall(d)) throw conflict(`${d.name} is up to date already.`);
        await call('firmware/install', { configuration: d.config, port: 'OTA' });
        const label = d.update ? 'Updating' : 'Installing';
        return {
          message: `${label} ${d.name}. ESPHome builds it first; it restarts in a few minutes.`,
          title: clip(`${d.update ? 'Updated' : 'Installed'} ${d.name} in ESPHome`, 200),
        };
      },
      'things.control',
    );
  } catch (err) {
    throw actionError(err, 'start the install');
  }
};

/** Builds and installs every device built with an older ESPHome (SD-31). */
const installAll: KindAction = async ({ services, row }) => {
  try {
    return await withEsphome(
      services,
      row,
      30_000,
      async (call) => {
        const devices = parseDevices(await call('devices/list')).filter((d) => d.update);
        if (!devices.length) throw conflict('Every device is up to date already.');
        await call('firmware/install_bulk', { configurations: devices.map((d) => d.config), port: 'OTA' });
        return {
          message: `Updating ${plural(devices.length, 'device')}. ESPHome builds them one after another; each restarts when its turn comes.`,
          title: `Updated ${plural(devices.length, 'device')} in ESPHome`,
        };
      },
      'things.control',
    );
  } catch (err) {
    throw actionError(err, 'start the updates');
  }
};

export const ESPHOME_ACTIONS: Record<string, KindAction> = { install, 'install-all': installAll };

export const ESPHOME_KIND: KindModule = {
  page: esphomePage,
  prefetch: (services, row, now) => esphomeLatest(services, row, now),
  seen: esphomeSeen,
  asksFirst: 'flashing and renaming devices ask first',
  actions: ESPHOME_ACTIONS,
  checks: ESPHOME_CHECKS,
};
