/**
 * Backup options, the list of backups and bringing a Whombat back in fixture mode and the fake managed world (Whombat
 * backup-options.md; app backup-options.md): the backup service's status, its list (four a day for two days, one a day,
 * one a week back to the first backup, one before an update, one checked on Sunday), the policy with its Save, a check,
 * the 14 older backups left on the box with Move and Remove, and a restore that walks its stages by the clock — the
 * runtime away while the backup is put back (every `backup.restoreState` refused then, as a box whose runtime is
 * stopped answers nothing), three answers, then back. Like the mocks: BlackBox's share, 6.2 GB used, 1.9 TB free.
 */

import { fromBase64url, KIT_PRF_SALT_V2_B64, sealKitWithKey, toBase64url } from '@whombat/core/backup';
import {
  BACKUP_POLICY_DEFAULT,
  type BackupBringBack,
  type BackupBringBackState,
  type BackupCheckpoint,
  type BackupFoundKit,
  type BackupOffsite,
  type BackupPolicy,
  kitMaterialOf,
} from '@whombat/protocol/session';

type Answer = { status: number; body: unknown };

export interface FakeBackupOptionsOptions {
  now?: () => number;
  /** The box's id (its backups' `applianceId`). */
  appliance?: string;
  appliancePeerId?: string;
  /** The ops answer `unknown_op`: a box from before. */
  available?: boolean;
  /** Seconds a restore's stages take (default: a few seconds each). */
  restoreStageMs?: number;
  /** The status this box has: none (unprotected), or backed up. */
  protectedAtStart?: boolean;
  /** Where bringing it back stands at the start (`ready`: a passkey holds the key; the fake world starts without). */
  bringBackAtStart?: Exclude<BackupBringBackState, 'none'>;
  /** What `backup.findKits` finds next to backups on this network, after a moment (none by default). */
  nearKits?: BackupFoundKit[];
  /** A restore stops part-way (the box restarted) and is put back: the failure screen and Try again. */
  restoreStops?: boolean;
}

export interface FakeBackupOptions {
  call(op: string, input: unknown): Promise<Answer> | null;
  /** The restore's phase now (the world reads it to say the runtime is away). */
  restorePhase(): 'none' | 'restoring' | 'checking' | 'failed' | 'released';
  /**
   * The fake world's backup state of the box and where its backups go (a place set, a kit adopted, a destination
   * typed in, backups failing), so the backup service's status says what the rest of the world says.
   */
  follow(state: FakeBackupState, destination?: string | null): void;
  /** Tests and review shots: a backup being made, one that left something out, a restore that stops, copies found. */
  set(patch: FakeBackupPatch): void;
  /** Where bringing it back stands, as the summary says it (the world's `appliance.status` carries it too). */
  bringBack(): BackupBringBack;
}

export type FakeBackupState = 'unprotected' | 'pending' | 'protected' | 'stale' | 'failing';

/** What tests and review shots change on the fake backup service. */
export interface FakeBackupPatch {
  running?: boolean;
  incomplete?: string | null;
  bringBack?: BackupBringBackState;
  restoreStops?: boolean;
  nearKits?: BackupFoundKit[];
  /** The backup service doesn't answer: the overview says so with its notice, its own ops are refused. */
  serviceDown?: boolean;
  /** The places that kept backups before the one in use (the overview's `earlierPlaces`). */
  earlierPlaces?: { placeId: string; name: string }[];
  /** The copy somewhere else: none (offered), copying fine, or failing three times over (null: none). */
  offsite?: 'ok' | 'failing' | null;
}

/** A repository as the backup service shows it: the host (`rest:https://backup.example.com/x/` → backup.example.com). */
export function repositoryDisplay(repository: string): string {
  const url = repository.replace(/^[a-z0-9]+:(?=[a-z]+:\/\/)/i, '');
  try {
    return new URL(url).host || repository;
  } catch {
    return repository.replace(/^[a-z0-9]+:/i, '').split(/[/:]/)[0] || repository;
  }
}

const OPS = new Set([
  'backup.overview',
  'backup.runNow',
  'backup.passkeyKey.set',
  'backup.passkeyKey.remove',
  'backup.passkeyKey.verifyBegin',
  'backup.passkeyKey.verifyConfirm',
  'backup.paperCopy.confirm',
  'backup.findKits',
  'backup.letAssistantSetUp',
  'backup.status',
  'backup.checkpoints',
  'backup.policy',
  'backup.setPolicy',
  'backup.check',
  'backup.moveLocal',
  'backup.removeLocal',
  'backup.adopt',
  'backup.restore',
  'backup.restoreState',
  'backup.finishRestore',
  'backup.offsite',
  'backup.setOffsite',
  'backup.removeOffsite',
  'backup.copyOffsite',
]);

const MB = 1_000_000;
const GB = 1_000_000_000;

/** What the runtime says while the backup service doesn't answer (as the server's own words go). */
const SERVICE_DOWN =
  'Your Whombat’s backup service isn’t answering right now. It usually comes back by itself; try again in a minute.';

const err = (status: number, code: string, message: string, details?: unknown): Answer => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});
const ok = (body: unknown): Answer => ({ status: 200, body });

/** A backup at a local hour `daysAgo` days back. */
function at(now: number, daysAgo: number, hour: number, minute = 0): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** What every backup covers (`BackupScope`), as a box without servers lists it. */
export const FIXTURE_COVERED = [
  'database',
  'memory',
  'attachments',
  'packs',
  'home',
  'workspaces',
  'configuration',
  'provider-sessions',
  'recovery-references',
];

/** The list as the backup service answers it: newest first, the ones in the future left out. */
export function backupListFixture(now: number, appliance: string, own = true): BackupCheckpoint[] {
  const out: { when: Date; reason: BackupCheckpoint['reason']; added: number; releaseId?: string }[] = [];
  const sizes = [41, 12, 88, 9, 23, 17, 64, 31, 40, 236, 52, 19, 77, 28, 45, 61, 36, 22, 90, 58];
  let k = 0;
  const size = () => sizes[k++ % sizes.length] as number;
  // Every 6 hours for two days.
  for (const day of [0, 1])
    for (const hour of [21, 15, 9, 3])
      out.push({ when: at(now, day, hour), reason: 'scheduled', added: size() });
  out.push({ when: at(now, 1, 18, 45), reason: 'pre-migration', added: 41, releaseId: '0.198' });
  out.push({ when: at(now, 1, 11, 20), reason: 'manual', added: 6 });
  // One a day for two weeks.
  for (let day = 2; day <= 14; day++) out.push({ when: at(now, day, 3), reason: 'scheduled', added: size() });
  // The first backup, three weeks ago.
  out.push({ when: at(now, 21, 17, 52), reason: 'manual', added: 3_600 });
  const live = out.filter((b) => b.when.getTime() <= now).sort((a, b) => b.when.getTime() - a.when.getTime());
  // A check on the last Sunday that has a backup.
  const sunday = live.find((b) => b.when.getDay() === 0 && b.when.getTime() < now - 86_400_000);
  // One a few days back left an attachment out (it wasn't on the box any more).
  const gap = live.find((b) => b.when.getTime() < now - 3 * 86_400_000 && b !== sunday);
  return live.map((b, i) => ({
    id: `cp_${appliance.slice(0, 12).replace(/[^A-Za-z0-9]/g, '')}_${String(live.length - i).padStart(3, '0')}`,
    seq: live.length - i,
    snapshotId: `${(live.length - i).toString(16).padStart(8, '0')}`,
    createdAt: b.when.toISOString(),
    reason: b.reason,
    ...(b.releaseId ? { releaseId: b.releaseId } : {}),
    version: '0.198.0',
    schemaVersion: 140,
    bytes: Math.round(6.2 * GB),
    bytesAdded: b.added * MB,
    applianceId: appliance,
    own,
    check: b === sunday ? { at: new Date(b.when.getTime() + 3 * 3600_000).toISOString(), ok: true } : null,
    covered: FIXTURE_COVERED,
    ...(b === gap ? { incomplete: { attachments: 1 } } : {}),
  }));
}

export function createFakeBackupOptions(options: FakeBackupOptionsOptions = {}): FakeBackupOptions {
  const keys = new Map<string, Uint8Array>();
  const salts = new Map<string, string>();
  let verification: string | null = null;
  const now = options.now ?? Date.now;
  const appliance = options.appliance ?? 'wb-3fkq-8mzt-2049';
  const stage = options.restoreStageMs ?? 2500;
  let protectedNow = options.protectedAtStart ?? true;
  /** What the backup service says of the backups while protected (the world's state follows it). */
  let backupState: Exclude<FakeBackupState, 'unprotected'> = 'protected';
  let display = 'blackbox';
  let policy: BackupPolicy = {
    ...BACKUP_POLICY_DEFAULT,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
  let list = backupListFixture(now(), appliance);
  let local: { count: number; bytes: number; oldest: string; newest: string } | null = {
    count: 14,
    bytes: Math.round(4.1 * GB),
    oldest: at(now(), 14, 3).toISOString(),
    newest: at(now(), 0, 3).toISOString(),
  };
  const checking = new Map<string, number>();
  let running = false;
  let incomplete: string | null = null;
  let lastAt: number | null = null;
  let serviceDown = false;
  let earlierPlaces: { placeId: string; name: string }[] = [];
  /** The copy somewhere else (offsite-copy.md): its first copy finishes a few seconds after it was set up. */
  let offsite: (BackupOffsite & { setAt: number }) | null = null;
  const offsiteFixture = (kind: 'ok' | 'failing'): BackupOffsite & { setAt: number } => {
    const copied = new Date(at(now(), 0, 3).getTime() + 10 * 60_000).toISOString();
    return {
      provider: 'b2',
      display: 's3.eu-central-003.backblazeb2.com/blackbox-copy/home',
      endpoint: 's3.eu-central-003.backblazeb2.com',
      bucket: 'blackbox-copy',
      folder: 'home',
      region: null,
      state: kind,
      configuredAt: new Date(now() - 20 * 86_400_000).toISOString(),
      lastCopyAt: kind === 'ok' ? copied : new Date(now() - 2 * 86_400_000).toISOString(),
      newestInCopyAt: kind === 'ok' ? at(now(), 0, 3).toISOString() : at(now(), 2, 3).toISOString(),
      newestBackupAt: at(now(), 0, 3).toISOString(),
      backupsInCopy: list.length,
      failedAttempts: kind === 'failing' ? 3 : 0,
      lastFailure: kind === 'failing' ? { at: new Date(now() - 3600_000).toISOString(), step: 'keys' } : null,
      nextTryAt: kind === 'failing' ? new Date(now() + 2 * 3600_000).toISOString() : null,
      lastClearedAt: null,
      setAt: 0,
    };
  };
  /** The copy as the backup service says it now (its first copy done once a few seconds passed). */
  const offsiteNow = (): BackupOffsite | null => {
    if (!offsite) return null;
    const { setAt, ...copy } = offsite;
    if ((copy.state === 'first' || copy.state === 'copying') && setAt && now() - setAt > 4000) {
      offsite = {
        ...offsite,
        state: 'ok',
        lastCopyAt: new Date(now()).toISOString(),
        newestInCopyAt: copy.newestBackupAt,
        backupsInCopy: list.length,
      };
      return offsiteNow();
    }
    return copy;
  };
  let bringBack: BackupBringBack = {
    state: options.bringBackAtStart ?? 'ready',
    setup: (options.bringBackAtStart ?? 'ready') === 'ready' ? 'verified' : 'none',
    verifiedAt:
      (options.bringBackAtStart ?? 'ready') === 'ready' ? new Date(now() - 7200_000).toISOString() : null,
    nasCopyAt: null,
    passkeys: (options.bringBackAtStart ?? 'ready') === 'ready' ? 1 : 0,
    lockedAt:
      (options.bringBackAtStart ?? 'ready') === 'ready' ? new Date(now() - 7200_000).toISOString() : null,
    paperAt: options.bringBackAtStart === 'paper_only' ? new Date(now() - 86_400_000).toISOString() : null,
  };
  let adopted: { oldApplianceId: string; checkpoints: BackupCheckpoint[] } | null = null;
  let restore: {
    startedAt: number;
    checkpoint: BackupCheckpoint;
    answered: number | null;
    phase: 'restoring' | 'checking' | 'failed' | 'released';
  } | null = null;

  const restoreState = () => {
    if (!restore)
      return {
        phase: 'none',
        stage: null,
        since: null,
        error: null,
        restored: null,
        oldApplianceId: null,
        relogin: [],
        servers: null,
        items: [],
      };
    const t = now() - restore.startedAt;
    const stages = ['prepare', 'check', 'restore', 'restore', 'database', 'release', 'start'];
    const i = Math.floor(t / stage);
    if (restore.phase === 'restoring' && options.restoreStops && !restore.answered && i >= 4)
      restore.phase = 'failed';
    if (restore.phase === 'restoring' && i >= stages.length) restore.phase = 'checking';
    const items = [
      { id: 'old_whombat', required: true, resolution: restore.answered ? 'gone' : null },
      { id: 'signins', required: true, resolution: restore.answered ? 'checked' : null },
      { id: 'devices', required: true, resolution: restore.answered ? 'reviewed' : null },
      { id: 'revocations', required: true, resolution: 'none_after_backup' },
    ];
    return {
      phase: restore.phase,
      stage: restore.phase === 'restoring' ? (stages[i] ?? 'start') : null,
      since: new Date(restore.startedAt).toISOString(),
      error:
        restore.phase === 'failed'
          ? 'Your Whombat restarted before it finished. It’s as it was before, and you can try again.'
          : null,
      ...(restore.phase === 'failed' ? { reason: 'interrupted' } : {}),
      restored: {
        checkpointId: restore.checkpoint.id,
        createdAt: restore.checkpoint.createdAt,
        schemaVersion: restore.checkpoint.schemaVersion,
      },
      oldApplianceId: restore.checkpoint.applianceId,
      relogin: ['acc_mara/claude', 'acc_mara/github'],
      servers: 'staged',
      items,
      // As the box says once it is back: Whombat set BlackBox up, so it gives it a new password itself.
      ...(restore.phase === 'checking' || restore.phase === 'released'
        ? { newPassword: { by: 'whombat' as const, place: 'BlackBox' } }
        : {}),
    };
  };

  /** The runtime is stopped while the backup is put back and the database made writable (stages 2–5). */
  const away = () => {
    if (!restore) return false;
    if (restore.phase === 'restoring') {
      const i = Math.floor((now() - restore.startedAt) / stage);
      return i >= 2 && i <= 5;
    }
    // After the answers the runtime and servers restart once.
    return restore.answered !== null && now() - restore.answered < stage;
  };

  const status = () => {
    const last = list[0] ?? null;
    // As the world's own status says: backed up a couple of hours ago, or days ago while behind or failing; just now
    // after Back up now.
    const lastAgeS =
      backupState === 'stale' || backupState === 'failing'
        ? 80 * 3600
        : lastAt !== null
          ? Math.max(0, Math.round((now() - lastAt) / 1000))
          : 7200;
    const backedUp = protectedNow && backupState !== 'pending';
    return {
      status: protectedNow
        ? {
            kind: 'whombat.backup-status/1',
            state: backupState,
            protected: backupState !== 'pending',
            destination: {
              configured: true,
              kind: 'rest',
              display,
              appendOnly: 'verified',
              repositoryId: 'repo_blackbox',
            },
            lastSuccess:
              last && backupState !== 'pending'
                ? {
                    id: last.id,
                    at: new Date(now() - lastAgeS * 1000).toISOString(),
                    ageSeconds: lastAgeS,
                    snapshotId: last.snapshotId,
                    method: 'quiesce',
                    quiesceHeldMs: 80,
                    durationMs: 15_000,
                    bytesAdded: last.bytesAdded ?? 0,
                    totalBytes: last.bytes,
                    files: 41_230,
                    schemaVersion: last.schemaVersion,
                    ...(incomplete ? { incomplete: { attachments: 1, reason: incomplete } } : {}),
                  }
                : null,
            lastFailure:
              backupState === 'failing'
                ? {
                    id: 'bkf_upload',
                    at: new Date(now() - 3600_000).toISOString(),
                    stage: 'upload',
                    reason: "The backup destination didn't answer.",
                  }
                : null,
            lastAttemptOk: backupState !== 'failing',
            coverage: [],
            recoverability: {
              lastDrill: (() => {
                const checked = list.find((c) => c.check);
                return checked?.check
                  ? {
                      at: checked.check.at,
                      ok: checked.check.ok,
                      checkpointId: checked.id,
                      rtoSeconds: 140,
                      backupAgeSeconds: 10_800,
                    }
                  : null;
              })(),
            },
            kitGeneration: 2,
            running: running
              ? { id: 'chk_now', op: 'checkpoint', stage: 'upload', since: new Date(now()).toISOString() }
              : null,
            updatedAt: new Date(now()).toISOString(),
          }
        : null,
      summary: {
        state: protectedNow ? backupState : 'unprotected',
        lastSuccessAt: backedUp ? new Date(now() - lastAgeS * 1000).toISOString() : null,
        ageS: backedUp ? lastAgeS : null,
        coverage: [],
        unprotected: [],
        relogin: [],
        lastFailure:
          protectedNow && backupState === 'failing'
            ? {
                at: new Date(now() - 3600_000).toISOString(),
                stage: 'upload',
                reason: "The backup destination didn't answer.",
              }
            : null,
        recoverable: backedUp && backupState !== 'failing',
        ...(incomplete && backedUp ? { incomplete: { reason: incomplete, attachments: 1 } } : {}),
        bringBack: protectedNow
          ? { ...bringBack, nasCopyAt: bringBack.lockedAt }
          : { state: 'none', passkeys: 0, lockedAt: null, nasCopyAt: null, paperAt: null },
        offsite: protectedNow ? offsiteNow() : null,
      },
    };
  };

  return {
    restorePhase: () => restore?.phase ?? 'none',
    bringBack: () =>
      (status().summary as { bringBack: ReturnType<FakeBackupOptions['bringBack']> }).bringBack,
    set(patch) {
      if (patch.running !== undefined) running = patch.running;
      if (patch.incomplete !== undefined) incomplete = patch.incomplete;
      if (patch.bringBack) bringBack = { ...bringBack, state: patch.bringBack };
      if (patch.restoreStops !== undefined) options.restoreStops = patch.restoreStops;
      if (patch.nearKits) options.nearKits = patch.nearKits;
      if (patch.serviceDown !== undefined) serviceDown = patch.serviceDown;
      if (patch.earlierPlaces) earlierPlaces = patch.earlierPlaces;
      if (patch.offsite !== undefined) offsite = patch.offsite ? offsiteFixture(patch.offsite) : null;
    },
    follow(state, destination) {
      protectedNow = state !== 'unprotected';
      backupState = state === 'unprotected' ? 'protected' : state;
      display = destination ? repositoryDisplay(destination) : 'blackbox';
    },
    call(op, raw) {
      if (!OPS.has(op)) return null;
      if (options.available === false) return Promise.resolve(err(404, 'unknown_op', `No operation ${op}`));
      const input = (raw ?? {}) as Record<string, unknown>;
      // A check finishes a few seconds after it was asked for.
      for (const [id, asked] of checking)
        if (now() - asked > 4000) {
          list = list.map((c) =>
            c.id === id ? { ...c, check: { at: new Date(now()).toISOString(), ok: true } } : c,
          );
          checking.delete(id);
        }
      if (op === 'backup.restoreState') {
        if (away()) return Promise.resolve(err(503, 'unavailable', 'The runtime is stopped.'));
        return Promise.resolve(ok(restoreState()));
      }
      if (op === 'backup.status') return Promise.resolve(ok(status()));
      if (op === 'backup.offsite') return Promise.resolve(ok({ offsite: offsiteNow() }));
      // A bucket named with “wrong-key” refuses the key, so the form's sentence for a failed step can be seen.
      if (op === 'backup.setOffsite') {
        const bucket = String(input.bucket ?? '');
        if (bucket.includes('wrong-key'))
          return Promise.resolve(
            err(409, 'conflict', 'The storage didn’t accept the key.', {
              code: 'backup_offsite_failed',
              step: 'keys',
            }),
          );
        const endpoint = String(input.endpoint ?? '').replace(/^https?:\/\//, '');
        const folder = String(input.folder ?? '');
        offsite = {
          provider: (input.provider as BackupOffsite['provider']) ?? 's3',
          display: [endpoint, bucket, folder].filter(Boolean).join('/'),
          endpoint,
          bucket,
          folder,
          region: typeof input.region === 'string' ? input.region : null,
          state: 'first',
          configuredAt: new Date(now()).toISOString(),
          lastCopyAt: null,
          newestInCopyAt: null,
          newestBackupAt: list[0]?.createdAt ?? null,
          backupsInCopy: 0,
          failedAttempts: 0,
          lastFailure: null,
          nextTryAt: null,
          lastClearedAt: null,
          setAt: now(),
        };
        return new Promise((resolve) => setTimeout(() => resolve(ok({ offsite: offsiteNow() })), 900));
      }
      if (op === 'backup.removeOffsite') {
        offsite = null;
        return Promise.resolve(ok({ offsite: null }));
      }
      if (op === 'backup.copyOffsite') {
        if (!offsite)
          return Promise.resolve(
            err(409, 'conflict', 'There’s no copy to make.', { code: 'backup_offsite_none' }),
          );
        offsite = {
          ...offsite,
          state: 'copying',
          failedAttempts: 0,
          lastFailure: null,
          nextTryAt: null,
          setAt: now(),
        };
        return Promise.resolve(ok({ queued: true }));
      }
      // Back up now answers once the backup is made (a moment here).
      if (op === 'backup.runNow') {
        if (!protectedNow) return Promise.resolve(err(409, 'backup_unprotected', 'No destination.'));
        running = true;
        return new Promise((r) =>
          setTimeout(() => {
            running = false;
            lastAt = now();
            const seq = (list[0]?.seq ?? 0) + 1;
            const made: BackupCheckpoint = {
              ...(list[0] as BackupCheckpoint),
              id: `cp_now_${seq}`,
              seq,
              createdAt: new Date(now()).toISOString(),
              reason: 'manual',
              bytesAdded: 4 * MB,
              check: null,
            };
            list = [made, ...list];
            r(
              ok({
                ok: true,
                ref: made.id,
                verified: false,
                id: made.id,
                seq,
                snapshotId: made.snapshotId,
                manifestSha256: '0'.repeat(64),
                createdAt: made.createdAt,
                schemaVersion: made.schemaVersion,
              }),
            );
          }, 1500),
        );
      }
      // The passkey's key and the paper copy (backup-passkey.md): where bringing it back stands follows them.
      if (op === 'backup.passkeyKey.set') {
        const input = raw as { credentialId: string; key: string; salt: string };
        const key = fromBase64url(input.key);
        const previous = keys.get(input.credentialId);
        const unchanged =
          key && previous && key.length === previous.length && key.every((byte, i) => byte === previous[i]);
        if (key) keys.set(input.credentialId, key);
        // The check asks for the salt the key was armed with (a box passkey's is random, own-address.md).
        salts.set(input.credentialId, input.salt);
        bringBack = {
          ...bringBack,
          state: 'ready',
          setup: unchanged ? bringBack.setup : 'verify',
          verifiedAt: unchanged ? bringBack.verifiedAt : null,
          passkeys: Math.max(bringBack.passkeys, keys.size),
          lockedAt: new Date(now()).toISOString(),
        };
        return Promise.resolve(ok({ bringBack: { ...bringBack, nasCopyAt: bringBack.lockedAt } }));
      }
      if (op === 'backup.passkeyKey.verifyBegin') {
        const key = keys.get((raw as { credentialId: string }).credentialId);
        const peer = options.appliancePeerId;
        if (!key || !peer)
          return Promise.resolve({
            status: 409,
            body: {
              error: {
                code: 'conflict',
                message: 'The backup details are still being saved.',
                details: { code: 'backup_passkey_saving' },
              },
            },
          });
        verification = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
        return Promise.resolve(
          ok({
            salt: salts.get((raw as { credentialId: string }).credentialId) ?? KIT_PRF_SALT_V2_B64,
            envelope: sealKitWithKey(
              JSON.stringify({
                kind: 'whombat.backup-recovery-material/1',
                applianceId: options.appliance ?? 'wb-home',
                generation: 1,
                createdAt: new Date(now()).toISOString(),
                repository: 'rest:http://nas/home',
                repositoryPassword: 'fake-backup-password',
                repositoryId: 'repo_fake',
                manifestKey: 'ed25519:AAAA',
              }),
              key,
              peer,
            ),
            challenge: sealKitWithKey(verification, key, `verification:${peer}`),
          }),
        );
      }
      if (op === 'backup.passkeyKey.verifyConfirm') {
        if (!verification || (raw as { proof: string }).proof !== verification)
          return Promise.resolve({
            status: 403,
            body: { error: { code: 'forbidden', message: 'The passkey didn’t verify.' } },
          });
        verification = null;
        bringBack = {
          ...bringBack,
          setup: 'verified',
          verifiedAt: new Date(now()).toISOString(),
        };
        return Promise.resolve(
          ok({
            bringBack: {
              ...bringBack,
              nasCopyAt: bringBack.lockedAt,
            },
          }),
        );
      }
      if (op === 'backup.passkeyKey.remove') {
        const passkeys = Math.max(0, bringBack.passkeys - 1);
        bringBack = {
          ...bringBack,
          passkeys,
          state: passkeys ? 'ready' : bringBack.paperAt ? 'paper_only' : 'needs_passkey',
        };
        return Promise.resolve(ok({ bringBack: { ...bringBack, nasCopyAt: bringBack.lockedAt } }));
      }
      if (op === 'backup.paperCopy.confirm') {
        bringBack = {
          ...bringBack,
          paperAt: new Date(now()).toISOString(),
          state: bringBack.state === 'ready' ? 'ready' : 'paper_only',
        };
        return Promise.resolve(ok({ bringBack: { ...bringBack, nasCopyAt: bringBack.lockedAt } }));
      }
      // Looking next to backups on this network takes a moment.
      if (op === 'backup.findKits') {
        const kits = options.nearKits ?? [];
        return new Promise((r) => setTimeout(() => r(ok({ kits, places: kits.length ? 1 : 0 })), 1200));
      }
      if (op === 'backup.letAssistantSetUp') return Promise.resolve(ok({ ok: true }));
      // The backup service not answering: the overview keeps what the runtime knows and says so; the rest is refused.
      if (serviceDown && op === 'backup.overview')
        return Promise.resolve(
          ok({
            status: null,
            summary: status().summary,
            places: null,
            checkpoints: null,
            policy: null,
            notice: SERVICE_DOWN,
            earlierPlaces: [],
          }),
        );
      if (serviceDown && (op === 'backup.status' || op === 'backup.checkpoints' || op === 'backup.policy'))
        return Promise.resolve(err(503, 'backup_unavailable', SERVICE_DOWN));
      // The Backups page in one answer (backup-options.md CT-1691): the same parts as the ops below.
      if (op === 'backup.overview')
        return Promise.resolve(
          ok({
            ...status(),
            places: null,
            checkpoints: protectedNow
              ? {
                  checkpoints: list,
                  unauthentic: 0,
                  local,
                  space: { usedBytes: Math.round(6.2 * GB), freeBytes: Math.round(1.9 * 1000 * GB) },
                }
              : null,
            policy: { policy, clearedBy: protectedNow ? 'place' : 'none' },
            notice: null,
            earlierPlaces,
          }),
        );
      if (op === 'backup.checkpoints') {
        if (!protectedNow) return Promise.resolve(err(409, 'backup_unprotected', 'No destination.'));
        return Promise.resolve(
          ok({
            checkpoints: list,
            unauthentic: 0,
            local,
            space: { usedBytes: Math.round(6.2 * GB), freeBytes: Math.round(1.9 * 1000 * GB) },
          }),
        );
      }
      if (op === 'backup.policy')
        return Promise.resolve(ok({ policy, clearedBy: protectedNow ? 'place' : 'none' }));
      if (op === 'backup.setPolicy') {
        policy = {
          ...policy,
          frequency: input.frequency as BackupPolicy['frequency'],
          keep: input.keep as BackupPolicy['keep'],
          limitBytes: (input.limitBytes as number | null) ?? null,
          weeklyCheck: input.weeklyCheck === true,
        };
        return Promise.resolve(ok({ policy, clearedBy: 'place' }));
      }
      if (op === 'backup.check') {
        const id = String(input.checkpointId ?? '');
        if (!list.some((c) => c.id === id)) return Promise.resolve(err(404, 'not_found', 'No such backup.'));
        checking.set(id, now());
        return Promise.resolve(ok({ queued: true }));
      }
      if (op === 'backup.moveLocal') {
        const copied = local?.count ?? 0;
        local = null;
        return new Promise((r) => setTimeout(() => r(ok({ copied })), 1500));
      }
      if (op === 'backup.removeLocal') {
        local = null;
        return Promise.resolve(ok({ ok: true }));
      }
      if (op === 'backup.adopt') {
        const material = kitMaterialOf(String(input.kit ?? ''));
        if (!material) return Promise.resolve(err(400, 'invalid_kit', 'That is not a recovery kit.'));
        // A box with backups of its own gives way only when the person said so (`replace`).
        if (protectedNow && list.some((c) => c.own) && input.replace !== true)
          return Promise.resolve(err(409, 'backup_has_own', 'This Whombat has backups of its own.'));
        adopted = {
          oldApplianceId: material.applianceId,
          checkpoints: backupListFixture(now() - 7 * 3600_000, material.applianceId, false),
        };
        return new Promise((r) => setTimeout(() => r(ok(adopted)), 1200));
      }
      if (op === 'backup.restore') {
        const checkpoint = adopted?.checkpoints.find((c) => c.id === input.checkpointId);
        if (!checkpoint) return Promise.resolve(err(404, 'not_found', 'No such backup.'));
        // Trying again after it stopped goes through.
        if (restore?.phase === 'failed') options.restoreStops = false;
        restore = { startedAt: now(), checkpoint, answered: null, phase: 'restoring' };
        return Promise.resolve(ok({ started: true }));
      }
      if (op === 'backup.finishRestore') {
        if (!restore || restoreState().phase !== 'checking')
          return Promise.resolve(err(409, 'conflict', 'Nothing to finish.'));
        restore.answered = now();
        restore.phase = 'released';
        protectedNow = true;
        // The passkeys that came with the backup name the old Whombat: none holds this one's key yet.
        bringBack = { state: 'needs_passkey', passkeys: 0, lockedAt: null, nasCopyAt: null, paperAt: null };
        list = adopted?.checkpoints.map((c) => ({ ...c })) ?? list;
        local = null;
        return Promise.resolve(ok(restoreState()));
      }
      return null;
    },
  };
}
