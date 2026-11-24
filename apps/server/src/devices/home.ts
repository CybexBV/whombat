/**
 * Devices on a person's Home (docs/decisions/one-whombat.md ONE-04, ONE-05; one-whombat-devices.md ONE-DD10…DD12):
 *
 * - **Your things**: a device being learned (its card waiting for the person) shows “learning”; a switched-on device
 *   shows with its status from the last reading (`ok` within 15 minutes, `offline` when the last try failed, `unknown`
 *   before the first), its first readings as facts and when it last worked (`usedAt`: the newer of its last reading
 *   that worked and its connection's last call that worked; home-redesign.md HR-45).
 * - **Needs you**: a card waiting for the person's choice (“Heat pump: what may I change?”).
 * - **The reader**: every 5 minutes, each switched-on device's readings are read (reads only), so Home and widgets have
 *   a fresh value without the AI.
 * - **Its lines** (quiet-notices.md QN-01, QN-03; QN-S15): not answering is a problem (`device.answers`, the dot says
 *   offline, “Not answering” its reason), readings it couldn't read a heads-up (`device.readings`, newer when another
 *   one fails). Ignored, snoozed or not watched, it no longer colours the dot or shows in Watch; the reader ends the
 *   Ignores that end by themselves after each read, as the connections' health pass does.
 */
import { thingHref, thingId } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { onConnectionLifecycle } from '../connections/lifecycle';
import { catalogConnections, deviceSkills, principals } from '../db/schema/index';
import { chatPlaceHref } from '../domain/links';
import {
  readOnce,
  registerNeedsYouSource,
  registerSubjectResolver,
  registerThingsSource,
  registerWatchSource,
  type SourceCtx,
} from '../home/registry';
import type { NeedsYouItem, ThingFact, ThingSummary, WatchItem } from '../home/types';
import { iso } from '../lib/time';
import type { Services } from '../services';
import { devicePoints, recordPoints } from '../things/points';
import { applyQuiet } from '../things/quiet/apply';
import { withNotice } from '../things/quiet/connection';
import { notWatched, registerChecks } from '../things/quiet/defaults';
import { glanceLine, verdict } from '../things/quiet/glance';
import { shortHash } from '../things/quiet/items';
import {
  NO_QUIET,
  type QuietBook,
  quietBook,
  thingQuiet,
  thingStates,
  writePass,
} from '../things/quiet/store';
import type { KindCheck, KindNotice } from '../things/quiet/types';
import { activeWindow } from '../things/quiet/windows';
import { DeviceCallError, type ReadingResult, readDevice } from './driver';
import { deviceNoun } from './profile';
import { keepLastRead } from './run';
import { settleRemovedDevices } from './skills';
import {
  addressOf,
  DEVICE_CATALOG_ID,
  type DeviceSkillRow,
  skillById,
  skillOfConnection,
  skillsOn,
} from './store';

export const DEVICE_READ_EVERY_MS = 5 * 60_000;
/** A reading older than this is no longer “ok”. */
export const DEVICE_FRESH_MS = 15 * 60_000;
const FACTS_MAX = 4;

/** An icon name for the device from its words (the app maps names to its icons). */
export function deviceIcon(name: string): string {
  const n = name.toLowerCase();
  if (/heat ?pump|boiler|thermo|heating|furnace|hvac|air ?con/.test(n)) return 'thermometer';
  if (/solar|inverter|battery|meter|charger|wallbox|ev\b|power|energy/.test(n)) return 'zap';
  if (/water|pump|pool|irrigation/.test(n)) return 'droplet';
  if (/fan|ventilat|air/.test(n)) return 'fan';
  return 'cpu';
}

/** A reading as a fact: “21.0” and “°C” apart, as Home shows them. */
export function factOf(r: ReadingResult): ThingFact {
  if (r.unit && r.text.endsWith(` ${r.unit}`))
    return { label: r.label, value: r.text.slice(0, -(r.unit.length + 1)), unit: r.unit };
  if (r.unit === '%' && r.text.endsWith('%'))
    return { label: r.label, value: r.text.slice(0, -1), unit: '%' };
  return { label: r.label, value: r.text };
}

/** When a switched-on device last worked: the newer of its last reading that worked and its last call that worked. */
export function deviceUsedAt(lastReadAt: Date | null, lastWorkedAt: Date | null): Date | null {
  if (!lastReadAt || !lastWorkedAt) return lastReadAt ?? lastWorkedAt;
  return lastReadAt.getTime() >= lastWorkedAt.getTime() ? lastReadAt : lastWorkedAt;
}

/** What Whombat watches on a device (QN-15). */
export const DEVICE_CHECKS: readonly KindCheck[] = [
  { check: 'device.answers', name: 'Whether it answers', nature: 'problem', perItem: false, startsOn: true },
  {
    check: 'device.readings',
    name: 'Readings it can’t read',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
];
registerChecks(DEVICE_CHECKS);

/** A switched-on device's lines (QN-S15): not answering, readings it couldn't read. */
export function deviceLines(
  skill: Pick<DeviceSkillRow, 'name' | 'lastReadError' | 'lastRead' | 'tested'>,
): KindNotice[] {
  const out: KindNotice[] = [];
  if (skill.lastReadError)
    out.push({
      id: 'not-answering',
      tone: 'bad',
      icon: 'device',
      title: 'It didn’t answer the last time',
      detail: skill.lastReadError.slice(0, 200),
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: `Why isn’t ${skill.name} answering?`.slice(0, 300),
      },
      nature: 'problem',
      check: 'device.answers',
      ignore: { lifts: 'fixed', words: 'Until it answers again.' },
      badge: 'Not answering',
      offline: true,
    });
  const failed = (skill.lastRead ?? skill.tested).filter((r) => r.value === null);
  if (failed.length)
    out.push({
      id: 'unread',
      tone: 'info',
      icon: 'info',
      title: `${failed.length === 1 ? '1 reading' : `${failed.length} readings`} couldn’t be read`,
      detail: failed
        .map((r) => r.label)
        .join(' · ')
        .slice(0, 200),
      nature: 'fyi',
      check: 'device.readings',
      ignore: { lifts: 'newer', words: 'Until another reading fails.' },
      episode: shortHash(failed.map((r) => r.key)),
    });
  return out;
}

function thingOf(
  row: DeviceSkillRow,
  now: Date,
  lastWorkedAt: Date | null = null,
  book: QuietBook | null = null,
): ThingSummary {
  const inner = row.status === 'on' && row.connectionId ? row.connectionId : row.id;
  const base = {
    id: thingId('device', inner),
    kind: 'device' as const,
    catalogId: 'device',
    name: row.name,
    icon: deviceIcon(`${row.name} ${row.profile.model ?? ''}`),
    href: thingHref('device', inner),
  };
  if (row.status === 'proposed')
    return {
      ...base,
      status: 'learning',
      line: 'learning',
      facts: row.tested
        .filter((r) => r.value !== null)
        .slice(0, FACTS_MAX)
        .map(factOf),
    };
  const readings = (row.lastRead ?? row.tested).filter((r) => r.value !== null);
  const fresh = row.lastReadAt !== null && now.getTime() - row.lastReadAt.getTime() <= DEVICE_FRESH_MS;
  const failed = row.lastReadError !== null;
  // Not answering and ignored: no dot, but not “fine” either (QN-S15).
  const quiet = book?.of(base.id) ?? NO_QUIET;
  const v = verdict(
    deviceLines(row).map((l) => glanceLine(l)),
    quiet,
    now,
  );
  // Kept quiet until a time, as Home's connections and servers say it.
  const window = activeWindow(quiet.windows, now);
  const status = v.status !== 'ok' ? v.status : failed ? 'unknown' : fresh ? 'ok' : 'unknown';
  const usedAt = deviceUsedAt(row.lastReadAt, lastWorkedAt);
  const line = failed
    ? 'Not answering'
    : readings
        .slice(0, 2)
        .map((r) => r.text)
        .join(' · ') || undefined;
  return withNotice(
    {
      ...base,
      status,
      ...(line ? { line } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
      ...(usedAt ? { usedAt: usedAt.toISOString() } : {}),
      ...(window ? { quietUntil: window.endsAt.toISOString() } : {}),
      facts: readings.slice(0, FACTS_MAX).map((r) => ({
        ...factOf(r),
        ...(row.lastReadAt && !fresh ? { note: `read ${iso(row.lastReadAt).slice(11, 16)}` } : {}),
      })),
    },
    v.notice,
  );
}

async function canSwitchOn(ctx: SourceCtx): Promise<boolean> {
  const person =
    ctx.reads?.person ?? (await ctx.db.select().from(principals).where(eq(principals.id, ctx.personId)))[0];
  return person?.kind === 'person' && person.burrowId === ctx.burrowId;
}

/**
 * The burrow's device skills proposed or switched on, each with its connection's last call that worked: one read for
 * Your things, Needs you and Watch in one Home read.
 */
function skillsOf(ctx: SourceCtx) {
  return readOnce(ctx, 'devices.skills', () =>
    ctx.db
      .select({ skill: deviceSkills, lastWorkedAt: catalogConnections.lastWorkedAt })
      .from(deviceSkills)
      .leftJoin(catalogConnections, eq(catalogConnections.id, deviceSkills.connectionId))
      .where(and(eq(deviceSkills.burrowId, ctx.burrowId), inArray(deviceSkills.status, ['proposed', 'on']))),
  );
}

/** What is quiet for the burrow's things: the Home read's, else read now. */
const quietOf = (ctx: SourceCtx) => ctx.reads?.quiet() ?? quietBook(ctx.db, [ctx.burrowId]);

/** Your things: devices (ONE-04). */
export async function deviceThings(ctx: SourceCtx): Promise<ThingSummary[]> {
  const joined = await skillsOf(ctx);
  if (joined.length === 0) return [];
  const rows = joined.map((j) => j.skill);
  const worked = new Map(joined.map((j) => [j.skill.id, j.lastWorkedAt]));
  const book = await quietOf(ctx);
  const manager = rows.some((r) => r.status === 'proposed') ? await canSwitchOn(ctx) : false;
  // A device switched on with a newer proposal waiting shows once, as the device it is.
  const on = new Set(
    rows.filter((r) => r.status === 'on').map((r) => `${r.host}:${r.port}:${r.unitId ?? ''}`),
  );
  return rows
    .filter((r) => r.status !== 'on' || r.connectionId !== null)
    .filter(
      (r) =>
        r.status === 'on' ||
        ((manager || r.personId === ctx.personId) && !on.has(`${r.host}:${r.port}:${r.unitId ?? ''}`)),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => thingOf(r, ctx.now, worked.get(r.id) ?? null, book));
}

/** Needs you: a device skill waiting for the person's choice (ONE-18). */
export async function deviceNeedsYou(ctx: SourceCtx): Promise<NeedsYouItem[]> {
  const rows = (await skillsOf(ctx)).flatMap((j) => (j.skill.status === 'proposed' ? [j.skill] : []));
  if (rows.length === 0 || !(await canSwitchOn(ctx))) return [];
  // Choose opens the proposal's thread in the chat it was made in (chat-channel.md CHT-08).
  const hrefs = new Map(
    await Promise.all(
      rows.map(
        async (r) =>
          [
            r.id,
            r.conversationId
              ? await chatPlaceHref(ctx.db, r.conversationId, { messageId: r.messageId })
              : null,
          ] as const,
      ),
    ),
  );
  return rows.map((r) => ({
    id: `device_skill:${r.id}`,
    ref: { kind: 'device_skill', id: r.id },
    kind: 'device_skill' as const,
    severity: 'info' as const,
    title: `What may I change on ${deviceNoun(r.name)}?`,
    body: 'I can read it now. Pick what I’m allowed to change before I switch that on.',
    at: iso(r.createdAt),
    actions: [
      {
        id: 'open',
        label: 'Choose',
        style: 'primary' as const,
        kind: 'open' as const,
        ...(hrefs.get(r.id) ? { href: hrefs.get(r.id) as string } : {}),
      },
    ],
  }));
}

/**
 * Watch: a switched-on device that stopped answering (ONE-07); it leaves Watch once a reading
 * works again.
 */
export async function deviceWatch(ctx: SourceCtx): Promise<WatchItem[]> {
  const [joined, book] = await Promise.all([skillsOf(ctx), quietOf(ctx)]);
  return joined
    .map((j) => j.skill)
    .filter((r) => r.status === 'on' && r.connectionId && r.lastReadError)
    .filter(
      (r) =>
        verdict(
          deviceLines(r).map((l) => glanceLine(l)),
          book.of(thingId('device', r.connectionId as string)),
          ctx.now,
        ).status !== 'ok',
    )
    .map((r) => {
      const noun = deviceNoun(r.name);
      return {
        id: `device:${r.connectionId}`,
        ref: { kind: 'device', id: r.connectionId as string },
        // A device is a connection to Watch (the contracts' `device` source once the registry's types are 0.80's).
        source: 'connection' as const,
        // Not answering is as bad here as on its page and the desk (QN-S15).
        severity: 'bad' as const,
        nature: 'problem' as const,
        title: `${noun.charAt(0).toUpperCase()}${noun.slice(1)} isn’t answering`,
        body: r.lastReadError ?? 'It didn’t answer.',
        at: iso(r.updatedAt),
        state: 'open' as const,
        // Stop watching this (on-purpose.md): a device switched off on purpose.
        watch: {
          thing: thingId('device', r.connectionId as string),
          check: 'device.answers',
          name: r.name.slice(0, 220),
        },
      };
    });
}

/** Keeps a reading's numbers for the device's page chart (connection-pages.md CP-13, CP-15). */
async function keepPoints(
  services: Services,
  skill: DeviceSkillRow,
  readings: ReadingResult[] | null,
): Promise<void> {
  if (!skill.connectionId) return;
  const connectionId = skill.connectionId;
  const values = devicePoints(readings, skill.lastRead ?? skill.tested);
  const now = services.clock();
  await services.pipeline
    .transactAccount((tx) => recordPoints(tx, connectionId, now, values))
    .catch(() => undefined);
}

/**
 * After a read, what the device's lines come to (QN-11, QN-S15): the Ignores that end by themselves end, the states move
 * on. A read that didn't answer reads none of its readings: only `device.answers` counts.
 */
async function devicePass(
  services: Services,
  skill: DeviceSkillRow,
  readings: ReadingResult[] | null,
  error: string | null,
): Promise<void> {
  if (!skill.connectionId) return;
  const thing = thingId('device', skill.connectionId);
  const [quiet, states] = await Promise.all([
    thingQuiet(services.db, skill.burrowId, thing),
    thingStates(services.db, thing),
  ]);
  if (!quiet.quiets.length && !states.length && !error && !readings?.some((r) => r.value === null)) return;
  const lines = deviceLines({
    name: skill.name,
    lastReadError: error,
    lastRead: readings ?? skill.lastRead,
    tested: skill.tested,
  });
  const result = applyQuiet({
    lines,
    quiets: quiet.quiets,
    ...notWatched(quiet),
    states,
    now: services.clock(),
    pass: true,
    ...(readings ? {} : { skipped: (check: string) => check !== 'device.answers' }),
  });
  await services.pipeline.transactAccount((tx) => writePass(tx, skill.burrowId, thing, result));
}

/** Reads every switched-on device once (reads only); returns how many answered. */
export async function readDevicesNow(services: Services, burrowId?: string): Promise<number> {
  let answered = 0;
  for (const skill of await skillsOn(services.db, burrowId)) {
    try {
      const readings = await readDevice(services, skill.profile, addressOf(skill));
      await keepLastRead(services, skill.id, readings, null);
      await keepPoints(services, skill, readings);
      await devicePass(services, skill, readings, null).catch(() => undefined);
      answered++;
    } catch (err) {
      const message = err instanceof DeviceCallError ? err.message : 'The device didn’t answer as expected.';
      await keepLastRead(services, skill.id, null, message).catch(() => undefined);
      await keepPoints(services, skill, null);
      await devicePass(services, skill, null, message).catch(() => undefined);
    }
  }
  return answered;
}

const readers = new WeakMap<Services, () => void>();

/** Starts the 5-minute reader (once per server). */
export function startDeviceReader(services: Services): void {
  if (readers.has(services)) return;
  const stopReading = services.housekeeping.add('device readings', DEVICE_READ_EVERY_MS, async () => {
    if (services.maintenance.paused) return;
    await readDevicesNow(services);
  });
  // A device connection removed in Settings: its skill goes off (ONE-DD15).
  const stopListening = onConnectionLifecycle(services, async (event) => {
    if (event.type === 'removed') await settleRemovedDevices(services);
  });
  readers.set(services, () => {
    stopReading();
    stopListening();
  });
}

export function stopDeviceReader(services: Services): void {
  readers.get(services)?.();
  readers.delete(services);
}

/**
 * What a chat about a device is called, from the burrow's own records rather than the name a client sent: a device
 * that is on is its connection (named by its skill), one still being learned is its skill; null for anything else.
 */
export async function deviceSubject(ctx: SourceCtx, id: string): Promise<{ name: string } | null> {
  const [row] = await ctx.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
  if (row) {
    if (row.burrowId !== ctx.burrowId || row.catalogId !== DEVICE_CATALOG_ID) return null;
    const skill = await skillOfConnection(ctx.db, row.id);
    return { name: skill?.name ?? row.label };
  }
  const skill = await skillById(ctx.db, id);
  if (!skill || skill.burrowId !== ctx.burrowId) return null;
  return { name: skill.name };
}

/** Registered once at load: the Things and Needs you sources, and what a chat about a device is called. */
export function registerDeviceSources(): void {
  registerThingsSource('devices', deviceThings);
  registerNeedsYouSource('devices', deviceNeedsYou);
  registerWatchSource('devices', deviceWatch);
  registerSubjectResolver('device', deviceSubject);
}
