/** The phone's backup options, kit and bringing back (backup-options-android.md AP-6850…AP-6864): facts, not copy. */
import { BACKUP_OPTIONS_TEXT, kitFromScan } from '@whombat/client/managed';
import {
  BACKUP_KEEP_90_DAYS,
  BACKUP_KEEP_YEAR,
  BACKUP_POLICY_DEFAULT,
  type BackupCheckpoint,
  type BackupRestoreState,
} from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import {
  backupTitle,
  bringBackResume,
  chooseRows,
  defaultCheckpoint,
  draftInput,
  initialKitWays,
  kitPasskeyIds,
  kitPrimary,
  kitPrintHtml,
  kitWhombatName,
  policyDraft,
  qrSvg,
  restoreScreen,
} from './backupOptions';

const now = new Date(2026, 10, 3, 17, 0);

const cp = (id: string, createdAt: Date, over: Partial<BackupCheckpoint> = {}): BackupCheckpoint => ({
  id,
  seq: 1,
  snapshotId: `s${id}`,
  createdAt: createdAt.toISOString(),
  reason: 'scheduled',
  schemaVersion: 1,
  bytes: 1e9,
  bytesAdded: 1e6,
  applianceId: 'old',
  own: false,
  check: null,
  ...over,
});

describe('the options draft (AP-6853)', () => {
  it('round-trips the recommended policy', () => {
    const draft = policyDraft(BACKUP_POLICY_DEFAULT);
    expect(draft).toMatchObject({ frequency: '6h', keep: 'year', limitOn: false, weeklyCheck: true });
    expect(draftInput(draft)).toEqual({
      input: { frequency: '6h', keep: BACKUP_KEEP_YEAR, limitBytes: null, weeklyCheck: true },
    });
  });

  it('reads 90 days, custom fields and the GB limit', () => {
    const base = policyDraft(BACKUP_POLICY_DEFAULT);
    expect(draftInput({ ...base, keep: 'days90' })).toMatchObject({ input: { keep: BACKUP_KEEP_90_DAYS } });
    const custom = { allDays: '3', dailyDays: '10', weeklyWeeks: '4', monthlyMonths: '6' };
    expect(draftInput({ ...base, keep: 'custom', custom })).toMatchObject({
      input: { keep: { allDays: 3, dailyDays: 10, weeklyWeeks: 4, monthlyMonths: 6 } },
    });
    expect(draftInput({ ...base, limitOn: true, limitGb: '50' })).toMatchObject({
      input: { limitBytes: 50_000_000_000 },
    });
  });

  it('refuses a half-typed number, no days at all, and a limit under 1 GB', () => {
    const base = policyDraft(BACKUP_POLICY_DEFAULT);
    const custom = { allDays: '0', dailyDays: '1', weeklyWeeks: '', monthlyMonths: '1' };
    expect(draftInput({ ...base, keep: 'custom', custom })).toHaveProperty('error');
    expect(draftInput({ ...base, limitOn: true, limitGb: '0.5' })).toHaveProperty('error');
    expect(draftInput({ ...base, limitOn: true, limitGb: 'ten' })).toHaveProperty('error');
  });

  it('starts a policy with a limit at its GB', () => {
    expect(policyDraft({ ...BACKUP_POLICY_DEFAULT, limitBytes: 20e9 })).toMatchObject({
      limitOn: true,
      limitGb: '20',
    });
  });
});

describe('one backup and the list to bring back (AP-6856, AP-6862)', () => {
  it('names the day and time', () => {
    expect(backupTitle(new Date(2026, 10, 3, 3, 0).toISOString(), now)).toBe('Today, 03:00');
    expect(backupTitle(new Date(2026, 10, 2, 21, 0).toISOString(), now)).toBe('Yesterday, 21:00');
  });

  it('picks the newest, tags it, and says why or how long ago', () => {
    const list = [
      cp('a', new Date(2026, 10, 3, 3), { check: { at: now.toISOString(), ok: true } }),
      cp('b', new Date(2026, 10, 2, 18, 45), { reason: 'pre-migration', releaseId: 'whombat-0.198' }),
      cp('c', new Date(2026, 10, 1, 3)),
    ];
    expect(defaultCheckpoint(list)).toBe('a');
    expect(defaultCheckpoint([])).toBeNull();
    const rows = chooseRows(list, now);
    expect(rows.map((r) => r.newest)).toEqual([true, false, false]);
    expect(rows[0]?.meta).toContain('14 hours ago');
    expect(rows[0]?.meta).toContain('restores');
    expect(rows[1]?.meta).toContain('0.198');
  });
});

describe('the recovery kit (AP-6854…AP-6858)', () => {
  it('ticks the passkey only with PRF, print always, the file never', () => {
    expect(initialKitWays(true)).toEqual({ passkey: true, print: true, file: false });
    expect(initialKitWays(false)).toEqual({ passkey: false, print: true, file: false });
    expect(kitPrimary({ passkey: true, print: true, file: false })).toBe(BACKUP_OPTIONS_TEXT.kit.usePasskey);
    expect(kitPrimary({ passkey: false, print: false, file: true })).toBe(BACKUP_OPTIONS_TEXT.dialog.save);
    expect(kitPrimary({ passkey: false, print: false, file: false })).toBeNull();
  });

  it('uses only this Whombat’s passkeys', () => {
    const passkeys = [
      { id: 'k1', appliance: 'peerA' },
      { id: 'k2', appliance: 'peerB' },
      { id: 'k3', appliance: null },
    ];
    expect(kitPasskeyIds(passkeys, 'peerA')).toEqual(['k1']);
  });

  it('prints the kit with a QR code whose payload a new Whombat reads back', () => {
    const material = JSON.stringify({ repositoryPassword: 'x'.repeat(40) });
    const html = kitPrintHtml({ name: 'Home <1>', kitText: `kit\n${material}`, qrPayload: 'wbkit-qr1:{}' });
    expect(html).toContain('<svg');
    expect(html).toContain('Home &lt;1&gt;');
    expect(html).not.toContain('Home <1>');
    expect(kitPrintHtml({ name: 'Home', kitText: 'k', qrPayload: null })).not.toContain('<svg');
    expect(qrSvg('hello')).toMatch(/^<svg[^>]+viewBox="0 0 \d+ \d+"/);
    expect(kitFromScan('not a kit')).toBeNull();
  });
});

describe('bringing a Whombat back (AP-6860…AP-6863)', () => {
  const state = (phase: BackupRestoreState['phase']): BackupRestoreState => ({
    phase,
    stage: null,
    since: null,
    error: null,
    restored: null,
    oldApplianceId: null,
    relogin: [],
    servers: null,
    items: [],
  });

  it('shows the screen for each phase', () => {
    expect(restoreScreen(null)).toBe('working');
    expect(restoreScreen(state('restoring'))).toBe('working');
    expect(restoreScreen(state('none'))).toBe('working');
    expect(restoreScreen(state('checking'))).toBe('almost');
    expect(restoreScreen(state('failed'))).toBe('failed');
    expect(restoreScreen(state('released'))).toBe('done');
  });

  it('resumes where a restore stands; from the app only one that still waits', () => {
    expect(bringBackResume(null, false)).toBeNull();
    expect(bringBackResume(state('restoring'), true)).toBe('working');
    expect(bringBackResume(state('checking'), true)).toBe('almost');
    expect(bringBackResume(state('failed'), true)).toBe('failed');
    expect(bringBackResume(state('released'), false)).toBe('done');
    expect(bringBackResume(state('released'), true)).toBeNull();
  });

  it('prints the paper copy with its own words', () => {
    const html = kitPrintHtml({
      name: 'Home',
      kitText: 'k',
      qrPayload: null,
      words: BACKUP_OPTIONS_TEXT.paper,
    });
    expect(html).toContain(BACKUP_OPTIONS_TEXT.paper.printTitle('Home'));
    expect(html).not.toContain(BACKUP_OPTIONS_TEXT.kit.printTitle('Home'));
  });
});

describe('a kit’s Whombat (AP-6860)', () => {
  it('reads the name a kit file names', () => {
    expect(kitWhombatName('Kit version: 3\nWhombat: Home\nAppliance: wb-1')).toBe('Home');
    expect(kitWhombatName('{"repositoryPassword":"x"}')).toBeNull();
  });
});
