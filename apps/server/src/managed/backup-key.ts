/**
 * The person's passkey as the key to this Whombat's backups (docs/decisions/backup-passkey.md).
 *
 *   backup.passkeyKey.set     {credentialId, salt, key}  → {bringBack}   keep a passkey's backup key, lock at once
 *   backup.passkeyKey.remove  {credentialId}             → {bringBack}   (also when the passkey itself is removed)
 *   backup.paperCopy.confirm  {repositoryId, generation} → {bringBack}   the paper copy of these details was saved
 *   backup.findKits           {}                         → {kits, places} envelopes next to backups on this network
 *
 * A passkey touch on the person's device gives this Whombat a key: `kitKeyFromPrf` of the passkey's PRF output, bound to
 * this Whombat's PeerId. The box never sees the PRF output and holds only symmetric keys, so control, which keeps the
 * envelopes, can neither open nor forge one. Each key is kept sealed with key custody (`backup-key-store.ts`).
 *
 * **Locking again** (`relock`): the backup details (`GET /v1/recovery-material`) are sealed with every key when they
 * change — a new destination, password, manifest key or generation, and the head after every successful backup — and
 * right after a key is kept. The envelopes go to control through the manager (`kit.envelopes.put`, with the Whombat's
 * name) and next to the backups (the place's kit user, `backup-places/kit-copy.ts`: when the details change, else once a
 * day). A Whombat brought back names the one it came from (`adoptedFrom`) in its first push, without waiting for an
 * envelope of its own, so control switches the old one off at once. What didn't go is tried again by the job
 * (`startBackupKeys`), which reads the backup service's own status: a minute after it changes (a backup), else every
 * five minutes.
 *
 * Every op is the person's on an enrolled device (`requireEnrolled`); the assistant's settings map says `never`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { KIT_APPLIANCE_NAME_RE } from '@whombat/control-contracts/device';
import type { BackupServiceStatus } from '@whombat/control-contracts/local';
import { fromBase64url, KIT_KEY_BYTES, PLACE_KIT_RECORD_KIND, sealKitWithKey } from '@whombat/core/backup';
import type {
  BackupBringBack,
  BackupFoundKit,
  BackupPaperCopyConfirmInput,
  BackupPasskeyKeySetInput,
  BackupRecoveryMaterial,
  BackupStatus,
} from '@whombat/protocol/session';
import { and, eq, isNull, lte } from 'drizzle-orm';
import type { z } from 'zod';
import {
  addKeepRightStep,
  type KeepRightStep,
  keepPlaceRightSoon,
  keepRightPaused,
} from '../backup-places/keep-right';
import {
  findPlaceKits,
  findRepository,
  keepPlaceKit,
  kitFileBody,
  kitNetOf,
  restTarget,
  writeKitFiles,
} from '../backup-places/kit-copy';
import { changeBoxBackupNotes, without } from '../backup-places/notes';
import { recoveryMaterial } from '../backup-places/use';
import { outsideCommandScope } from '../commit/scope';
import { appliancePasskeys, applianceState, backupPasskeyKeys } from '../db/schema/index';
import { loadOwnName } from '../desk/store';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { appendApplianceEvent } from './audit';
import { whenDestinationSet } from './backup';
import {
  type BackupKeyStateRow,
  type BackupPasskeyKeyRow,
  loadBackupKeyState,
  loadBackupKeys,
  openBackupKey,
  removeBackupKeysOf,
  saveBackupKey,
  saveBackupKeyState,
  sealBackupKey,
  updateBackupKey,
  updateBackupKeyState,
} from './backup-key-store';
import { boxBackupOf, boxBackupStatus } from './box-backup';
import type { SessionOpContext } from './dispatcher';
import { dropUnsupported, ManagerCallError, type ManagerPort, managerUnreachable } from './ports';
import { requireEnrolled } from './trust';

type Material = z.output<typeof BackupRecoveryMaterial>;

/** How often the job looks at the backup service's report, and how often it tries again what didn't go. */
export const BACKUP_KEY_LOOK_MS = 60_000;
export const BACKUP_KEY_RETRY_MS = 5 * 60_000;
/** The copy next to the backups is written again at least this often, and after a failure not sooner than this. */
export const NAS_COPY_EVERY_MS = 24 * 60 * 60_000;
export const NAS_COPY_RETRY_MS = 60 * 60_000;
/** How long `backup.passkeyKey.set` waits for the first lock before it answers (it goes on after). */
const SET_WAITS_MS = 20_000;
/** One push stays well within a device request (64 KiB with its signature and envelope). */
const PUSH_MAX_CHARS = 40_000;

/** What the runtime hands over at its start: this Whombat's PeerId and its manager. */
export interface BackupKeyWorld {
  appliance: string;
  manager: Pick<ManagerPort, 'kitEnvelopes'> | null;
}

const worlds = new WeakMap<Services, BackupKeyWorld>();
const chains = new WeakMap<Services, Promise<unknown>>();
/** The name control was last told with this box's envelopes (in memory: every start tells it once more). */
const namesTold = new WeakMap<Services, string>();
/** A manager or control from before names refused one: none is sent again until the runtime restarts. */
const nameRefused = new WeakSet<Services>();
/** Names go to control and the backups at most this long (control's and the kit file's bound). */
const NAME_MAX = 80;

/**
 * The Whombat's name as control and the copy next to the backups take it: one line, at most 80 characters, nothing
 * invisible; null when it has none yet (or none that reads as a name).
 */
export async function ownNameOf(services: Services): Promise<string | null> {
  const name = await loadOwnName(services.db).catch(() => null);
  const line = Array.from(name?.replace(/\s+/g, ' ').trim() ?? '')
    .slice(0, NAME_MAX)
    .join('')
    .trim();
  return KIT_APPLIANCE_NAME_RE.test(line) ? line : null;
}

export function useBackupKeys(services: Services, world: BackupKeyWorld): void {
  worlds.set(services, world);
  // A new destination (a place, its new address, the new password after a “lost or stolen” restore) is new details: they
  // are locked again at once instead of when the manager next reports.
  whenDestinationSet(services, 'backup-passkey', () => relockSoon(services));
  if (!placeKitStepAdded) {
    addKeepRightStep(placeKitStep);
    placeKitStepAdded = true;
  }
}

/** Locks again without waiting, outside any request's command scope (what it writes is the job's own). */
export function relockSoon(services: Services): void {
  outsideCommandScope(() => {
    void relock(services).catch((err: unknown) =>
      services.log.warn({ err: String(err) }, 'backup passkey: locking again failed'),
    );
  });
}

let placeKitStepAdded = false;

/**
 * The keep-the-place-right job's step (inside the place lock, where every change to a place is made): the place in use
 * gets the kit user once writing the copy next to the backups found it missing. Done or not possible now, the note
 * goes; the next copy that finds no kit user leaves it again (at most hourly), and `keepPlaceKit` sets the app up again
 * at most once a day. A step that throws keeps it for the next run.
 */
const placeKitStep: KeepRightStep = {
  name: 'placeKit',
  due: (ctx) => !!ctx.notes.placeKit && ctx.status !== null,
  async run(ctx) {
    const world = worlds.get(ctx.services);
    const outcome = world
      ? await keepPlaceKit(ctx.services, ctx.port, world.appliance, { actor: ctx.actor })
      : 'none';
    await changeBoxBackupNotes(ctx.services, (n) => (n.placeKit ? without(n, 'placeKit') : null));
    if (outcome !== 'added' || !world) return outcome === 'later' ? 'waiting' : 'same';
    // Written on the job's next look, not an hour after the try that found no kit user.
    await updateBackupKeyState(ctx.services, world.appliance, { nasTriedAt: null });
    return 'changed';
  },
};

/** One lock at a time per box. */
function inTurn<T>(services: Services, fn: () => Promise<T>): Promise<T> {
  const before = chains.get(services) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(fn);
  chains.set(
    services,
    run.catch(() => undefined),
  );
  return run;
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The details as locked: everything but when they were read (a new head after every backup changes it). */
export function lockDigest(material: Material): string {
  const { createdAt: _when, ...rest } = material;
  return sha(JSON.stringify(rest));
}

/** What the copy next to the backups follows: the details without their head (a new backup alone waits a day). */
export function nasDigest(material: Material): string {
  const { createdAt: _when, head: _head, ...rest } = material;
  return sha(JSON.stringify(rest));
}

/**
 * The details' secrets and the repository they open: what a paper copy holds that must still be true. Not where the
 * repository is (bring back finds a place by its repository), nor the generation, the head or when they were read. The
 * copy somewhere else counts once there is one (offsite-copy.md): a paper copy without it can't bring the box back when
 * the main place is lost with it, so a new or changed copy asks for a new paper copy. Without one the digest is what it
 * was before, so no paper copy saved then turns old.
 */
export function secretsDigest(material: Material): string {
  const o = material.offsite;
  return sha(
    JSON.stringify([
      material.repositoryId,
      material.repositoryPassword,
      material.manifestKey,
      material.restUser ?? null,
      material.restPassword ?? null,
      material.s3AccessKeyId ?? null,
      material.s3SecretAccessKey ?? null,
      material.s3Region ?? null,
      material.sftpUser ?? null,
      material.sftpPrivateKey ?? null,
      material.sftpHostKey ?? null,
      ...(o
        ? [
            o.repository,
            o.repositoryId,
            o.s3AccessKeyId ?? null,
            o.s3SecretAccessKey ?? null,
            o.s3Region ?? null,
          ]
        : []),
    ]),
  );
}

/* Where bringing this Whombat back stands --------------------------------------------------------------------------- */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * `bringBack` (pure): `none` without backups a new Whombat could open (nothing set, or only this box's own disk); `ready`
 * when a passkey's key locked the current generation and control kept it; `paper_only` when a paper copy of the current
 * details was saved; else `needs_passkey`.
 */
export function bringBackFrom(input: {
  status: Pick<BackupServiceStatus, 'destination' | 'kitGeneration'> | null | undefined;
  keys: readonly (Pick<BackupPasskeyKeyRow, 'generation' | 'storedAt'> & { verifiedAt?: Date | null })[];
  state: {
    detailsDigest: string | null;
    paperDigest: string | null;
    paperAt: Date | null;
    nasAt: Date | null;
  } | null;
}): BackupBringBack {
  const { status, keys, state } = input;
  const backups = !!status?.destination.configured && status.destination.kind !== 'local';
  const current = keys.filter((k) => k.storedAt && k.generation === status?.kitGeneration);
  const lockedAt = current.reduce<Date | null>(
    (at, k) => (k.storedAt && (!at || k.storedAt > at) ? k.storedAt : at),
    null,
  );
  const paperCurrent = !!state?.paperDigest && state.paperDigest === state.detailsDigest;
  return {
    state: !backups ? 'none' : current.length > 0 ? 'ready' : paperCurrent ? 'paper_only' : 'needs_passkey',
    passkeys: keys.length,
    verifiedAt: iso(current.find((k) => k.verifiedAt)?.verifiedAt),
    setup: !keys.length
      ? 'none'
      : !current.length
        ? 'saving'
        : current.some((k) => k.verifiedAt)
          ? 'verified'
          : 'verify',
    lockedAt: iso(lockedAt),
    nasCopyAt: backups ? iso(state?.nasAt) : null,
    paperAt: paperCurrent ? iso(state?.paperAt) : null,
  };
}

/** Where bringing this Whombat back stands now (the backup service's status as last known). */
export async function bringBackOf(
  services: Services,
  status?: BackupServiceStatus | null,
): Promise<BackupBringBack | null> {
  const world = worlds.get(services);
  if (!world) return null;
  const [keys, state, now] = await Promise.all([
    loadBackupKeys(services.db, world.appliance),
    loadBackupKeyState(services.db, world.appliance),
    status === undefined ? boxBackupStatus(services) : Promise.resolve(status),
  ]);
  return bringBackFrom({ status: now, keys, state });
}

/** A backup summary with `bringBack` (`backup.status`, `appliance.status`); unchanged where there is none. */
export async function withBringBack(
  services: Services,
  summary: BackupStatus,
  status: BackupServiceStatus | null | undefined,
): Promise<BackupStatus> {
  // The backup service didn't say: unknown, never “nothing to bring back”.
  if (!status) return summary;
  const bringBack = await bringBackOf(services, status).catch(() => null);
  return bringBack ? { ...summary, bringBack } : summary;
}

/* Locking again ------------------------------------------------------------------------------------------------------ */

export type RelockOutcome = 'locked' | 'unchanged' | 'later' | 'none';

/**
 * Seals the current backup details with every key whose envelope is older, pushes what control doesn't have yet and
 * writes the copy next to the backups when it is due. `none`: no key and no paper copy to follow, or no backup service.
 */
export function relock(services: Services): Promise<RelockOutcome> {
  return inTurn(services, () => relockNow(services));
}

async function relockNow(services: Services): Promise<RelockOutcome> {
  const world = worlds.get(services);
  const box = boxBackupOf(services);
  if (!world || !box) return 'none';
  // Like every background effect: nothing goes out during a restore, in quarantine or while drained for an update.
  // The service's own status says a restore is running even when the manager's report doesn't carry it.
  if (keepRightPaused(services, null) || keepRightPaused(services, await boxBackupStatus(services)))
    return 'later';
  const [keys, state] = await Promise.all([
    loadBackupKeys(services.db, world.appliance),
    loadBackupKeyState(services.db, world.appliance),
  ]);
  // Brought back and control not told yet: told now, with or without an envelope of this Whombat's.
  const untold = !!state?.adoptedFrom && !state.adoptedReportedAt;
  const onlyTell = async (): Promise<RelockOutcome> =>
    untold && (await pushEnvelopes(services, world)) === 'later' ? 'later' : 'none';
  if (keys.length === 0 && !state?.paperDigest) return onlyTell();
  const material = await recoveryMaterial(box.port);
  if (!material) return 'later';
  const secrets = secretsDigest(material);
  if (state?.detailsDigest !== secrets)
    await updateBackupKeyState(services, world.appliance, { detailsDigest: secrets });
  if (keys.length === 0) return onlyTell();
  const digest = lockDigest(material);
  const text = JSON.stringify(material);
  const now = services.clock();
  let sealed = 0;
  for (const row of keys) {
    if (row.envelope && row.lockedDigest === digest) continue;
    const key = openBackupKey(services.custody, row);
    if (!key) {
      services.log.warn(
        { credential: row.credentialId.slice(-8) },
        'backup passkey: a key could not be opened',
      );
      continue;
    }
    const envelope = sealKitWithKey(text, key, world.appliance);
    key.fill(0);
    // Only onto the key it was sealed with: a key set again meanwhile is locked with on the next turn.
    await updateBackupKey(
      services,
      world.appliance,
      row.credentialId,
      { envelope, generation: material.generation, lockedDigest: digest, lockedAt: now, storedAt: null },
      row.keySealed,
    );
    sealed++;
  }
  const pushed = await pushEnvelopes(services, world);
  await writeNasCopy(services, world, material).catch((err: unknown) =>
    services.log.warn({ err: String(err) }, 'backup passkey: the copy next to the backups wasn’t written'),
  );
  if (pushed === 'later') return 'later';
  return sealed > 0 ? 'locked' : 'unchanged';
}

/** Splits envelopes into pushes that each fit a device request. */
export function pushBatches<T extends { envelope: string }>(envelopes: readonly T[]): T[][] {
  const out: T[][] = [];
  let batch: T[] = [];
  let size = 0;
  for (const e of envelopes) {
    const n = e.envelope.length + 600;
    if (batch.length > 0 && (size + n > PUSH_MAX_CHARS || batch.length >= 20)) {
      out.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(e);
    size += n;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

/**
 * Hands control the envelopes it doesn't have yet, with the Whombat's name, and, once, the Whombat this one was brought
 * back from (alone when this one has no envelope yet: control switches the old one off without waiting). A new name, or
 * the first push since the runtime started, sends every envelope again so control keeps the name with them.
 */
async function pushEnvelopes(services: Services, world: BackupKeyWorld): Promise<'done' | 'later'> {
  const keys = await loadBackupKeys(services.db, world.appliance);
  const state = await loadBackupKeyState(services.db, world.appliance);
  const adoptedFrom = state?.adoptedFrom && !state.adoptedReportedAt ? state.adoptedFrom : null;
  const name = nameRefused.has(services) ? null : await ownNameOf(services);
  const renamed = name !== null && namesTold.get(services) !== name;
  const locked = keys.filter((k) => k.envelope && k.generation !== null);
  const due = adoptedFrom || renamed ? locked : locked.filter((k) => !k.storedAt);
  if (due.length === 0 && !adoptedFrom) return 'done';
  const push = world.manager?.kitEnvelopes?.bind(world.manager);
  if (!push) return 'later';
  const batches = pushBatches(
    due.map((k) => ({
      credentialId: k.credentialId,
      salt: k.salt,
      envelope: k.envelope as string,
      generation: k.generation as number,
    })),
  );
  let named = name;
  const send = (envelopes: (typeof batches)[number]) =>
    push({
      envelopes,
      ...(adoptedFrom ? { adoptedFrom } : {}),
      ...(named ? { applianceName: named } : {}),
    });
  for (const batch of batches.length > 0 ? batches : [[]]) {
    let stored: typeof batch = [];
    try {
      const answer = await send(batch).catch(async (err: unknown) => {
        // A manager or control from before names refuses the member: sent again without it, and not until a restart.
        if (!named || !refusesName(err)) throw err;
        nameRefused.add(services);
        named = null;
        return send(batch);
      });
      // A skipped one is a passkey control neither holds nor was told of for this Whombat: it stays unstored and goes
      // again with the next round (a box passkey's declaration may land meanwhile). A control that doesn't say which
      // it skipped leaves the whole batch unstored.
      if (answer.skipped > 0)
        services.log.info(
          { sent: batch.length, stored: answer.stored, skipped: answer.skipped },
          'backup passkey: control kept fewer envelopes than were sent',
        );
      stored = storedOf(batch, answer);
    } catch (err) {
      // Away or older: tried again later, without a word each time.
      if (!managerUnreachable(err) && !dropUnsupported(err))
        services.log.warn({ err: String(err) }, 'backup passkey: the envelopes weren’t taken');
      return 'later';
    }
    const at = services.clock();
    for (const e of stored)
      await updateBackupKey(services, world.appliance, e.credentialId, { storedAt: at });
    if (adoptedFrom) await updateBackupKeyState(services, world.appliance, { adoptedReportedAt: at });
  }
  if (named) namesTold.set(services, named);
  return 'done';
}

/**
 * The envelopes of a batch control kept: all of them unless it skipped some; then those it didn't name as skipped, or
 * none when it didn't say which (a control before 4.3).
 */
export function storedOf<T extends { credentialId: string }>(
  batch: readonly T[],
  answer: { skipped: number; skippedCredentialIds?: readonly string[] | undefined },
): T[] {
  if (answer.skipped <= 0) return [...batch];
  const skipped = answer.skippedCredentialIds;
  if (!skipped) return [];
  return batch.filter((e) => !skipped.includes(e.credentialId));
}

/** A refusal of the push's body itself: the manager's own (400), or control's passed on (`control_refused`). */
function refusesName(err: unknown): boolean {
  return err instanceof ManagerCallError && (err.status === 400 || err.code === 'control_refused');
}

/** Writes the envelope files next to the backups when the details changed, else once a day. */
async function writeNasCopy(services: Services, world: BackupKeyWorld, material: Material): Promise<void> {
  const target = restTarget(material.repository);
  if (!target) return;
  const keys = (await loadBackupKeys(services.db, world.appliance)).filter(
    (k): k is typeof k & { envelope: string; generation: number } => !!k.envelope && k.generation !== null,
  );
  if (keys.length === 0) return;
  const state = await loadBackupKeyState(services.db, world.appliance);
  const digest = nasDigest(material);
  const where = `${target.host}:${target.port}`;
  const now = services.clock();
  const changed = state?.nasDigest !== digest || state.nasWhere !== where;
  const stale = !state?.nasAt || now.getTime() - state.nasAt.getTime() >= NAS_COPY_EVERY_MS;
  if (!changed && !stale) return;
  const failedLately =
    state?.nasTriedAt &&
    (!state.nasAt || state.nasTriedAt > state.nasAt) &&
    now.getTime() - state.nasTriedAt.getTime() < NAS_COPY_RETRY_MS;
  if (failedLately && state?.nasDigest === digest) return;
  const name = await ownNameOf(services);
  // The file's name is the SHA-256 of its bytes, so they come from the one place that writes them.
  const bodies = keys.map((k) =>
    kitFileBody({
      kind: PLACE_KIT_RECORD_KIND,
      appliance: world.appliance,
      applianceName: name,
      credentialId: k.credentialId,
      salt: k.salt,
      envelope: k.envelope,
      generation: k.generation,
      createdAt: now.toISOString(),
    }),
  );
  const written = await writeKitFiles(target.origin, bodies, kitNetOf(services).fetch);
  if (written === 'written') {
    await updateBackupKeyState(services, world.appliance, {
      nasAt: now,
      nasDigest: digest,
      nasWhere: where,
      nasTriedAt: now,
    });
    return;
  }
  await updateBackupKeyState(services, world.appliance, { nasTriedAt: now });
  // An app set up before the kit user: the keep-the-place-right job gives it one inside the place lock (never here,
  // where a move may hold that lock), and the copy is written on the next try.
  if (written === 'no_kit_user') {
    await changeBoxBackupNotes(services, (n) =>
      n.placeKit ? null : { ...n, placeKit: { since: now.toISOString() } },
    );
    keepPlaceRightSoon(services);
  }
}

/* Brought back ------------------------------------------------------------------------------------------------------ */

/** A device id as control and the backups name an appliance (`wb-3fkq-8mzt-2049`). */
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * This Whombat was brought back from `oldAppliance` (its device id, as the backup names it; the person finished the
 * restore): the next push names it, so control may forget that retired Whombat's envelopes once this one has its own. The passkeys in the restored database
 * (made up to the backup's time, `restoredAt`) were made for that Whombat: their user handle names it, so they can never
 * open this one, and listing them would keep a phone that has them from making one for this Whombat. They are removed
 * (signed `passkey.removed`); the person's devices keep them for the old Whombat's envelopes. Ignored when
 * `oldAppliance` isn't a device id, or is this box's own.
 */
export async function noteBroughtBack(
  services: Services,
  oldAppliance: string | null | undefined,
  restoredAt?: string | null,
): Promise<void> {
  const world = worlds.get(services);
  if (!world || !oldAppliance || !DEVICE_ID.test(oldAppliance)) return;
  const at = services.clock();
  const before = restoredAt ? new Date(restoredAt) : null;
  await services.pipeline.transactAccount(async (tx) => {
    const [own] = await tx.select({ device: applianceState.claimDeviceId }).from(applianceState);
    if (own?.device === oldAppliance) return;
    await saveBackupKeyState(tx, world.appliance, { adoptedFrom: oldAppliance, adoptedReportedAt: null }, at);
    if (!before || Number.isNaN(before.getTime())) return;
    const gone = await tx
      .update(appliancePasskeys)
      .set({ removedAt: at, removedByAccountId: null })
      .where(and(isNull(appliancePasskeys.removedAt), lte(appliancePasskeys.createdAt, before)))
      .returning();
    for (const row of gone)
      await appendApplianceEvent(tx, services.custody, {
        type: 'passkey.removed',
        actorAccountId: null,
        endpointId: null,
        payload: {
          credentialId: row.id,
          accountId: row.accountId,
          byAccountId: null,
          synced: row.backupEligible,
        },
        at,
      });
  });
}

/**
 * A kit's details with the repository where it is now: a printed kit or an envelope from before the place's address
 * changed finds the place on this network by its repository (`findRepository`). Unchanged when it answers where the kit
 * says, isn't a REST place, or wasn't found (the backup service then says it can't reach it).
 */
export async function placeMovedTo<M extends Material>(services: Services, material: M): Promise<M> {
  const moved = await findRepository(services, material).catch(() => null);
  if (!moved) return material;
  services.log.info('backup passkey: the kit’s backups were found at another address on this network');
  return { ...material, repository: moved };
}

/* The job ----------------------------------------------------------------------------------------------------------- */

/** What of the backup service's report locking again follows: the repository, the generation, the last backup. */
export function reportOf(status: BackupServiceStatus | null | undefined): string | null {
  return status
    ? `${status.destination.repositoryId ?? ''}|${status.kitGeneration}|${status.lastSuccess?.id ?? ''}`
    : null;
}

/** Whether the job locks again now (pure): never yet, the report changed, or the retry is due and something waits. */
export function relockDue(input: {
  seen: string | null | undefined;
  report: string | null;
  lastRun: number;
  now: number;
  retryMs: number;
  /** Something didn't go yet (`somethingWaits`), asked only when the retry is due. */
  waits?: boolean;
}): boolean {
  if (input.seen === undefined || input.report !== input.seen) return true;
  return input.now - input.lastRun >= input.retryMs && input.waits === true;
}

/**
 * Whether anything waits to be tried again (pure): an envelope control hasn't kept, the old Whombat not told yet, or the
 * copy next to the backups due (a day since it was written, or an hour since a failed try).
 */
export function somethingWaits(input: {
  keys: readonly Pick<BackupPasskeyKeyRow, 'envelope' | 'storedAt'>[];
  state: Pick<BackupKeyStateRow, 'adoptedFrom' | 'adoptedReportedAt' | 'nasAt' | 'nasTriedAt'> | null;
  now: number;
}): boolean {
  const { keys, state, now } = input;
  // The Whombat this one was brought back from waits to be named, envelope or not.
  if (state?.adoptedFrom && !state.adoptedReportedAt) return true;
  if (keys.length === 0) return false;
  if (keys.some((k) => k.envelope && !k.storedAt)) return true;
  const nasAt = state?.nasAt?.getTime() ?? null;
  const triedAt = state?.nasTriedAt?.getTime() ?? null;
  if (triedAt !== null && (nasAt === null || triedAt > nasAt)) return now - triedAt >= NAS_COPY_RETRY_MS;
  return nasAt === null || now - nasAt >= NAS_COPY_EVERY_MS;
}

/**
 * Starts locking again (a box with a backup service): at once, then within a minute of the backup service's status
 * changing (a backup, a move, a new generation), and every five minutes for what didn't go. Each look asks the service
 * itself (`boxBackupStatus` fresh, the newer of its answer and the manager's report), so a new backup locks again even
 * when the manager's report says nothing of backups. A service that doesn't answer is no change. Returns the way to
 * stop.
 */
export function startBackupKeys(
  services: Services,
  world: BackupKeyWorld,
  options: { lookMs?: number; retryMs?: number } = {},
): () => void {
  useBackupKeys(services, world);
  const retryMs = options.retryMs ?? BACKUP_KEY_RETRY_MS;
  let seen: string | null | undefined;
  let lastRun = 0;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void (async () => {
      // The service asked each time (a local call), so a backup is seen within a minute whatever the manager reports.
      const status = await boxBackupStatus(services, { fresh: true });
      const report = status ? reportOf(status) : seen === undefined ? null : seen;
      const now = Date.now();
      const changed = seen === undefined || report !== seen;
      const retry = !changed && now - lastRun >= retryMs;
      const waits = retry
        ? somethingWaits({
            keys: await loadBackupKeys(services.db, world.appliance),
            state: await loadBackupKeyState(services.db, world.appliance),
            now: services.clock().getTime(),
          })
        : false;
      if (!relockDue({ seen, report, lastRun, now, retryMs, waits })) {
        // Nothing waited: the next look at it is a retry period on.
        if (retry) lastRun = now;
        return;
      }
      seen = report;
      lastRun = now;
      await relock(services);
    })()
      .catch((err: unknown) =>
        services.log.warn({ err: String(err) }, 'backup passkey: locking again failed'),
      )
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, options.lookMs ?? BACKUP_KEY_LOOK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/* The ops ----------------------------------------------------------------------------------------------------------- */

function worldOf(c: SessionOpContext): BackupKeyWorld {
  const world = worlds.get(c.services);
  if (!world || !boxBackupOf(c.services))
    throw new ApiError('not_implemented', 'This Whombat has no backups a passkey could open.', {
      details: { code: 'backup_unavailable' },
    });
  return world;
}

async function answer(c: SessionOpContext) {
  const bringBack = await bringBackOf(c.services, await boxBackupStatus(c.services, { fresh: true }));
  return { bringBack: bringBack ?? bringBackFrom({ status: null, keys: [], state: null }) };
}

// biome-ignore lint/suspicious/noExplicitAny: each handler receives its op's parsed input.
type Handler = (c: SessionOpContext, input: any) => Promise<unknown>;

export const BACKUP_KEY_HANDLERS: Readonly<Record<string, Handler>> = {
  'backup.passkeyKey.set': async (c, input: z.output<typeof BackupPasskeyKeySetInput>) => {
    const { account, endpoint } = requireEnrolled(c.principal);
    const world = worldOf(c);
    const key = fromBase64url(input.key);
    if (!key || key.length !== KIT_KEY_BYTES)
      throw new ApiError('validation_failed', 'That isn’t a backup key.', {
        details: { code: 'backup_passkey_key_invalid' },
      });
    try {
      const at = c.services.clock();
      await c.services.pipeline.transactAccount(async (tx) => {
        // Serialize first saves and removal on the credential before checking its existing backup key.
        const [live] = await tx
          .select({ id: appliancePasskeys.id })
          .from(appliancePasskeys)
          .where(
            and(
              eq(appliancePasskeys.id, input.credentialId),
              eq(appliancePasskeys.accountId, account.id),
              isNull(appliancePasskeys.removedAt),
            ),
          )
          .for('update');
        if (!live)
          throw new ApiError('forbidden', 'That passkey isn’t one of yours on this Whombat.', {
            details: { code: 'backup_passkey_unknown' },
          });
        const [had] = await tx
          .select()
          .from(backupPasskeyKeys)
          .where(
            and(
              eq(backupPasskeyKeys.appliance, world.appliance),
              eq(backupPasskeyKeys.credentialId, input.credentialId),
            ),
          )
          .for('update');
        if (had) {
          const previous = openBackupKey(c.services.custody, had);
          try {
            if (had.salt === input.salt && previous && timingSafeEqual(previous, key)) return;
          } finally {
            previous?.fill(0);
          }
          throw new ApiError(
            'conflict',
            'This passkey returned a different backup key. Your saved backup details have been kept.',
            { details: { code: 'backup_passkey_key_changed' } },
          );
        }
        await saveBackupKey(
          tx,
          world.appliance,
          input.credentialId,
          {
            accountId: account.id,
            salt: input.salt,
            keySealed: sealBackupKey(c.services.custody, world.appliance, input.credentialId, key),
          },
          at,
        );
        await appendApplianceEvent(tx, c.services.custody, {
          type: 'backup.passkey_key_set',
          actorAccountId: account.id,
          endpointId: endpoint.id,
          payload: { credentialId: input.credentialId, accountId: account.id },
          at,
        });
      });
    } finally {
      key.fill(0);
    }
    // Locked at once (the answer waits a little for it); what doesn't go now the job tries again.
    const locking = relock(c.services).catch((err: unknown) => {
      c.services.log.warn({ err: String(err) }, 'backup passkey: locking after a new key failed');
    });
    await Promise.race([locking, new Promise((resolve) => setTimeout(resolve, SET_WAITS_MS).unref?.())]);
    return answer(c);
  },

  'backup.passkeyKey.verifyBegin': async (c, input: { credentialId: string }) => {
    const { account, endpoint } = requireEnrolled(c.principal);
    const world = worldOf(c);
    if (!c.session) throw new ApiError('bad_request', 'Verify your passkey over a session.');
    c.session.backupVerify = null;
    const row = (await loadBackupKeys(c.services.db, world.appliance)).find(
      (k) => k.credentialId === input.credentialId && k.accountId === account.id,
    );
    const status = await boxBackupStatus(c.services, { fresh: true });
    if (!row?.envelope || !row.storedAt || row.generation !== status?.kitGeneration)
      throw new ApiError('conflict', 'Your backup details are still being saved. Try again in a moment.', {
        details: { code: 'backup_passkey_saving' },
      });
    const key = openBackupKey(c.services.custody, row);
    if (!key) throw new ApiError('conflict', 'Touch your passkey again to save your backup key.');
    const proof = randomBytes(32).toString('base64url');
    try {
      const challenge = sealKitWithKey(proof, key, `verification:${world.appliance}`);
      c.session.backupVerify = {
        accountId: account.id,
        endpointId: endpoint.id,
        credentialId: row.credentialId,
        keySealed: row.keySealed,
        envelope: row.envelope,
        proof,
        expiresAt: new Date(c.services.clock().getTime() + 300000),
      };
      return { salt: row.salt, envelope: row.envelope, challenge };
    } finally {
      key.fill(0);
    }
  },
  'backup.passkeyKey.verifyConfirm': async (c, input: { proof: string }) => {
    const { account, endpoint } = requireEnrolled(c.principal);
    const world = worldOf(c);
    const begin = c.session?.backupVerify;
    if (c.session) c.session.backupVerify = null;
    const invalid = () =>
      new ApiError('forbidden', 'That passkey could not verify your backups. Try again.', {
        details: { code: 'backup_passkey_verification_failed' },
      });
    if (
      !begin ||
      begin.expiresAt <= c.services.clock() ||
      begin.accountId !== account.id ||
      begin.endpointId !== endpoint.id ||
      Buffer.byteLength(input.proof) !== Buffer.byteLength(begin.proof) ||
      !timingSafeEqual(Buffer.from(input.proof), Buffer.from(begin.proof))
    )
      throw invalid();
    const status = await boxBackupStatus(c.services, { fresh: true });
    await c.services.pipeline.transactAccount(async (tx) => {
      const [row] = await tx
        .select()
        .from(backupPasskeyKeys)
        .where(
          and(
            eq(backupPasskeyKeys.appliance, world.appliance),
            eq(backupPasskeyKeys.credentialId, begin.credentialId),
          ),
        )
        .for('update');
      const [live] = await tx
        .select({ id: appliancePasskeys.id })
        .from(appliancePasskeys)
        .where(
          and(
            eq(appliancePasskeys.id, begin.credentialId),
            eq(appliancePasskeys.accountId, account.id),
            isNull(appliancePasskeys.removedAt),
          ),
        );
      if (
        !row ||
        !live ||
        row.keySealed !== begin.keySealed ||
        row.envelope !== begin.envelope ||
        !row.storedAt ||
        row.generation !== status?.kitGeneration
      )
        throw invalid();
      await appendApplianceEvent(tx, c.services.custody, {
        type: 'backup.passkey_key_verified',
        actorAccountId: account.id,
        endpointId: endpoint.id,
        payload: { credentialId: begin.credentialId, accountId: account.id },
        at: c.services.clock(),
      });
      await tx
        .update(backupPasskeyKeys)
        .set({ verifiedAt: c.services.clock() })
        .where(
          and(
            eq(backupPasskeyKeys.appliance, world.appliance),
            eq(backupPasskeyKeys.credentialId, begin.credentialId),
          ),
        );
    });
    return answer(c);
  },

  'backup.passkeyKey.remove': async (c, input: { credentialId: string }) => {
    const { account, endpoint } = requireEnrolled(c.principal);
    worldOf(c);
    const at = c.services.clock();
    await c.services.pipeline.transactAccount(async (tx) => {
      const gone = await removeBackupKeysOf(tx, input.credentialId, account.id);
      if (gone > 0)
        await appendApplianceEvent(tx, c.services.custody, {
          type: 'backup.passkey_key_removed',
          actorAccountId: account.id,
          endpointId: endpoint.id,
          payload: { credentialId: input.credentialId, accountId: account.id },
          at,
        });
    });
    return answer(c);
  },

  'backup.paperCopy.confirm': async (c, input: z.output<typeof BackupPaperCopyConfirmInput>) => {
    requireEnrolled(c.principal);
    const world = worldOf(c);
    const box = boxBackupOf(c.services);
    const material = box ? await recoveryMaterial(box.port) : null;
    if (!material || material.repositoryId !== input.repositoryId || material.generation !== input.generation)
      throw new ApiError('conflict', 'Your backup details changed since. Print the paper copy again.', {
        details: { code: 'backup_paper_stale' },
      });
    const digest = secretsDigest(material);
    const at = c.services.clock();
    await c.services.pipeline.transactAccount(async (tx) =>
      saveBackupKeyState(
        tx,
        world.appliance,
        {
          paperRepositoryId: material.repositoryId,
          paperGeneration: material.generation,
          paperDigest: digest,
          paperAt: at,
          detailsDigest: digest,
        },
        at,
      ),
    );
    return answer(c);
  },

  'backup.findKits': async (c) => {
    requireEnrolled(c.principal);
    const world = worldOf(c);
    const found = await findPlaceKits(c.services);
    const kits: BackupFoundKit[] = found.kits
      .filter((k) => k.appliance !== world.appliance)
      .slice(0, 64)
      .map((k) => ({
        appliance: k.appliance,
        applianceName: k.applianceName,
        credentialId: k.credentialId,
        salt: k.salt,
        envelope: k.envelope,
        generation: k.generation,
        createdAt: k.createdAt,
        at: k.at,
      }));
    return { kits, places: Math.min(found.places, 1_000) };
  },
};
