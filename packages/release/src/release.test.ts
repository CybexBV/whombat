import { deriveSeedKeypair } from '@whombat/core/audit';
import { describe, expect, it } from 'vitest';
import { type AssignmentPayload, verifyAssignment } from './assignment.js';
import {
  checkActivation,
  checkCompatibleActivation,
  checkMigratingActivation,
  protocolOverlap,
  servesClient,
  updateClass,
} from './compat.js';
import { describeUpdateFailure, UpdateFailureDetail } from './failure.js';
import { canTransition, UPDATE_JOURNAL_TRANSITIONS, UpdateJournalState } from './journal.js';
import { signDocument } from './signed.js';
import { type ReleaseTuple, tupleDigest } from './tuple.js';
import { compareVersions } from './version.js';

const sp = (c: string, name: string) => `/nix/store/${c.repeat(32)}-${name}`;
const hash = (c: string) => `sha256:${c.repeat(64)}`;
export const tupleA: ReleaseTuple = {
  releaseId: 'rt-2026.09.25-1',
  runtime: {
    version: '2026.09.25-1',
    storePath: sp('a', 'whombat-runtime'),
    narHash: hash('a'),
    schemaReads: { min: 10, max: 12 },
    schemaWrites: 12,
    protocol: { min: 1000, max: 1000 },
    hostAbi: { min: 1, max: 1 },
  },
  providers: [{ provider: 'codex', version: '0.50.0', storePath: sp('b', 'codex'), narHash: hash('b') }],
  host: { version: '26.05.1', storePath: sp('c', 'nixos-system'), narHash: hash('c'), abi: 1 },
  manager: { version: '0.1.0', storePath: sp('d', 'whombat-manager'), narHash: hash('d') },
};
const tupleB: ReleaseTuple = {
  ...tupleA,
  releaseId: 'rt-2026.10.01-1',
  runtime: {
    ...tupleA.runtime,
    storePath: sp('f', 'whombat-runtime'),
    schemaReads: { min: 12, max: 14 },
    schemaWrites: 14,
  },
};

describe('tuples and compatibility', () => {
  it('classifies updates', () => {
    expect(updateClass(tupleA, tupleA)).toBe('none');
    expect(updateClass(tupleA, tupleB)).toBe('runtime');
    expect(
      updateClass(tupleA, { ...tupleA, host: { ...tupleA.host, storePath: sp('g', 'nixos-system') } }),
    ).toBe('host');
  });

  it('checks reader/writer compatibility', () => {
    const r = checkActivation(tupleA, tupleB, 12);
    expect(r).toMatchObject({ ok: true, rollbackCompatible: false, requiresCheckpoint: true });
    expect(checkActivation(tupleB, tupleA, 14).reasons).toEqual([
      'candidate_cannot_read_schema',
      'schema_downgrade',
    ]);
    expect(
      checkActivation(tupleA, { ...tupleB, runtime: { ...tupleB.runtime, hostAbi: { min: 2, max: 2 } } }, 12)
        .reasons,
    ).toEqual(['host_abi_unsupported']);
    expect(checkActivation(tupleA, tupleA, 12)).toMatchObject({ ok: true, rollbackCompatible: true });
  });

  it('judges a migrating candidate by the schema it migrates to and its floors (CT-134)', () => {
    const at = (reads: number, writes: number): ReleaseTuple => ({
      ...tupleA,
      runtime: { ...tupleA.runtime, schemaReads: { min: reads, max: reads }, schemaWrites: writes },
    });
    const cur = at(48, 48);
    const cand = { ...at(49, 49), runtime: { ...at(49, 49).runtime, storePath: sp('f', 'whombat-runtime') } };
    const m = (readers: number | null, writers: number | null, needsCheckpoint: string[] = []) => ({
      target: 49,
      readers,
      writers,
      needsCheckpoint,
    });
    // The production case: an expand the current schema reads and writes.
    expect(checkMigratingActivation(cur, cand, 48, m(48, 48))).toEqual({
      ok: true,
      requiresCheckpoint: false,
      rollbackCompatible: true,
      rollbackAccess: 'read-write',
      reasons: [],
    });
    // No floors: exactly the tuple-only check against the pre-migration schema (refused, as before).
    expect(checkMigratingActivation(cur, cand, 48, m(null, null))).toEqual(checkActivation(cur, cand, 48));
    expect(checkActivation(cur, cand, 48).reasons).toEqual(['candidate_cannot_read_schema']);
    // Contract: read-only rollback, checkpoint; incompatible: none.
    expect(checkMigratingActivation(cur, cand, 48, m(48, 49, ['0048_c']))).toMatchObject({
      ok: true,
      requiresCheckpoint: true,
      rollbackAccess: 'read-only',
    });
    expect(checkMigratingActivation(cur, cand, 48, m(49, 49))).toMatchObject({
      requiresCheckpoint: true,
      rollbackAccess: 'none',
    });
    // An expand the runtime still names (it never does, but its word wins): checkpoint, rollback read-write.
    expect(checkMigratingActivation(cur, cand, 48, m(48, 48, ['0048_x']))).toMatchObject({
      requiresCheckpoint: true,
      rollbackCompatible: true,
    });
    // The floors decide, even when the current tuple claims to read the target.
    const claims = { ...cur, runtime: { ...cur.runtime, schemaReads: { min: 48, max: 49 } } };
    expect(checkMigratingActivation(claims, cand, 48, m(48, 49)).rollbackAccess).toBe('read-only');
    expect(checkMigratingActivation(cur, cand, 48, { ...m(48, 48), target: 50 }).reasons).toEqual([
      'candidate_cannot_read_schema',
      'schema_target_mismatch',
    ]);
  });

  it('judges an exit-0 candidate by the live schema’s floors (CT-135, UP-B2)', () => {
    const at = (s: number, c: string): ReleaseTuple => ({
      ...tupleA,
      runtime: {
        ...tupleA.runtime,
        storePath: sp(c, 'whombat-runtime'),
        schemaReads: { min: s, max: s },
        schemaWrites: s,
      },
    });
    const s48 = at(48, 'a');
    const s49 = at(49, 'f');
    // The custody rollback after an expand: the older runtime reads and writes the newer database.
    expect(checkCompatibleActivation(s49, s48, 49, { readers: 47, writers: 48 })).toEqual({
      ok: true,
      requiresCheckpoint: false,
      rollbackCompatible: true,
      rollbackAccess: 'read-write',
      reasons: [],
    });
    // The tuple-only check refused it.
    expect(checkActivation(s49, s48, 49).reasons).toEqual([
      'candidate_cannot_read_schema',
      'schema_downgrade',
    ]);
    // After a contract: read-only, or nothing.
    expect(checkCompatibleActivation(s49, s48, 49, { readers: 48, writers: 49 }).reasons).toEqual([
      'candidate_read_only',
    ]);
    expect(checkCompatibleActivation(s49, s48, 49, { readers: 49, writers: 49 }).reasons).toEqual([
      'candidate_cannot_read_schema',
    ]);
    // The current schema: the same answer as checkActivation.
    expect(checkCompatibleActivation(s48, s48, 48, { readers: 47, writers: 48 })).toEqual(
      checkActivation(s48, s48, 48),
    );
    // A candidate at or above the live schema still needs to read it; rollback access follows the floors.
    expect(checkCompatibleActivation(tupleA, tupleB, 14, { readers: 13, writers: 14 })).toMatchObject({
      ok: true,
      rollbackAccess: 'none',
      requiresCheckpoint: false,
    });
    expect(checkCompatibleActivation(tupleA, tupleB, 11, { readers: 10, writers: 11 }).reasons).toEqual([
      'candidate_cannot_read_schema',
    ]);
  });

  it('orders one release id family by date and build, whatever the prefix (4.4)', () => {
    // A box moves from the development channel to production without going back, and back again.
    expect(compareVersions('whombat-dev-20261118.3', 'whombat-20261119.1')).toBe(-1);
    expect(compareVersions('whombat-20261118.3', 'whombat-dev-20261119.1')).toBe(-1);
    expect(compareVersions('whombat-20261118.2', 'whombat-dev-20261118.10')).toBe(-1);
    expect(compareVersions('whombat-dev-20261118.10', 'whombat-20261118.2')).toBe(1);
    expect(compareVersions('whombat-dev-20261118.4', 'whombat-20261118.4')).toBe(0);
    expect(compareVersions('whombat-20261118.9', 'whombat-20261118.10')).toBe(-1);
    // Anything outside the family keeps the old order: before 4.4 every whombat- id sorted before every whombat-dev- id.
    expect(compareVersions('whombat-20261119.1-rc', 'whombat-dev-20261118.1')).toBe(-1);
    expect(compareVersions('pve-dev-20261021.9', 'whombat-dev-20261020.1')).toBe(-1);
    expect(compareVersions('pve-20261021.9', 'whombat-20261020.1')).toBe(-1);
  });

  it('orders versions like the helper (CT-135, UP-A2)', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
    expect(compareVersions('pve-20260928.6', 'pve-20260928.10')).toBe(-1);
    expect(compareVersions('pve-dev-20260928.10', 'pve-dev-20260929.1')).toBe(-1);
    // The trap: the old runtime versions' hex compares as text.
    expect(compareVersions('0.1.0-e847497', '0.1.0-195421a')).toBe(1);
    const published = [
      '0.1.0-a2abeeb.p26a328c',
      '0.1.0-843d1ba',
      '0.1.0-2be6fc1',
      '0.1.0-e847497',
      '0.1.0-195421a',
      '0.1.0',
      '0.0.48-2be6fc1',
    ];
    for (const next of ['0.2.0-20260928190000.abcdef1', '0.2.0-dev'])
      for (const old of published) {
        expect(compareVersions(old, next), `${old} < ${next}`).toBe(-1);
        expect(compareVersions(next, old), `${next} > ${old}`).toBe(1);
      }
    expect(compareVersions('0.2.0-20260928190000.aaaaaaa', '0.2.0-20260928190001.0000000')).toBe(-1);
    expect(compareVersions('0.2.0-20260928190000.abcdef1.p26a328c', '0.2.0-20260928190000.abcdef1')).toBe(1);
    // Segments beyond 64 bits are text in Go (ParseUint fails), so here too.
    expect(compareVersions('1.99999999999999999999', '1.a')).toBe(-1);
    expect(compareVersions('1.18446744073709551616', '1.18446744073709551615')).toBe(1);
  });

  it('describes update failures in plain words (CT-137)', () => {
    const incident = UpdateFailureDetail.parse({
      stage: 'Staged',
      code: 'schema_incompatible',
      reasons: ['candidate_cannot_read_schema'],
      release: 'pve-20260928.5',
      schema: { database: 48, target: null, candidateWrites: 49, candidateReads: { min: 49, max: 49 } },
      failedChecks: [],
      at: 1_790_000_000,
    });
    expect(describeUpdateFailure(incident)).toBe(
      'pve-20260928.5 couldn’t start on this Whombat’s database: it reads schema 49 only and the database is at 48. Nothing was changed.',
    );
    const base = { ...incident, schema: undefined, reasons: [] };
    expect(
      describeUpdateFailure({
        ...base,
        code: 'unhealthy',
        stage: 'Verifying',
        failedChecks: ['database', 'runner'],
      }),
    ).toBe(
      'pve-20260928.5 started but failed its health checks (the database and the agent runner). This Whombat went back to the release it ran before.',
    );
    expect(describeUpdateFailure({ ...base, code: 'helper_verification_failed', stage: 'Downloading' })).toBe(
      'pve-20260928.5 didn’t pass signature verification, so it wasn’t installed. Nothing was changed.',
    );
    expect(describeUpdateFailure({ ...base, code: 'something_new', stage: 'Staged' })).toBe(
      'pve-20260928.5 couldn’t be installed (something_new). Nothing was changed.',
    );
    expect(describeUpdateFailure({ ...base, code: 'something_new', stage: 'Verifying' })).toBe(
      'pve-20260928.5 couldn’t be installed (something_new). This Whombat went back to the release it ran before.',
    );
    // Every known code and reason gives one or two sentences with the release in it.
    const codes = [
      'schema_incompatible',
      'unhealthy',
      'boot_fallback',
      'reboot_timeout',
      'manager_recovery',
      'download_corrupt',
      'verification_failed',
      'no_space',
      'incompatible',
      'downgrade',
      'not_assigned',
      'not_staged',
      'activation_failed',
      'activation_deferred',
      'boundary_lost',
      'checkpoint_required',
      'checkpoint_stale',
      'checkpoint_failed',
      'migrate_failed',
      'forward_repair_required',
    ];
    const reasons = [
      'candidate_cannot_read_schema',
      'candidate_read_only',
      'schema_downgrade',
      'schema_target_mismatch',
      'host_abi_unsupported',
      'protocol_no_overlap',
    ];
    for (const code of codes)
      for (const reason of reasons)
        for (const schema of [
          undefined,
          incident.schema,
          { ...incident.schema, target: 50 } as typeof incident.schema,
        ]) {
          const text = describeUpdateFailure({ ...incident, code, reasons: [reason], schema });
          expect(text, `${code} ${reason}`).toContain('pve-20260928.5');
          expect(text, `${code} ${reason}`).not.toMatch(/undefined|null|NaN|\(\)/);
          expect(text.split(/[.!] /).length, text).toBeLessThanOrEqual(2);
        }
  });

  it('matches protocol majors', () => {
    expect(servesClient(tupleA, { major: 1, minor: 4 })).toBe(true);
    expect(servesClient(tupleA, { major: 2, minor: 0 })).toBe(false);
    expect(protocolOverlap({ min: 1000, max: 2001 }, { min: 2000, max: 2003 })).toBe(true);
    expect(protocolOverlap({ min: 1000, max: 1009 }, { min: 2000, max: 2003 })).toBe(false);
  });

  it('digests tuples canonically', () => {
    expect(tupleDigest(tupleA)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(tupleDigest({ ...tupleA })).toBe(tupleDigest(tupleA));
    expect(tupleDigest(tupleB)).not.toBe(tupleDigest(tupleA));
  });
});

describe('update journal', () => {
  it('follows MA-11', () => {
    const path: UpdateJournalState[] = [
      'Assigned',
      'Downloading',
      'Verified',
      'Staged',
      'WaitingForSafeBoundary',
      'Activating',
      'Verifying',
      'Healthy',
    ];
    for (let i = 0; i + 1 < path.length; i++)
      expect(canTransition(path[i] as UpdateJournalState, path[i + 1] as UpdateJournalState)).toBe(true);
    expect(canTransition('Verifying', 'RolledBack')).toBe(true);
    expect(canTransition('Healthy', 'Activating')).toBe(false);
    expect(canTransition('Activating', 'Assigned')).toBe(false);
    expect(Object.keys(UPDATE_JOURNAL_TRANSITIONS).sort()).toEqual([...UpdateJournalState.options].sort());
  });
});

describe('signed assignments', () => {
  const key = deriveSeedKeypair('assignment-key');
  const now = 1_790_000_000;
  const payload: AssignmentPayload = {
    purpose: 'whombat-update-assignment/v1',
    env: 'dev',
    device: 'dev_1',
    sequence: 7,
    action: 'install',
    releaseId: tupleB.releaseId,
    tupleDigest: tupleDigest(tupleB),
    rolloutId: 'ro_1',
    cohort: 'pilot',
    issuedAt: now,
    notBefore: now,
    expiresAt: now + 86_400,
  };
  const ctx = { keys: { 'asg-1': key.publicKey }, env: 'dev', device: 'dev_1', now, lastSequence: 6 };

  it('verifies and refuses', () => {
    const doc = signDocument(payload, 'asg-1', key.secretKey);
    expect(verifyAssignment(doc, ctx).ok).toBe(true);
    expect(verifyAssignment(doc, { ...ctx, lastSequence: 7 })).toEqual({ ok: false, error: 'replayed' });
    expect(verifyAssignment(doc, { ...ctx, device: 'dev_2' })).toEqual({ ok: false, error: 'wrong_device' });
    expect(verifyAssignment(doc, { ...ctx, env: 'prod' })).toEqual({ ok: false, error: 'wrong_env' });
    expect(verifyAssignment(doc, { ...ctx, now: now + 86_400 + 300 })).toEqual({
      ok: false,
      error: 'expired',
    });
    expect(verifyAssignment({ ...doc, keyId: 'asg-2' }, ctx)).toEqual({ ok: false, error: 'unknown_key' });
    expect(verifyAssignment({ ...doc, payload: { ...payload, sequence: 8 } }, ctx)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
    const hold = signDocument({ ...payload, action: 'hold' }, 'asg-1', key.secretKey);
    expect(verifyAssignment(hold, ctx)).toEqual({ ok: false, error: 'bad_action' });
    const holdOk = signDocument(
      { ...payload, action: 'hold', releaseId: null, tupleDigest: null },
      'asg-1',
      key.secretKey,
    );
    expect(verifyAssignment(holdOk, ctx).ok).toBe(true);
  });
});
