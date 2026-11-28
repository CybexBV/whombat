/**
 * Backups in the demo world (app docs/app/decisions/backup-options-android.md AP-6864, backup-v2.md): the backup ops a
 * box answers — `backup.status`, `backup.overview`, `backup.checkpoints`, `backup.policy`, `backup.setPolicy`,
 * `backup.check`, `backup.runNow`, `backup.moveLocal`, `backup.removeLocal` — on BlackBox, the NAS that keeps them:
 * 6.2 GB used and 1.9 TB free, backed up two hours ago (just now after Back up now), can be brought back with the
 * passkey, 23 backups over three weeks (the 6-hourly ones of today and yesterday, the update to 0.198, one a day before
 * that, checked on Sunday, one that left an attachment out) each with what it covers, and 14 older ones still on the
 * box's own disk. The times follow the demo's clock. Pure TypeScript.
 */
import { createFakeBackupLook, createFakeSession } from '@whombat/client/fake';
import type { ApplianceSession } from '@whombat/client/session';
import {
  BACKUP_POLICY_DEFAULT,
  BACKUP_STATUS_KIND,
  type BackupCheckpoint,
  type BackupCheckpointsOutput,
  type BackupOffsite,
  type BackupPolicy,
  type BackupPolicyOutput,
  BackupSetOffsiteInput,
  BackupSetPolicyInput,
} from '@whombat/protocol/session';

const HOUR = 3_600_000;

function at(now: Date, daysBack: number, hour: number, minute = 0): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - daysBack);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The demo's backups, newest first, made before `now`. */
export function demoCheckpoints(now: Date): BackupCheckpoint[] {
  const made: { when: Date; reason: BackupCheckpoint['reason']; added: number; releaseId?: string }[] = [];
  for (const h of [21, 15, 9, 3]) made.push({ when: at(now, 0, h), reason: 'scheduled', added: 0 });
  made.push({ when: at(now, 1, 21), reason: 'scheduled', added: 9e6 });
  made.push({ when: at(now, 1, 18, 45), reason: 'pre-migration', added: 41e6, releaseId: 'whombat-0.198' });
  made.push({ when: at(now, 1, 15), reason: 'manual', added: 12e6 });
  for (const h of [9, 3]) made.push({ when: at(now, 1, h), reason: 'scheduled', added: 30e6 });
  for (let d = 2; d <= 20; d++)
    made.push({ when: at(now, d, 3), reason: 'scheduled', added: 20e6 + d * 9e6 });
  const sizes = [41e6, 12e6, 88e6];
  const list = made
    .filter((m) => m.when.getTime() < now.getTime() - 30 * 60_000)
    .sort((a, b) => b.when.getTime() - a.when.getTime());
  // The demo shows 23: the oldest is BlackBox's first, the whole of it.
  const shown = list.slice(0, 23);
  const sunday = shown.find((m) => m.when.getDay() === 0 && m.when.getHours() === 3) ?? shown[3];
  // One a few days back left an attachment out (it wasn't on the box any more).
  const gap = shown.find((m, i) => i > 10 && m !== sunday);
  return shown.map((m, i) => ({
    id: `cp_demo_${String(shown.length - i).padStart(3, '0')}`,
    seq: shown.length - i,
    snapshotId: `snap${String(shown.length - i).padStart(4, '0')}`,
    createdAt: iso(m.when),
    reason: i === shown.length - 1 ? 'scheduled' : m.reason,
    ...(m.releaseId && { releaseId: m.releaseId }),
    schemaVersion: 180,
    bytes: 3_600_000_000,
    bytesAdded: i === shown.length - 1 ? 3_600_000_000 : m.added || (sizes[i] ?? 20e6),
    applianceId: 'demo-whombat',
    own: true,
    check: m === sunday ? { at: iso(new Date(m.when.getTime() + 4 * HOUR)), ok: true } : null,
    covered: DEMO_COVERED,
    ...(m === gap ? { incomplete: { attachments: 1 } } : {}),
  }));
}

/** What every demo backup covers (`BackupScope`): a box without servers. */
const DEMO_COVERED = [
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

export interface DemoBackups {
  /** Answers one op as the box does, or null when it isn't a backup op. */
  handle(op: string, input: unknown): { status: number; body: unknown } | null;
  /** A session on an in-memory box that answers them (the demo's Backups screens). */
  session(): ApplianceSession;
}

export function createDemoBackups(now: () => Date = () => new Date()): DemoBackups {
  let policy: BackupPolicy = { ...BACKUP_POLICY_DEFAULT, timeZone: 'Europe/Amsterdam' };
  let local: BackupCheckpointsOutput['local'] = null;
  let checked = new Map<string, { at: string; ok: boolean }>();
  let localSet = false;
  /** When Back up now last made one (the status says “just now” then). */
  let madeAt: Date | null = null;
  /** The copy somewhere else (offsite-copy.md): a bucket at Backblaze, copied ten minutes after the last backup. */
  let offsite: BackupOffsite | null | 'demo' = 'demo';
  const offsiteNow = (t: Date, lastAt: Date): BackupOffsite | null => {
    if (offsite !== 'demo') return offsite;
    return {
      provider: 'b2',
      display: 's3.eu-central-003.backblazeb2.com/blackbox-copy/home',
      endpoint: 's3.eu-central-003.backblazeb2.com',
      bucket: 'blackbox-copy',
      folder: 'home',
      region: null,
      state: 'ok',
      configuredAt: iso(at(t, 20, 9)),
      lastCopyAt: iso(new Date(Math.min(t.getTime(), lastAt.getTime() + 10 * 60_000))),
      newestInCopyAt: iso(lastAt),
      newestBackupAt: iso(lastAt),
      backupsInCopy: demoCheckpoints(t).length,
      failedAttempts: 0,
      lastFailure: null,
      nextTryAt: null,
      lastClearedAt: null,
    };
  };
  const list = (): BackupCheckpointsOutput => {
    const t = now();
    if (!localSet) {
      localSet = true;
      local = { count: 14, bytes: 4_100_000_000, oldest: iso(at(t, 14, 3)), newest: iso(at(t, 0, 3)) };
    }
    return {
      checkpoints: demoCheckpoints(t).map((c) => ({ ...c, check: checked.get(c.id) ?? c.check })),
      unauthentic: 0,
      local,
      space: { usedBytes: 6_200_000_000, freeBytes: 1_900_000_000_000 },
    };
  };
  const ok = (body: unknown) => ({ status: 200, body });
  const policyOut = (): BackupPolicyOutput => ({ policy, clearedBy: 'place' });
  const handle = (op: string, input: unknown): { status: number; body: unknown } | null => {
    const t = now();
    // Backed up two hours ago, or when Back up now last made one.
    const lastAt = madeAt ?? new Date(t.getTime() - 2 * HOUR);
    const lastAge = Math.max(0, Math.round((t.getTime() - lastAt.getTime()) / 1000));
    switch (op) {
      case 'backup.status': {
        const cps = list().checkpoints;
        const last = cps[0];
        const drill = cps.find((c) => c.check);
        return ok({
          status: {
            kind: BACKUP_STATUS_KIND,
            state: 'protected',
            protected: true,
            destination: { configured: true, kind: 'rest', display: 'BlackBox', appendOnly: 'verified' },
            lastSuccess: last
              ? {
                  id: last.id,
                  at: iso(lastAt),
                  ageSeconds: lastAge,
                  snapshotId: last.snapshotId,
                  method: 'restic',
                  quiesceHeldMs: 80,
                  durationMs: 15_000,
                  bytesAdded: last.bytesAdded ?? 0,
                  totalBytes: last.bytes,
                  files: 12_400,
                  schemaVersion: last.schemaVersion,
                }
              : null,
            lastFailure: null,
            lastAttemptOk: true,
            coverage: [],
            recoverability: {
              lastDrill: drill?.check
                ? {
                    at: drill.check.at,
                    ok: drill.check.ok,
                    checkpointId: drill.id,
                    rtoSeconds: 240,
                    backupAgeSeconds: 14_400,
                  }
                : null,
            },
            kitGeneration: 1,
            running: null,
            updatedAt: iso(t),
          },
          summary: {
            state: 'protected',
            lastSuccessAt: iso(lastAt),
            ageS: lastAge,
            coverage: ['database', 'memory', 'attachments'],
            unprotected: [],
            relogin: [],
            lastFailure: null,
            recoverable: true,
            // A passkey holds the key to these backups (backup-passkey.md BPK-08).
            bringBack: {
              state: 'ready',
              passkeys: 1,
              lockedAt: iso(lastAt),
              nasCopyAt: iso(lastAt),
              paperAt: null,
            },
            offsite: offsiteNow(t, lastAt),
          },
        });
      }
      case 'backup.offsite':
        return ok({ offsite: offsiteNow(t, lastAt) });
      // The demo checks nothing: the copy is set up, and its first copy is on its way.
      case 'backup.setOffsite': {
        const parsed = BackupSetOffsiteInput.safeParse(input);
        if (!parsed.success)
          return { status: 400, body: { error: { code: 'invalid', message: 'Invalid.' } } };
        const { provider, endpoint, bucket, folder = '', region } = parsed.data;
        const host = endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        offsite = {
          provider,
          display: [host, bucket, folder].filter(Boolean).join('/'),
          endpoint: host,
          bucket,
          folder,
          region: region ?? null,
          state: 'first',
          configuredAt: iso(t),
          lastCopyAt: null,
          newestInCopyAt: null,
          newestBackupAt: iso(lastAt),
          backupsInCopy: 0,
          failedAttempts: 0,
          lastFailure: null,
          nextTryAt: null,
          lastClearedAt: null,
        };
        return ok({ offsite });
      }
      case 'backup.removeOffsite':
        offsite = null;
        return ok({ offsite: null });
      case 'backup.copyOffsite':
        if (offsite && offsite !== 'demo') offsite = { ...offsite, state: 'copying' };
        return ok({ queued: true });
      case 'backup.checkpoints':
        return ok(list());
      case 'backup.policy':
        return ok(policyOut());
      // The Backups page in one answer (backup-options.md CT-1691): the same parts as above.
      case 'backup.overview': {
        const status = handle('backup.status', {})?.body as Record<string, unknown>;
        return ok({ ...status, places: null, checkpoints: list(), policy: policyOut(), notice: null });
      }
      case 'backup.setPolicy': {
        const parsed = BackupSetPolicyInput.safeParse(input);
        if (!parsed.success)
          return { status: 400, body: { error: { code: 'invalid', message: 'Invalid.' } } };
        policy = { ...policy, ...parsed.data };
        return ok(policyOut());
      }
      case 'backup.runNow':
        madeAt = t;
        return ok({
          ok: true,
          ref: 'cp_demo_now',
          verified: false,
          id: 'cp_demo_now',
          seq: 24,
          snapshotId: 'snapnow',
          manifestSha256: '0'.repeat(64),
          createdAt: iso(t),
          schemaVersion: 180,
        });
      case 'backup.check': {
        const id = (input as { checkpointId?: string }).checkpointId;
        if (id) checked = new Map(checked).set(id, { at: iso(t), ok: true });
        return ok({ queued: true });
      }
      case 'backup.moveLocal': {
        const copied = local?.count ?? 0;
        local = null;
        return ok({ copied });
      }
      case 'backup.removeLocal':
        local = null;
        return ok({ ok: true });
      default:
        return null;
    }
  };
  let session: ApplianceSession | null = null;
  // Bringing things back from a backup (backup-look.md AP-6950): a few chats, files and automations in each backup.
  const look = createFakeBackupLook();
  return {
    handle,
    session() {
      session ??= createFakeSession({
        handle: async (op, input) =>
          handle(op, input) ??
          (await look.call(op, input)) ?? {
            status: 404,
            body: { error: { code: 'unknown_op', message: op } },
          },
        account: { id: 'acc_mara', name: 'Mara Okafor' },
        platform: 'android',
      }).session;
      return session;
    },
  };
}

let demo: DemoBackups | null = null;

/** The demo world's backups, once per app run (the demo's clock). */
export function demoBackups(now?: () => Date): DemoBackups {
  demo ??= createDemoBackups(now);
  return demo;
}
