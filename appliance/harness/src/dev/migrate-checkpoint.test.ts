import { describe, expect, it } from 'vitest';
import type { EnvState } from './env.ts';
import {
  CHECKPOINT_REQUIRED_EXIT,
  checkpointRequired,
  type MigrateRun,
  migrateRuntime,
  offlineBackupConfig,
  parseBackupRun,
  type StackBackup,
  validCheckpointId,
} from './migrate-checkpoint.ts';
import { stackBackup } from './services.ts';

// What Whombat's `whombat migrate --json --env` printed on the dev stack for step 4 (exit 13).
const needsCheckpoint: MigrateRun = {
  code: CHECKPOINT_REQUIRED_EXIT,
  stdout: `${JSON.stringify({
    format: 'whombat.migrate/1',
    ok: false,
    applied: [],
    error: {
      kind: 'checkpoint_required',
      message: 'Migration 0003_one_mode narrows which Whombat versions may write this database …',
      migrations: ['0003_one_mode'],
    },
  })}\n`,
};
const migrated: MigrateRun = {
  code: 0,
  stdout: JSON.stringify({ format: 'whombat.migrate/1', ok: true, applied: ['0003_one_mode'] }),
};
const ID = 'ck-20261024T101500Z-a1b2c3';

function world(first: MigrateRun, opts: { missing?: string; given?: string; second?: MigrateRun } = {}) {
  const calls: (string | null)[] = [];
  const lines: string[] = [];
  let taken = 0;
  const backup: StackBackup = {
    missing: async () => opts.missing ?? null,
    take: async () => {
      taken++;
      return { id: ID, snapshotId: '219491cd0f00', seq: 2, durationMs: 3400 };
    },
  };
  const run = () =>
    migrateRuntime({
      given: opts.given ?? null,
      migrate: async (checkpoint) => {
        calls.push(checkpoint);
        return calls.length === 1 ? first : (opts.second ?? migrated);
      },
      backup,
      log: (l) => lines.push(l),
      hint: 'see runtime-migrate.log',
    });
  return { run, calls, lines, taken: () => taken };
}

describe('a contract migration on the dev stack (IN-424)', () => {
  it('migrates once when nothing needs a checkpoint', async () => {
    const w = world(migrated);
    await expect(w.run()).resolves.toEqual({ checkpoint: null });
    expect(w.calls).toEqual([null]);
    expect(w.taken()).toBe(0);
  });

  it('takes a backup when migrate exits 13 and migrates again with its id', async () => {
    const w = world(needsCheckpoint);
    await expect(w.run()).resolves.toEqual({ checkpoint: ID });
    expect(w.calls).toEqual([null, ID]);
    expect(w.taken()).toBe(1);
    expect(w.lines.join('\n')).toContain('0003_one_mode');
    expect(w.lines.at(-1)).toContain(ID);
  });

  it('keeps the error, with a hint, when the stack runs no backup service', async () => {
    const w = world(needsCheckpoint, { missing: 'the stack runs no backup service' });
    const err = await w.run().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain('exit 13');
    expect(String(err)).toContain('no backup service');
    expect(String(err)).toContain('--without backup');
    expect(String(err)).toContain('runtime-migrate.log');
    expect(w.calls).toEqual([null]);
    expect(w.taken()).toBe(0);
  });

  it('takes no backup for any other failure, nor when a checkpoint was given', async () => {
    const refused = world({ code: 12, stdout: '{"ok":false,"error":{"kind":"schema_mismatch"}}' });
    await expect(refused.run()).rejects.toThrow(/exit 12/);
    expect(refused.taken()).toBe(0);
    const given = world(needsCheckpoint, { given: 'ck-from-the-helper' });
    await expect(given.run()).rejects.toThrow(/exit 13/);
    expect(given.calls).toEqual(['ck-from-the-helper']);
    expect(given.taken()).toBe(0);
  });

  it('says so when the migration fails with the checkpoint too', async () => {
    const w = world(needsCheckpoint, { second: { code: 1, stdout: '{"ok":false}' } });
    await expect(w.run()).rejects.toThrow(new RegExp(`exit 1\\).*${ID}`));
    expect(w.calls).toEqual([null, ID]);
  });

  it('reads exit 13 or the answer’s kind, and the migrations listed', () => {
    expect(checkpointRequired(needsCheckpoint)).toEqual({ migrations: ['0003_one_mode'] });
    expect(checkpointRequired({ code: 13, stdout: 'not json' })).toEqual({ migrations: [] });
    expect(
      checkpointRequired({ code: 1, stdout: 'warning\n{"error":{"kind":"checkpoint_required"}}' }),
    ).toEqual({ migrations: [] });
    expect(checkpointRequired({ code: 1, stdout: '{"error":{"kind":"failed"}}' })).toBeNull();
    expect(checkpointRequired(migrated)).toBeNull();
  });

  it('passes only ids the box’s helper would accept', async () => {
    expect(validCheckpointId(ID)).toBe(true);
    expect(validCheckpointId('../x')).toBe(false);
    expect(validCheckpointId('ck x')).toBe(false);
    const backup: StackBackup = { missing: async () => null, take: async () => ({ id: '-bad' }) };
    await expect(
      migrateRuntime({ given: null, migrate: async () => needsCheckpoint, backup, log: () => {}, hint: '' }),
    ).rejects.toThrow(/-bad/);
  });
});

describe('the offline checkpoint (IN-424)', () => {
  it('uses the service’s config without the runtime admin socket', () => {
    const c = JSON.parse(
      offlineBackupConfig(JSON.stringify({ apiSocket: '/r/backup.sock', runtimeSocket: '/r/admin.sock' })),
    );
    expect(c).toEqual({ apiSocket: '/r/backup.sock', runtimeSocket: '', allowNoRuntime: true });
  });

  it('reads whombat-backup run -json', () => {
    const out = JSON.stringify(
      { id: ID, seq: 2, snapshotId: '219491cd', manifestSha256: 'ab', durationMs: 3400, quiesce: {} },
      null,
      2,
    );
    expect(parseBackupRun(out)).toEqual({ id: ID, seq: 2, snapshotId: '219491cd', durationMs: 3400 });
    expect(() => parseBackupRun('')).toThrow(/no checkpoint id/);
  });

  it('is unavailable without a running backup service', async () => {
    const state = { services: {}, sources: {} } as unknown as EnvState;
    await expect(stackBackup(state).missing()).resolves.toMatch(/no backup service/);
  });
});
