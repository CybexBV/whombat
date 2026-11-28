/** Backups in the demo world (backup-options-android.md AP-6864): the box's answers, through a real session. */
import { backupGroups, backupHero } from '@whombat/client/managed';
import { sessionOps } from '@whombat/client/session';
import { describe, expect, it } from 'vitest';
import { createDemoBackups, demoCheckpoints } from './backupOptions';

const now = new Date(2026, 10, 3, 17, 0);

describe('the demo’s backups', () => {
  it('has 23 backups on BlackBox, newest first, one checked', () => {
    const list = demoCheckpoints(now);
    expect(list).toHaveLength(23);
    expect([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((c) => c.id)).toEqual(
      list.map((c) => c.id),
    );
    expect(list.filter((c) => c.check?.ok)).toHaveLength(1);
    expect(list.every((c) => Date.parse(c.createdAt) < now.getTime())).toBe(true);
  });

  it('answers the ops through a session, and the shared views read them', async () => {
    const demo = createDemoBackups(() => now);
    const session = demo.session();
    const [list, policy, status] = await Promise.all([
      sessionOps.backupCheckpoints(session),
      sessionOps.backupPolicy(session),
      sessionOps.backupStatus(session),
    ]);
    expect(list.space).toEqual({ usedBytes: 6_200_000_000, freeBytes: 1_900_000_000_000 });
    expect(list.local?.count).toBe(14);
    expect(policy.policy.frequency).toBe('6h');
    const hero = backupHero({
      status: status.status,
      policy: policy.policy,
      list,
      placeName: 'BlackBox',
      now,
    });
    expect(hero.sub).toContain('BlackBox');
    expect(hero.chips.map((c) => c.text).join(' ')).toContain('1.9');
    const groups = backupGroups(list, policy.policy.keep, { now, limit: 9 });
    expect(groups.map((g) => g.key)).toEqual(['today', 'yesterday', 'later']);
    expect(groups.flatMap((g) => g.rows.map((r) => r.label))).toContain('Before the update to 0.198');
    session.close();
  });

  it('saves options, queues a check and clears the box’s own backups', async () => {
    const demo = createDemoBackups(() => now);
    const session = demo.session();
    const saved = await sessionOps.backupSetPolicy(session, {
      frequency: 'hourly',
      keep: { allDays: 7, dailyDays: 0, weeklyWeeks: 0, monthlyMonths: 0 },
      limitBytes: 20e9,
      weeklyCheck: false,
    });
    expect(saved.policy).toMatchObject({ frequency: 'hourly', limitBytes: 20e9, weeklyCheck: false });
    const first = (await sessionOps.backupCheckpoints(session)).checkpoints[0];
    expect(first?.check).toBeNull();
    await sessionOps.backupCheck(session, first?.id ?? '');
    expect((await sessionOps.backupCheckpoints(session)).checkpoints[0]?.check?.ok).toBe(true);
    expect(await sessionOps.backupMoveLocal(session)).toEqual({ copied: 14 });
    expect((await sessionOps.backupCheckpoints(session)).local).toBeNull();
    session.close();
  });
});

describe('the demo’s backups v2 (backup-v2.md)', () => {
  it('can be brought back, says what each backup covers, and one left something out', async () => {
    const demo = createDemoBackups(() => now);
    const session = demo.session();
    const [list, status] = await Promise.all([
      sessionOps.backupCheckpoints(session),
      sessionOps.backupStatus(session),
    ]);
    expect(status.summary.bringBack?.state).toBe('ready');
    expect(list.checkpoints.every((c) => c.covered?.includes('database'))).toBe(true);
    expect(list.checkpoints.filter((c) => c.incomplete)).toHaveLength(1);
    const hero = backupHero({
      status: status.status,
      summary: status.summary,
      policy: null,
      list,
      placeName: 'BlackBox',
      now,
    });
    expect(hero.wayBack).not.toBeNull();
    expect(hero.askPasskey).toBe(false);
    session.close();
  });

  it('says backed up just now after Back up now', async () => {
    const demo = createDemoBackups(() => now);
    const session = demo.session();
    await sessionOps.backupRunNow(session);
    const status = await sessionOps.backupStatus(session);
    expect(status.status?.lastSuccess?.ageSeconds).toBe(0);
    session.close();
  });

  it('keeps a copy somewhere else that can be changed and stopped', async () => {
    const demo = createDemoBackups(() => now);
    const session = demo.session();
    const status = await sessionOps.backupStatus(session);
    expect(status.summary.offsite).toMatchObject({ provider: 'b2', state: 'ok' });
    const hero = backupHero({
      status: status.status,
      summary: status.summary,
      policy: null,
      list: null,
      placeName: 'BlackBox',
      now,
    });
    expect(hero.offsite?.dot).toBe('ok');
    const set = await sessionOps.backupSetOffsite(session, {
      provider: 'hetzner',
      endpoint: 'fsn1.your-objectstorage.com',
      bucket: 'copy-of-blackbox',
      accessKeyId: 'KEYID',
      secretAccessKey: 'example',
    });
    expect(set.offsite).toMatchObject({ provider: 'hetzner', bucket: 'copy-of-blackbox', state: 'first' });
    expect(JSON.stringify(set)).not.toContain('example');
    expect((await sessionOps.backupRemoveOffsite(session)).offsite).toBeNull();
    expect((await sessionOps.backupStatus(session)).summary.offsite).toBeNull();
    session.close();
  });
});
