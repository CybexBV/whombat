/**
 * The passkey backup key's pure parts (backup-passkey.md): what makes the box lock again, where bringing it back
 * stands, how pushes are split, and the Inbox's one ask.
 */
import { BACKUP_PASSKEY_HREF, isBackupPasskeyHref } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import {
  bringBackFrom,
  lockDigest,
  nasDigest,
  pushBatches,
  relockDue,
  reportOf,
  secretsDigest,
  somethingWaits,
} from './backup-key';
import { backupPasskeyItem } from './backup-key-inbox';

const material = {
  kind: 'whombat.backup-recovery-material/1' as const,
  applianceId: 'wb-home',
  generation: 3,
  createdAt: '2026-11-04T10:00:00Z',
  repository: 'rest:http://192.168.1.40:8747/home-3fkq/',
  restUser: 'home-3fkq',
  restPassword: 'rest-secret',
  repositoryPassword: 'repo-secret',
  repositoryId: 'repo-1',
  manifestKey: 'ed25519:abc',
  head: { seq: 7, manifestSha256: 'a'.repeat(64), at: '2026-11-04T09:00:00Z' },
};

describe('what makes the box lock again', () => {
  it('a new head locks again, a new read of the same details doesn’t', () => {
    expect(lockDigest({ ...material, createdAt: '2026-11-05T10:00:00Z' })).toBe(lockDigest(material));
    expect(lockDigest({ ...material, head: { ...material.head, seq: 8 } })).not.toBe(lockDigest(material));
  });

  it('the copy next to the backups follows the details but not every backup', () => {
    expect(nasDigest({ ...material, head: { ...material.head, seq: 8 } })).toBe(nasDigest(material));
    expect(nasDigest({ ...material, generation: 4 })).not.toBe(nasDigest(material));
    expect(nasDigest({ ...material, repository: 'rest:http://192.168.1.41:8747/home-3fkq/' })).not.toBe(
      nasDigest(material),
    );
  });

  it('a paper copy stays good when the place moves, not when a password changes', () => {
    const moved = { ...material, generation: 4, repository: 'rest:http://192.168.1.41:8747/home-3fkq/' };
    expect(secretsDigest(moved)).toBe(secretsDigest(material));
    expect(secretsDigest({ ...material, restPassword: 'new' })).not.toBe(secretsDigest(material));
    expect(secretsDigest({ ...material, manifestKey: 'ed25519:new' })).not.toBe(secretsDigest(material));
  });

  it('the job locks at once, after the report changes, and when the retry is due', () => {
    const status = {
      destination: { configured: true, repositoryId: 'repo-1' },
      kitGeneration: 3,
      lastSuccess: { id: 'ck-1' },
    } as Parameters<typeof reportOf>[0];
    const report = reportOf(status);
    const next = reportOf({ ...status, lastSuccess: { id: 'ck-2' } } as Parameters<typeof reportOf>[0]);
    const base = { lastRun: 1_000, retryMs: 300_000 };
    expect(relockDue({ ...base, seen: undefined, report, now: 1_000 })).toBe(true);
    expect(relockDue({ ...base, seen: report, report, now: 61_000 })).toBe(false);
    expect(relockDue({ ...base, seen: report, report: next, now: 61_000 })).toBe(true);
    // The retry is due: only when something waits.
    expect(relockDue({ ...base, seen: report, report, now: 301_000, waits: true })).toBe(true);
    expect(relockDue({ ...base, seen: report, report, now: 301_000, waits: false })).toBe(false);
    expect(reportOf(null)).toBe(null);
  });

  it('something waits: an envelope control hasn’t kept, the old Whombat untold, or the copy next to the backups due', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    const kept = { envelope: 'wbkit1.a.b', storedAt: new Date(now - 60_000) };
    const fresh = {
      adoptedFrom: null,
      adoptedReportedAt: null,
      nasAt: new Date(now - 3_600_000),
      nasTriedAt: null,
    };
    expect(somethingWaits({ keys: [], state: null, now })).toBe(false);
    expect(somethingWaits({ keys: [kept], state: fresh, now })).toBe(false);
    expect(somethingWaits({ keys: [{ ...kept, storedAt: null }], state: fresh, now })).toBe(true);
    expect(somethingWaits({ keys: [kept], state: { ...fresh, adoptedFrom: 'wb-old' }, now })).toBe(true);
    // Brought back and nothing locked yet: the old Whombat still waits to be named.
    expect(somethingWaits({ keys: [], state: { ...fresh, adoptedFrom: 'wb-old' }, now })).toBe(true);
    expect(
      somethingWaits({ keys: [kept], state: { ...fresh, nasAt: new Date(now - 25 * 3_600_000) }, now }),
    ).toBe(true);
    const failed = { ...fresh, nasAt: null, nasTriedAt: new Date(now - 10 * 60_000) };
    expect(somethingWaits({ keys: [kept], state: failed, now })).toBe(false);
    expect(
      somethingWaits({ keys: [kept], state: { ...failed, nasTriedAt: new Date(now - 2 * 3_600_000) }, now }),
    ).toBe(true);
  });
});

describe('where bringing it back stands', () => {
  const status = { destination: { configured: true, kind: 'rest' }, kitGeneration: 3 } as Parameters<
    typeof bringBackFrom
  >[0]['status'];
  const at = new Date('2026-11-04T10:00:00Z');
  const state = { detailsDigest: 'd1', paperDigest: null, paperAt: null, nasAt: at };

  it('ready once a passkey locked the current generation and control kept it', () => {
    expect(bringBackFrom({ status, keys: [{ generation: 3, storedAt: at }], state })).toEqual({
      state: 'ready',
      setup: 'verify',
      verifiedAt: null,
      passkeys: 1,
      lockedAt: at.toISOString(),
      nasCopyAt: at.toISOString(),
      paperAt: null,
    });
  });

  it('needs a passkey with none, an older generation, or one control hasn’t kept', () => {
    for (const keys of [[], [{ generation: 2, storedAt: at }], [{ generation: 3, storedAt: null }]])
      expect(bringBackFrom({ status, keys, state }).state).toBe('needs_passkey');
  });

  it('paper only with a paper copy of the current details', () => {
    const paper = { ...state, paperDigest: 'd1', paperAt: at };
    expect(bringBackFrom({ status, keys: [], state: paper })).toMatchObject({
      state: 'paper_only',
      paperAt: at.toISOString(),
    });
    expect(bringBackFrom({ status, keys: [], state: { ...paper, detailsDigest: 'd2' } })).toMatchObject({
      state: 'needs_passkey',
      paperAt: null,
    });
  });

  it('none without backups a new Whombat could open', () => {
    expect(bringBackFrom({ status: null, keys: [], state: null }).state).toBe('none');
    const own = { destination: { configured: true, kind: 'local' }, kitGeneration: 1 } as typeof status;
    expect(bringBackFrom({ status: own, keys: [{ generation: 1, storedAt: at }], state }).state).toBe('none');
  });
});

describe('pushes', () => {
  it('split so each fits a device request, at most 20 envelopes each', () => {
    const big = Array.from({ length: 5 }, (_, i) => ({ id: i, envelope: 'x'.repeat(15_000) }));
    expect(pushBatches(big).map((b) => b.length)).toEqual([2, 2, 1]);
    const small = Array.from({ length: 25 }, (_, i) => ({ id: i, envelope: 'x'.repeat(100) }));
    expect(pushBatches(small).map((b) => b.length)).toEqual([20, 5]);
    expect(pushBatches([])).toEqual([]);
  });
});

describe('the Inbox’s ask', () => {
  it('one calm item whose button is “Touch my passkey” on the backups', () => {
    const item = backupPasskeyItem('2026-11-04T10:00:00.000Z');
    expect(item).toMatchObject({ kind: 'backup', severity: 'info', ref: { kind: 'backup', id: 'passkey' } });
    expect(item.actions).toHaveLength(1);
    expect(item.actions[0]).toMatchObject({ kind: 'open', style: 'primary', href: BACKUP_PASSKEY_HREF });
    expect(isBackupPasskeyHref(item.actions[0]?.href)).toBe(true);
    expect(isBackupPasskeyHref('/settings?tab=appliance&section=backups')).toBe(false);
  });
});
