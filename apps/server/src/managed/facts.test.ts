import { BackupServiceStatus, UpdateFacts } from '@whombat/control-contracts/local';
import { describe, expect, it } from 'vitest';
import { acceptFactsPush } from './facts';

const BACKUP = BackupServiceStatus.parse({
  kind: 'whombat.backup-status/1',
  state: 'protected',
  protected: true,
  destination: { configured: true, kind: 'rest', display: 'backup.example.com', appendOnly: 'verified' },
  lastSuccess: null,
  lastFailure: null,
  lastAttemptOk: true,
  coverage: [],
  recoverability: { lastDrill: null },
  kitGeneration: 1,
  running: null,
  updatedAt: '2026-09-28T19:00:00Z',
});

const UPDATE = UpdateFacts.parse({
  state: 'Healthy',
  current: 'pve-20260928.6',
  candidate: null,
  lastCheckedAt: '2026-09-28T19:00:00Z',
  deferredReason: null,
  failure: null,
  clientFloor: { web: 120, android: 0, ios: 0, desktop: 0, cli: 0 },
});

const previous = { backup: BACKUP, update: UPDATE };

describe('a newer manager’s facts push (MD-19)', () => {
  it('takes a push this runtime understands as it is', () => {
    const push = acceptFactsPush(previous, { v: 1, backup: null, update: { ...UPDATE, state: 'Staged' } });
    expect(push).toMatchObject({
      ok: true,
      backup: null,
      update: { state: 'Staged' },
      skipped: [],
      kept: [],
    });
    expect(push.ok && push.clientFloor).toEqual(UPDATE.clientFloor);
  });

  it('leaves out a new top-level member and what it doesn’t know under update', () => {
    const push = acceptFactsPush(previous, {
      v: 1,
      backup: BACKUP,
      update: {
        ...UPDATE,
        state: 'WaitingForSafeBoundary',
        waiting: { reason: 'solar_eclipse', since: '2026-09-28T19:00:00Z', blockers: [] },
      },
      maintenanceWindow: { from: '02:00', to: '04:00' },
    });
    if (!push.ok) throw push.error;
    expect(push.update).toMatchObject({ state: 'WaitingForSafeBoundary' });
    expect(push.update).not.toHaveProperty('waiting');
    expect(push.backup).toEqual(BACKUP);
    expect(push.skipped).toEqual([{ path: ['update', 'waiting'], value: 'solar_eclipse', action: 'unset' }]);
    expect(push.kept).toEqual([]);
  });

  it('keeps the backup facts it had when a repair touches backup: an unknown state never reads as unprotected', () => {
    const push = acceptFactsPush(previous, {
      v: 1,
      backup: { ...BACKUP, state: 'replicating' },
      update: UPDATE,
    });
    if (!push.ok) throw push.error;
    expect(push.backup).toEqual(BACKUP);
    expect(push.kept).toEqual(['backup']);
    expect(push.skipped[0]).toMatchObject({ path: ['backup'], value: 'replicating', action: 'nulled' });
    // Also for a repair deeper in it, and with nothing kept before.
    const deeper = acceptFactsPush(
      { backup: null, update: null },
      {
        v: 1,
        backup: {
          ...BACKUP,
          lastFailure: { id: 'f1', at: BACKUP.updatedAt, stage: 'teleport', reason: 'x' },
        },
        update: null,
      },
    );
    expect(deeper).toMatchObject({ ok: true, backup: null, kept: ['backup'] });
  });

  it('keeps the update facts and the client floor it had when update.state is unknown', () => {
    const push = acceptFactsPush(previous, {
      v: 1,
      backup: BACKUP,
      update: {
        ...UPDATE,
        state: 'Hibernating',
        clientFloor: { web: 0, android: 0, ios: 0, desktop: 0, cli: 0 },
      },
    });
    if (!push.ok) throw push.error;
    expect(push.update).toEqual(UPDATE);
    expect(push.clientFloor).toBeUndefined();
    expect(push.kept).toEqual(['update', 'clientFloor']);
    expect(push.backup).toEqual(BACKUP);
  });

  it('still refuses what isn’t a newer manager’s facts', () => {
    expect(acceptFactsPush(previous, { v: 1, backup: 'nope', update: null }).ok).toBe(false);
    expect(acceptFactsPush(previous, { v: 1, backup: null }).ok).toBe(false);
    expect(acceptFactsPush(previous, { v: 1, backup: null, update: { ...UPDATE, current: '' } }).ok).toBe(
      false,
    );
  });
});
