/**
 * Keeping the place right (docs/decisions/backup-options.md, backup-places.md BPL-08): one background job, every five
 * minutes on a box with a backup service, that keeps what Whombat set up the way the person wants it — the schedule in
 * their time zone, the place in use at its NAS's address, its cleanup with their windows and limit, a new password after
 * a “lost or stolen” restore, the backups left on the box's own disk moved, the claim's “Let {assistant} set it up”
 * carried out, and the first backup told. Steps that have nothing to do cost nothing: the network is read only for a
 * place Whombat set up and that is in use.
 *
 * - **Never the defaults over the person's options.** When the service's policy doesn't parse, nothing is written from
 *   it; the cleanup is handed only windows that parsed.
 * - **Every failed change is tried again.** The place's record keeps what its cleanup was last handed (`cleanup_keep`),
 *   written only once the place took it; a step that throws is tried on the next run.
 * - **Paused during a restore** (quarantine, or the service restoring) and while the box is drained for an update.
 * - **One extension point**: `addKeepRightStep`, for a step another part of the server owns (each runs after these, in
 *   the order added, inside the same place lock).
 */
import type { BackupServiceStatus } from '@whombat/control-contracts/local';
import { BACKUP_PLACE_TEXT, bestBackupPlace, parseBackupPlaceId, placeOfDisplay } from '@whombat/core';
import { outsideCommandScope } from '../commit/scope';
import { tellPerson } from '../desk/tell';
import { thePerson } from '../domain/the-person';
import type { HostsActor } from '../hosts/client';
import { actorOf, hostsFor, WHOMBAT_ACTOR } from '../hosts/service';
import { type BackupPort, setBackupDestination } from '../managed/backup';
import { boxBackupOf, boxBackupStatus } from '../managed/box-backup';
import { hostTimeZone } from '../managed/host-metrics';
import { agentRuntimeOf, loadAgentRow } from '../read/principals';
import { providerReadiness } from '../runtime/readiness';
import type { Services } from '../services';
import { placeDriver } from './drivers/index';
import { tellFirstBackup } from './first-backup';
import { isPrivateIpv4 } from './hub';
import { type PlaceKeep, type PolicyRead, readPolicy, sameKeep } from './keep';
import { oneAtATime } from './lock';
import { type BoxBackupNotes, changeBoxBackupNotes, loadBoxBackupNotes, without } from './notes';
import { type PlacesNow, placesNow } from './places';
import { type BackupPlaceRow, loadPlaceRows, updatePlaceRow } from './store';
import { handCleanup, recoveryMaterial, restRepository, rotatePlacePassword, usePlaceNow } from './use';
import { keptHints } from './watch';

/** How often the job runs. */
export const KEEP_RIGHT_EVERY_MS = 5 * 60_000;
/** The first run after the runtime starts (the backup service and the hosts service answer by then). */
export const KEEP_RIGHT_FIRST_MS = 20_000;

/** What a step did. */
export type KeepRightOutcome = 'same' | 'changed' | 'waiting' | 'failed';

/** What one run knows; the place-related reads happen once, when a step needs them. */
export interface KeepRightContext {
  services: Services;
  port: BackupPort;
  /** Whombat, as the hosts service's audit names it. */
  actor: HostsActor;
  /** The backup service's status asked at the start of the run; null when it didn't answer. */
  status: BackupServiceStatus | null;
  /** Every place record (from the database). */
  rows: BackupPlaceRow[];
  /** The record of the place whose repository the service reports: the one in use; null when none is. */
  current: BackupPlaceRow | null;
  /** The runtime's notes as the run began (a step that changes them reads them again). */
  notes: BoxBackupNotes;
  /** The person's policy (read once). */
  policy(): Promise<PolicyRead>;
  /** The places on the network (read once, fresh). */
  places(): Promise<PlacesNow>;
}

export interface KeepRightStep {
  /** For the log and the run's report. */
  name: string;
  /** Whether there is anything to do, from what the context holds without reading the network. */
  due(ctx: KeepRightContext): boolean;
  run(ctx: KeepRightContext): Promise<KeepRightOutcome>;
}

/** What a run did: `paused` (a restore, a drain), `none` (no backup service), or each step's outcome. */
export type KeepRightReport =
  | { outcome: 'none' | 'paused' }
  | { outcome: 'ran'; steps: Record<string, KeepRightOutcome> };

const once = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let value: Promise<T> | null = null;
  return () => {
    value ??= load();
    return value;
  };
};

const WHOMBAT_OPERATOR: HostsActor = { ...WHOMBAT_ACTOR, role: 'operator' };

/* The steps ------------------------------------------------------------------------------------------------------ */

/** The schedule counts in the person's time zone: written only into a policy that parsed whole. */
const timeZoneStep: KeepRightStep = {
  name: 'timeZone',
  due: (ctx) => ctx.status !== null,
  async run(ctx) {
    const { policy } = await ctx.policy();
    if (!policy) return 'same';
    const zone = await hostTimeZone(ctx.services.db, '');
    if (!zone || policy.timeZone === zone) return 'same';
    const put = await ctx.port.call('PUT', '/v1/policy', { ...policy, timeZone: zone });
    return put.status === 200 ? 'changed' : 'failed';
  },
};

/** Whether Whombat can give a place a new password itself: one it set up (not by hand, not only found). */
export function canRotate(row: BackupPlaceRow | null | undefined): row is BackupPlaceRow {
  const ref = row ? parseBackupPlaceId(row.id) : null;
  return !!row && !row.byHand && !!ref && ref.type !== 'found';
}

/** The words a place goes by: its name, else the address the backup service shows (host and port of a URL). */
export function placeWords(
  row: BackupPlaceRow | null | undefined,
  display: string | null | undefined,
): string | null {
  return row?.name || placeOfDisplay(display);
}

/**
 * Who can give the backups a new password after a lost or stolen Whombat (the restore state's `newPassword`): Whombat
 * on a place it set up, else the person; null without backups elsewhere (nothing set, or only this box's own disk).
 */
export async function newPasswordOf(
  services: Services,
): Promise<{ by: 'whombat' | 'you'; place: string | null } | null> {
  const status = await boxBackupStatus(services);
  if (!status?.destination.configured || status.destination.kind === 'local') return null;
  const repositoryId = status.destination.repositoryId ?? null;
  const rows = await loadPlaceRows(services.db).catch(() => []);
  const row = repositoryId ? (rows.find((r) => r.repositoryId === repositoryId) ?? null) : null;
  return {
    by: canRotate(row) ? 'whombat' : 'you',
    place: placeWords(row, status.destination.display)?.slice(0, 200) ?? null,
  };
}

/**
 * A “lost or stolen” restore: the place in use gets a new password (the old box can't add backups any more). On a place
 * Whombat can't change (a disk, a bucket, a REST server typed in, one set up by hand) the person is asked to, in the
 * Inbox, until a destination is set again.
 */
const rotateStep: KeepRightStep = {
  name: 'rotate',
  due: (ctx) => !!ctx.notes.rotate && ctx.status !== null,
  async run(ctx) {
    const note = ctx.notes.rotate;
    if (!note) return 'same';
    const row = ctx.current;
    const byHand = !!row?.byHand;
    const place = placeWords(row, ctx.status?.destination.display)?.slice(0, 200) ?? null;
    if (!canRotate(row)) {
      const since = new Date(ctx.services.clock()).toISOString();
      await changeBoxBackupNotes(ctx.services, (n) => ({
        ...without(n, 'rotate'),
        changePassword: { since, place, byHand },
      }));
      ctx.services.log.info({ place }, 'backup places: the person changes the backups’ password themselves');
      return 'waiting';
    }
    try {
      await rotatePlacePassword(ctx.services, ctx.port, row, ctx.actor);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      await changeBoxBackupNotes(ctx.services, (n) =>
        n.rotate
          ? { ...n, rotate: { ...n.rotate, tries: n.rotate.tries + 1, lastError: why.slice(0, 300) } }
          : null,
      );
      throw err;
    }
    await changeBoxBackupNotes(ctx.services, (n) => without(n, 'rotate'));
    // Its address may have changed with it: the rest of the run reads the record again.
    ctx.current = (await loadPlaceRows(ctx.services.db)).find((r) => r.id === row.id) ?? null;
    return 'changed';
  },
};

/**
 * The place follows its NAS's address (BPL-08): plain http needs a numeric address (BK-29), so when the place in use
 * answers at another one now (a DHCP change), the box's destination is set again to the same repository at the new
 * address — the same REST user, the repository password adopted from the recovery material, never a new repository.
 */
const followStep: KeepRightStep = {
  name: 'follow',
  due: (ctx) => {
    const kind = ctx.status?.destination.kind;
    return !!ctx.current?.address && !!ctx.current.port && (kind === undefined || kind === 'rest');
  },
  async run(ctx) {
    const row = ctx.current;
    if (!row?.address || !row.port) return 'same';
    const ref = parseBackupPlaceId(row.id);
    if (!ref || ref.type === 'found') return 'same';
    const driver = placeDriver({
      services: ctx.services,
      target: { id: row.id, ref, kind: row.kind, name: row.name },
      actor: ctx.actor,
    });
    const addresses = driver.addresses
      ? await driver.addresses().catch(() => [])
      : await ctx
          .places()
          .then((now) => now.places.find((p) => p.id === row.id)?.address)
          .then((a) => (a ? [a] : []));
    const usable = addresses.filter(isPrivateIpv4);
    if (!usable.length || usable.includes(row.address)) return 'same';
    const next = usable[0] as string;
    const material = await recoveryMaterial(ctx.port);
    // Only the repository Whombat set there, and only with what reaches it.
    if (!material || material.repository !== restRepository(row.address, row.port, row.client)) return 'same';
    if (!material.restUser || !material.restPassword) return 'same';
    await setBackupDestination(
      ctx.services,
      ctx.port,
      {
        repository: restRepository(next, row.port, row.client),
        restUser: material.restUser,
        restPassword: material.restPassword,
        adoptPassword: material.repositoryPassword,
      },
      { accountId: null, endpointId: null },
    );
    await updatePlaceRow(ctx.services, row.id, { address: next });
    ctx.current = { ...row, address: next };
    await boxBackupStatus(ctx.services, { fresh: true });
    ctx.services.log.info(
      { place: row.id, from: row.address, to: next },
      'backup places: followed the place to its new address',
    );
    return 'changed';
  },
};

/**
 * Whether the place's cleanup must be handed the keep again (pure): it never was since the record has one, it was
 * handed other windows or another limit, the place says it has no cleanup, or a helper that got the longest window now
 * takes windows (it was updated).
 */
export function cleanupDue(input: {
  want: PlaceKeep;
  handed: BackupPlaceRow['cleanupKeep'];
  report: { set: boolean; keep: PlaceKeep | null } | null;
  now: Date;
}): { due: boolean; windows?: boolean } {
  const { want, handed, report } = input;
  const windows = report ? report.keep !== null : undefined;
  const as = windows !== undefined ? { windows } : {};
  if (!handed || !sameKeep(handed.keep, want)) return { due: true, ...as };
  if (report && !report.set) return { due: true, windows: false };
  // A helper that got the longest window reports what it keeps once it was updated: then it takes the windows.
  if (report && windows && !handed.windows) return { due: true, windows: true };
  // What the helper reports it keeps differs from what it was handed (someone changed it there).
  if (report?.keep && handed.windows && !sameKeep(report.keep, want)) return { due: true, windows: true };
  // An older helper keeps the cleanup it made; handed again once a day, an updated one makes it anew and says so.
  if (!handed.windows && (!handed.at || input.now.getTime() - Date.parse(handed.at) > DAY_MS))
    return { due: true, ...as };
  return { due: false };
}

const DAY_MS = 24 * 60 * 60_000;

/** The place's cleanup keeps the person's windows and limit (BKO-04): handed again whenever it doesn't. */
const cleanupStep: KeepRightStep = {
  name: 'cleanup',
  due: (ctx) => !!ctx.current && !ctx.current.byHand && ctx.status !== null,
  async run(ctx) {
    const row = ctx.current;
    if (!row) return 'same';
    const ref = parseBackupPlaceId(row.id);
    if (!ref || ref.type === 'found') return 'same';
    const { keep: want } = await ctx.policy();
    // Windows that didn't parse are never replaced by the recommended ones.
    if (!want) return 'same';
    const driver = placeDriver({
      services: ctx.services,
      target: { id: row.id, ref, kind: row.kind, name: row.name },
      actor: ctx.actor,
    });
    const report = driver.cleanupReport
      ? await driver.cleanupReport(row.client).catch(() => null)
      : await driver
          .kept(row.client)
          .then((k) => (k ? { set: k.cleanup.on, keep: null } : null))
          .catch(() => null);
    // A NAS's kept says only whether a cleanup is set; it takes windows always.
    const merged = driver.cleanupReport ? report : report ? { set: report.set, keep: want } : null;
    const decision = cleanupDue({
      want,
      handed: row.cleanupKeep,
      report: merged,
      now: ctx.services.clock(),
    });
    if (!decision.due) return 'same';
    await handCleanup(
      ctx.services,
      ctx.port,
      driver,
      { id: row.id, name: row.name, client: row.client, cleanupAt: row.cleanupAt },
      { keep: want, ...(decision.windows !== undefined ? { windows: decision.windows } : {}) },
    );
    return 'changed';
  },
};

/** Tries before the backups left on the box's own disk stay where they are (the Backups page's row then). */
const MOVE_LOCAL_TRIES = 12;

/** The backups left on the box's own disk move to the place the person said yes to (part of that yes). */
const moveLocalStep: KeepRightStep = {
  name: 'moveLocal',
  due: (ctx) => !!ctx.notes.moveLocal && ctx.status !== null && !ctx.status.running,
  async run(ctx) {
    const res = await ctx.port.call('POST', '/v1/local/copy', {});
    // A backup started meanwhile: next time.
    if (res.status === 409) return 'waiting';
    const ok = res.status === 200 || res.status === 404 || res.status === 405;
    await changeBoxBackupNotes(ctx.services, (n) => {
      if (!n.moveLocal) return null;
      if (ok || n.moveLocal.tries + 1 >= MOVE_LOCAL_TRIES) return without(n, 'moveLocal');
      return { ...n, moveLocal: { ...n.moveLocal, tries: n.moveLocal.tries + 1 } };
    });
    return ok ? 'changed' : 'failed';
  },
};

/** How long the claim's yes waits for a place the assistant can set up on its own (the first scan, a connection). */
export const CONSENT_WAIT_MS = 30 * 60_000;
/** How long it waits for the AI to be connected before the Inbox asks instead. */
export const CONSENT_AI_WAIT_MS = 24 * 60 * 60_000;

/** Whether the person's assistant can work now (the AI connected): only then does it set the backups up. */
async function assistantReady(services: Services): Promise<{ burrowId: string; ok: boolean } | null> {
  const burrowId = await hostsFor(services)
    .homeBurrowId()
    .catch(() => null);
  if (!burrowId) return null;
  const agent = await loadAgentRow(services.db, burrowId);
  const person = await thePerson(services.db, burrowId);
  if (!agent || !person) return null;
  const ready = await providerReadiness(services, agent, agentRuntimeOf(agent.runtime).provider, person);
  return { burrowId, ok: ready.ok };
}

/**
 * The claim's “Let {assistant} set it up” (CT-1694): once the AI is connected, the assistant sets up the place the
 * person saw (or the best one that is ready) and says so in one sentence in their Chat. When none is ready within half
 * an hour, the AI isn't connected within a day, or setting it up fails, the yes is `failed` and the Inbox asks as before.
 */
const consentStep: KeepRightStep = {
  name: 'consent',
  due: (ctx) => ctx.notes.consent?.state === 'waiting' && ctx.status !== null,
  async run(ctx) {
    const consent = ctx.notes.consent;
    if (consent?.state !== 'waiting') return 'same';
    const mark = (state: 'done' | 'failed') =>
      changeBoxBackupNotes(ctx.services, (n) =>
        n.consent ? { ...n, consent: { ...n.consent, state } } : null,
      );
    const d = ctx.status?.destination;
    // Something keeps the backups already (the person set it meanwhile): nothing to do.
    if (d?.configured && d.kind !== 'local') {
      await mark('done');
      return 'same';
    }
    const age = ctx.services.clock().getTime() - Date.parse(consent.at);
    const ready = await assistantReady(ctx.services);
    if (!ready?.ok) {
      // No AI for a day: the Inbox asks instead (its Settings link works without the assistant).
      if (age < CONSENT_AI_WAIT_MS) return 'waiting';
      await mark('failed');
      return 'failed';
    }
    const now = await ctx.places();
    const asked = now.places.find((p) => p.id === consent.placeId && p.state === 'ready');
    const place = asked ?? bestBackupPlace(now.places.filter((p) => p.state === 'ready'));
    if (!place) {
      if (age < CONSENT_WAIT_MS) return 'waiting';
      await mark('failed');
      return 'failed';
    }
    const agent = await loadAgentRow(ctx.services.db, ready.burrowId);
    const person = await thePerson(ctx.services.db, ready.burrowId);
    if (!agent || !person) return 'waiting';
    try {
      const out = await usePlaceNow(
        ctx.services,
        ctx.port,
        { placeId: place.id },
        {
          accountId: consent.accountId,
          endpointId: null,
          agentId: agent.id,
          actor: actorOf({ id: agent.id, name: `${agent.name} for ${person.name}` }, 'operator'),
        },
      );
      await mark('done');
      await tellPerson(
        ctx.services,
        ready.burrowId,
        person.id,
        BACKUP_PLACE_TEXT.setSay(out.destination, out.locationName, out.firstBackup),
      ).catch(() => false);
      return 'changed';
    } catch (err) {
      ctx.services.log.warn(
        { place: place.id, err: err instanceof Error ? err.message : String(err) },
        'backup places: the assistant couldn’t set up the place the person said yes to',
      );
      await mark('failed');
      return 'failed';
    }
  },
};

/** The thread the person said yes in hears how the first backup went. */
const firstBackupStep: KeepRightStep = {
  name: 'firstBackup',
  due: (ctx) => !!ctx.notes.firstBackup,
  async run(ctx) {
    const told = await tellFirstBackup(ctx.services, ctx.status);
    return told === 'told' ? 'changed' : told === 'waiting' ? 'waiting' : 'same';
  },
};

/**
 * The hints a server that keeps the backups shows (cleanup not running, little room, BPL-11), worked out from the
 * places read: only while a server keeps them, so a box with none reads nothing.
 */
const hintsStep: KeepRightStep = {
  name: 'hints',
  due: (ctx) => ctx.rows.some((r) => r.id.startsWith('server:')) && hostsFor(ctx.services).present,
  async run(ctx) {
    await ctx.places();
    return 'same';
  },
};

const STEPS: readonly KeepRightStep[] = [
  timeZoneStep,
  rotateStep,
  followStep,
  cleanupStep,
  moveLocalStep,
  consentStep,
  firstBackupStep,
  hintsStep,
];

const extra: KeepRightStep[] = [];

/**
 * Adds a step to every run (after Whombat's own, in the order added), for a part of the server that keeps something
 * of its own on the place in use. Returns the way to take it away.
 */
export function addKeepRightStep(step: KeepRightStep): () => void {
  extra.push(step);
  return () => {
    const i = extra.indexOf(step);
    if (i >= 0) extra.splice(i, 1);
  };
}

/** Whether the job waits: a restore (quarantine, or the service restoring) or a drain for an update. */
export function keepRightPaused(services: Services, status: BackupServiceStatus | null | undefined): boolean {
  return services.maintenance.paused || status?.running?.op === 'restore';
}

/** One run of every step that has something to do, inside the place lock. */
export async function keepPlaceRight(services: Services): Promise<KeepRightReport> {
  const box = boxBackupOf(services);
  if (!box) return { outcome: 'none' };
  if (keepRightPaused(services, null)) return { outcome: 'paused' };
  return oneAtATime(services, async () => {
    const status = (await boxBackupStatus(services, { fresh: true })) ?? null;
    if (keepRightPaused(services, status)) return { outcome: 'paused' };
    const [rows, notes] = await Promise.all([loadPlaceRows(services.db), loadBoxBackupNotes(services.db)]);
    const repositoryId = status?.destination.configured ? (status.destination.repositoryId ?? null) : null;
    const ctx: KeepRightContext = {
      services,
      port: box.port,
      actor: WHOMBAT_OPERATOR,
      status,
      rows,
      current: repositoryId ? (rows.find((r) => r.repositoryId === repositoryId) ?? null) : null,
      notes,
      policy: once(() => readPolicy(box.port)),
      places: once(() => placesNow(services, { fresh: true })),
    };
    const steps: Record<string, KeepRightOutcome> = {};
    for (const step of [...STEPS, ...extra]) {
      if (!step.due(ctx)) continue;
      try {
        steps[step.name] = await step.run(ctx);
      } catch (err) {
        steps[step.name] = 'failed';
        services.log.warn(
          { step: step.name, err: err instanceof Error ? err.message : String(err) },
          'backup places: keeping the place right didn’t work this time',
        );
      }
    }
    return { outcome: 'ran', steps };
  });
}

const kicks = new WeakMap<Services, () => void>();

/**
 * Runs the job soon (after a change the person made: their options, their yes), without waiting for it, and outside
 * the request's command scope: what the job does is its own, never part of that request's receipt.
 */
export function keepPlaceRightSoon(services: Services): void {
  outsideCommandScope(() => {
    const kick = kicks.get(services);
    if (kick) kick();
    else
      void keepPlaceRight(services).catch((err: unknown) =>
        services.log.warn({ err: String(err) }, 'backup places: keeping the place right failed'),
      );
  });
}

/**
 * Starts the job on a box with a backup service: the places' hints for the hosts service, a first run shortly after
 * the start and then every five minutes. Returns the way to stop.
 */
export function startKeepPlaceRight(
  services: Services,
  options: { everyMs?: number; firstMs?: number } = {},
): () => void {
  const stopHints = hostsFor(services).addHintSource((serverId) => keptHints(services, serverId));
  let running = false;
  let again = false;
  const tick = () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void keepPlaceRight(services)
      .catch((err: unknown) =>
        services.log.warn({ err: String(err) }, 'backup places: keeping the place right failed'),
      )
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          tick();
        }
      });
  };
  kicks.set(services, tick);
  const first = setTimeout(tick, options.firstMs ?? KEEP_RIGHT_FIRST_MS);
  first.unref?.();
  const timer = setInterval(tick, options.everyMs ?? KEEP_RIGHT_EVERY_MS);
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    kicks.delete(services);
    stopHints();
  };
}
