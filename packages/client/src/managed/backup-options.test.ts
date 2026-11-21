import {
  BACKUP_KEEP_90_DAYS,
  BACKUP_KEEP_YEAR,
  type BackupCheckpoint,
  type BackupServiceStatus,
} from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import {
  andList,
  BACKUP_OPTIONS_TEXT,
  backupGroups,
  backupHero,
  estimateBytes,
  keepChoice,
  keepSpan,
  kitFromScan,
  kitQrPayload,
  nextBackupAt,
  reloginNames,
  restoreSteps,
} from './index';

const cp = (over: Partial<BackupCheckpoint> & { createdAt: string; id: string }): BackupCheckpoint => ({
  seq: 1,
  snapshotId: 's',
  reason: 'scheduled',
  schemaVersion: 1,
  bytes: 3_600_000_000,
  bytesAdded: 41_000_000,
  applianceId: 'wb-home',
  own: true,
  check: null,
  ...over,
});

describe('backup options', () => {
  const now = new Date(2026, 10, 4, 17, 0);
  const list = {
    checkpoints: [
      cp({ id: 'a', createdAt: new Date(2026, 10, 4, 15, 0).toISOString() }),
      cp({ id: 'b', createdAt: new Date(2026, 10, 4, 3, 0).toISOString(), check: { at: 'x', ok: true } }),
      cp({
        id: 'c',
        createdAt: new Date(2026, 10, 3, 18, 45).toISOString(),
        reason: 'pre-migration',
        releaseId: 'candidate-0.198.3',
      }),
      cp({ id: 'd', createdAt: new Date(2026, 10, 3, 17, 52).toISOString(), bytesAdded: 3_600_000_000 }),
      cp({ id: 'e', createdAt: new Date(2026, 9, 25, 3, 0).toISOString(), own: false }),
    ],
    unauthentic: 0,
    local: null,
    space: { usedBytes: 6_200_000_000, freeBytes: 1_900_000_000_000 },
  };

  it('groups by day with why each backup exists', () => {
    const groups = backupGroups(list, BACKUP_KEEP_YEAR, { now });
    expect(groups.map((g) => g.key)).toEqual(['today', 'yesterday', 'later']);
    expect(groups[0]?.rows.map((r) => r.time)).toEqual(['15:00', '03:00']);
    expect(groups[0]?.rows[1]?.check).toBe('ok');
    expect(groups[1]?.rows.map((r) => r.label)).toEqual([
      'Before the update to 0.198.3',
      BACKUP_OPTIONS_TEXT.list.first,
    ]);
    expect(groups[0]?.rows[0]?.size).toMatch(/^\+41\sMB$/u);
    expect(groups[2]?.note).toContain('one a day for 2 weeks');
    expect(groups[2]?.note).toContain('one a week for 2 months');
  });

  it('the top card names the place, the next backup and how far back', () => {
    const hero = backupHero({
      status: null,
      policy: {
        v: 1,
        frequency: '6h',
        timeZone: 'UTC',
        keep: BACKUP_KEEP_YEAR,
        limitBytes: null,
        weeklyCheck: true,
      },
      list,
      placeName: 'BlackBox',
      now,
    });
    expect(hero.title).toBe(BACKUP_OPTIONS_TEXT.notYet);
    expect(hero.sub).toContain('On BlackBox');
    expect(hero.sub).toContain('25 October');
    expect(hero.chips.map((c) => c.text)).toContain('Every 6 hours');
    expect(hero.chips.map((c) => c.text)).toContain('Kept up to a year');
  });

  it('the top card says backups are failing, why and when the last one finished, never a calm “Backed up”', () => {
    const status = (over: Partial<BackupServiceStatus>): BackupServiceStatus =>
      ({
        kind: 'whombat.backup-status/1',
        state: 'protected',
        protected: true,
        destination: { configured: true, display: 'blackbox' },
        lastSuccess: { at: new Date(now.getTime() - 3 * 86_400_000).toISOString() },
        lastFailure: null,
        lastAttemptOk: true,
        coverage: [],
        recoverability: { lastDrill: null },
        kitGeneration: 2,
        running: null,
        updatedAt: now.toISOString(),
        ...over,
      }) as BackupServiceStatus;
    const hero = (s: BackupServiceStatus) =>
      backupHero({ status: s, policy: null, list, placeName: null, now });
    const calm = hero(status({}));
    expect(calm).toMatchObject({ tone: 'ok', problem: null });
    const failure = {
      id: 'f1',
      at: now.toISOString(),
      stage: 'upload' as const,
      reason: "The destination didn't answer",
    };
    const failing = hero(status({ state: 'failing', lastAttemptOk: false, lastFailure: failure }));
    expect(failing.title).toBe(BACKUP_OPTIONS_TEXT.failing);
    expect(failing.tone).toBe('bad');
    expect(failing.problem).toContain("The destination didn't answer.");
    // When, in `ago`'s words (it reads the real clock).
    expect(failing.problem).toMatch(/The last one finished .+\.$/);
    const never = hero(status({ state: 'failing', lastSuccess: null, lastFailure: failure }));
    expect(never.problem).toContain(BACKUP_OPTIONS_TEXT.noneFinished);
  });

  it('the next backup is on a slot in the person’s zone', () => {
    const at = nextBackupAt({ frequency: '6h', timeZone: 'UTC' }, new Date(Date.UTC(2026, 10, 4, 10, 7)));
    expect(at.toISOString()).toBe('2026-11-04T15:00:00.000Z');
    const night = nextBackupAt(
      { frequency: 'nightly', timeZone: 'UTC' },
      new Date(Date.UTC(2026, 10, 4, 10, 7)),
    );
    expect(night.toISOString()).toBe('2026-11-05T03:00:00.000Z');
  });

  it('keep words and choices', () => {
    expect(keepSpan(BACKUP_KEEP_YEAR)).toBe('up to a year');
    expect(keepSpan(BACKUP_KEEP_90_DAYS)).toBe('90 days');
    expect(keepChoice({ allDays: 3, dailyDays: 0, weeklyWeeks: 0, monthlyMonths: 0 })).toBe('custom');
  });

  it('estimates the space a policy takes', () => {
    const est = estimateBytes(list, BACKUP_KEEP_YEAR);
    expect(est).toBeGreaterThan(3_600_000_000);
    expect(
      estimateBytes({ ...list, checkpoints: list.checkpoints.slice(0, 1) }, BACKUP_KEEP_YEAR),
    ).toBeNull();
  });

  it('restore steps follow the stage', () => {
    expect(restoreSteps(null, false, 'BlackBox').map((s) => s.state)).toEqual([
      'done',
      'running',
      'queued',
      'queued',
    ]);
    const checking = {
      phase: 'checking' as const,
      stage: null,
      since: null,
      error: null,
      restored: null,
      oldApplianceId: null,
      relogin: [],
      servers: null,
      items: [],
    };
    expect(restoreSteps(checking, true, null).every((s) => s.state === 'done')).toBe(true);
  });

  it('names sign-ins plainly', () => {
    expect(andList(reloginNames(['acc/claude', 'acc/github', 'x/claude']))).toBe('Claude and GitHub');
  });

  it('reads a printed kit’s QR code back', () => {
    const material = {
      kind: 'whombat.backup-recovery-material/1',
      applianceId: 'wb-home',
      generation: 2,
      createdAt: '2026-11-03T17:52:00Z',
      repository: 'rest:http://10.100.1.20:8747/wb-home/',
      restUser: 'wb-home',
      restPassword: 'p',
      repositoryPassword: 'r',
      repositoryId: 'abc',
      manifestKey: 'ed25519:AAAA',
    };
    const text = `WHOMBAT RECOVERY KIT\nBackup section for whombat-backup (save the next line as kit.json):\n${JSON.stringify(material)}\n`;
    const qr = kitQrPayload(text);
    expect(qr?.startsWith('wbkit-qr1:')).toBe(true);
    expect(kitFromScan(qr ?? '')).toContain('repositoryPassword');
    expect(kitFromScan('hello')).toBeNull();
  });
});
