/**
 * Backups v2's shared words and views (app backup-v2.md AP-6880…): the top card's states and what it says beside them,
 * one rule for when the passkey is asked for, “What’s in it” from a backup's own coverage, Details, when “Bring back a
 * Whombat you had” is offered, and the paper copy's plain words. The facts, not the sentences.
 */
import type { BackupCheckpoint, BackupServiceStatus, BackupStatus } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import {
  ago,
  BACKUP_OPTIONS_TEXT,
  backupContents,
  backupDetailLines,
  backupFixText,
  backupGroups,
  backupHero,
  backupHeroState,
  backupPageShown,
  backupPasskeyAsked,
  backupToBringBack,
  bringBackLaterOffered,
  bringBackName,
  canBeBroughtBack,
  earlierPlacesLine,
  madeAfterReplaced,
  oldWhombatDoneLines,
  oldWhombatMeta,
  paperCopyText,
  plainLeftOut,
  BACKUP_OPTIONS_TEXT as T,
  THIS_WHOMBAT_TEXT,
  whombatOverview,
} from './index';

const now = new Date(2026, 10, 4, 17, 0);
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

const status = (over: Partial<BackupServiceStatus> = {}): BackupServiceStatus =>
  ({
    kind: 'whombat.backup-status/1',
    state: 'protected',
    protected: true,
    destination: { configured: true, display: '192.168.1.40:8747', appendOnly: 'verified' },
    lastSuccess: { at: hoursAgo(2) },
    lastFailure: null,
    lastAttemptOk: true,
    coverage: [],
    recoverability: { lastDrill: null },
    kitGeneration: 2,
    running: null,
    updatedAt: now.toISOString(),
    ...over,
  }) as BackupServiceStatus;

const bringBack = (state: NonNullable<BackupStatus['bringBack']>['state']) => ({
  bringBack: { state, passkeys: state === 'ready' ? 1 : 0, lockedAt: null, nasCopyAt: null, paperAt: null },
});

const hero = (over: Partial<Parameters<typeof backupHero>[0]> = {}) =>
  backupHero({ status: status(), policy: null, list: null, placeName: 'BlackBox', now, ...over });

const cp = (over: Partial<BackupCheckpoint> = {}): BackupCheckpoint => ({
  id: 'cp',
  seq: 1,
  snapshotId: 's',
  createdAt: hoursAgo(1),
  reason: 'scheduled',
  schemaVersion: 1,
  bytes: 1,
  bytesAdded: 1,
  applianceId: 'wb-home',
  own: true,
  check: null,
  ...over,
});

describe('the top card', () => {
  it('follows where the backups stand: running, failing, behind, just now, backed up, nothing yet', () => {
    expect(backupHeroState({ status: status(), running: true })).toBe('running');
    expect(
      backupHeroState({
        status: status({ running: { id: 'c', op: 'checkpoint', stage: 'upload', since: hoursAgo(0) } }),
      }),
    ).toBe('running');
    // A weekly check running is not a backup being made.
    expect(
      backupHeroState({
        status: status({ running: { id: 'd', op: 'drill', stage: 'restore', since: hoursAgo(0) } }),
      }),
    ).toBe('ok');
    expect(backupHeroState({ status: status({ state: 'failing' }) })).toBe('failing');
    expect(backupHeroState({ status: status({ state: 'stale' }) })).toBe('behind');
    expect(backupHeroState({ status: status(), justNow: true })).toBe('justNow');
    expect(backupHeroState({ status: status({ lastSuccess: null }) })).toBe('none');
  });

  it('says failing and behind plainly, with Ask to fix it and the tone and title of each', () => {
    const failing = hero({
      status: status({
        state: 'failing',
        lastFailure: { id: 'f', at: hoursAgo(1), stage: 'upload', reason: 'The NAS didn’t answer' },
      }),
    });
    expect(failing).toMatchObject({ title: T.failing, tone: 'bad', askFix: true });
    expect(failing.problem).toContain('The NAS didn’t answer.');
    const behind = hero({ status: status({ state: 'stale' }) });
    expect(behind).toMatchObject({ title: T.behind, tone: 'warn', askFix: true });
    expect(behind.problem).toMatch(/^The last one finished /);
    expect(hero({ running: true })).toMatchObject({ title: T.running, askFix: false });
    expect(hero({ justNow: true }).title).toBe(T.justNow);
    // The assistant is asked with what is wrong.
    expect(backupFixText(failing)).toContain(T.failing);
    expect(backupFixText(failing)).toContain('The NAS didn’t answer.');
  });

  it('says what the last backup left out, in the service’s words', () => {
    const reason = '1 attachment wasn’t on this Whombat any more';
    expect(hero({ summary: { incomplete: { reason } } }).leftOut).toBe(`${reason}.`);
    expect(hero().leftOut).toBeNull();
  });

  it('says it can be brought back, or asks for the passkey, one rule for both apps', () => {
    expect(hero({ summary: bringBack('ready') })).toMatchObject({
      wayBack: T.wayBack.ready,
      askPasskey: false,
    });
    expect(hero({ summary: bringBack('paper_only') })).toMatchObject({
      wayBack: T.wayBack.paper,
      askPasskey: false,
    });
    expect(hero({ summary: bringBack('needs_passkey') })).toMatchObject({ wayBack: null, askPasskey: true });
    expect(hero({ summary: bringBack('none') })).toMatchObject({ wayBack: null, askPasskey: false });
    // A Whombat from before the passkey doesn't say: nothing is asked.
    expect(backupPasskeyAsked({})).toBe(false);
    expect(backupPasskeyAsked(null)).toBe(false);
    expect(canBeBroughtBack({ state: 'paper_only' })).toBe(true);
    expect(canBeBroughtBack({ state: 'needs_passkey' })).toBe(false);
  });

  it('says the backup service isn’t answering, keeps what it knows and offers Ask to fix it', () => {
    const notice = 'Your Whombat’s backup service isn’t answering right now';
    // Nothing from the service: the shield can't tell, the title says when the Whombat last said a backup finished.
    const blind = hero({ status: null, notice, lastKnownAt: hoursAgo(3) });
    expect(blind).toMatchObject({
      state: 'unknown',
      title: T.backedUp(ago(hoursAgo(3))),
      tone: 'warn',
      askFix: true,
    });
    expect(blind.problem).toContain(notice);
    expect(blind.sub).toBe('On BlackBox');
    expect(hero({ status: null, notice }).title).toBe(T.unknown);
    // The service's last word stays the answer; the notice follows a failure's own reason.
    const known = hero({ notice });
    expect(known).toMatchObject({
      state: 'ok',
      title: T.backedUp(ago(hoursAgo(2))),
      tone: 'warn',
      askFix: true,
    });
    const failing = hero({
      status: status({
        state: 'failing',
        lastFailure: { id: 'f', at: hoursAgo(1), stage: 'upload', reason: 'No NAS' },
      }),
      notice,
    });
    expect(failing).toMatchObject({ tone: 'bad', askFix: true });
    expect(failing.problem?.indexOf('No NAS.')).toBeLessThan(failing.problem?.indexOf(notice) ?? -1);
    expect(backupFixText(blind)).toContain(notice);
    // Without a notice, what the Whombat last said isn't used: the service's status is the answer.
    expect(hero({ status: null, lastKnownAt: hoursAgo(3) })).toMatchObject({
      state: 'none',
      title: T.notYet,
    });
  });

  it('keeps “Can’t be deleted from here” out of the chips (it is a detail)', () => {
    expect(hero().chips.map((c) => c.text)).not.toContain(T.details.noDelete);
  });
});

describe('which Backups page shows', () => {
  const q = (pending: boolean, failed: boolean) => ({ pending, failed });
  it('the new page, the same page while the service isn’t answering, what it showed before, or waits', () => {
    expect(backupPageShown({ list: q(false, false), policy: q(false, false), notice: null })).toBe('yes');
    expect(backupPageShown({ list: q(false, true), policy: q(false, true), notice: 'Down.' })).toBe('down');
    expect(backupPageShown({ list: q(false, false), policy: q(false, true), notice: 'Down.' })).toBe('down');
    // A box from before (no overview) or one without backups: the parts fail and nothing says why.
    expect(backupPageShown({ list: q(false, true), policy: q(false, false), notice: null })).toBe('no');
    expect(backupPageShown({ list: q(false, true), policy: q(false, true), notice: undefined })).toBe(
      'loading',
    );
    expect(backupPageShown({ list: q(true, false), policy: q(false, false), notice: null })).toBe('loading');
  });
});

describe('older backups on the places used before', () => {
  it('names them once, or says nothing', () => {
    const line = earlierPlacesLine([{ name: 'Attic' }, { name: 'BlackBox' }, { name: 'Attic' }]);
    expect(line).toContain('Attic and BlackBox');
    expect(line?.match(/Attic/g)).toHaveLength(1);
    expect(earlierPlacesLine([])).toBeNull();
    expect(earlierPlacesLine(undefined)).toBeNull();
  });
});

describe('what’s in it', () => {
  it('comes from the backup’s own coverage', () => {
    const rows = backupContents(cp({ covered: ['database', 'attachments', 'workspaces'] }));
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.conversations?.covered).toBe(true);
    expect(by.signIns?.covered).toBe(false);
    expect(by.settings?.covered).toBe(false);
    // No servers covered or missing: no servers' line.
    expect(by.servers).toBeUndefined();
    // Never in a backup, worded as the done screen says them.
    expect(by.voices).toMatchObject({ covered: false, note: T.detail.lines.voicesNote });
    expect(by.network?.covered).toBe(false);
  });

  it('says what a backup left out', () => {
    const rows = backupContents(
      cp({ covered: ['database', 'attachments'], incomplete: { attachments: 2, servers: true } }),
    );
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.files).toMatchObject({ gap: true, note: T.detail.lines.filesMissing(2) });
    expect(by.servers).toMatchObject({ covered: false, gap: true });
  });

  it('shows what every backup holds when the service doesn’t list it', () => {
    const rows = backupContents(cp());
    expect(rows.filter((r) => r.covered).map((r) => r.key)).toEqual([
      'conversations',
      'files',
      'projects',
      'servers',
      'settings',
      'signIns',
    ]);
  });
});

describe('details', () => {
  it('names where they are kept, who clears them and that they can’t be deleted from here', () => {
    const lines = backupDetailLines({ status: status(), clearedBy: 'place', placeName: 'BlackBox' });
    expect(lines[0]).toContain('BlackBox');
    expect(lines[0]).toContain('192.168.1.40:8747');
    expect(lines).toContain(T.details.clears.place('BlackBox'));
    expect(lines).toContain(`${T.details.noDelete}.`);
    const box = backupDetailLines({
      status: status({ destination: { configured: true, appendOnly: 'not-enforced' } }),
      clearedBy: 'box',
      placeName: null,
    });
    expect(box).toEqual([T.details.clears.box]);
  });
});

describe('bring back a Whombat you had, later', () => {
  const list = (checkpoints: BackupCheckpoint[], more = false) => ({
    checkpoints,
    nextCursor: more ? 'x' : null,
  });
  it('is offered while this Whombat started fresh: nothing set up, nothing yet, or only a few days', () => {
    expect(bringBackLaterOffered({ list: null, unprotected: true, now })).toBe(true);
    expect(bringBackLaterOffered({ list: list([]), unprotected: false, now })).toBe(true);
    expect(
      bringBackLaterOffered({ list: list([cp({ createdAt: hoursAgo(48) })]), unprotected: false, now }),
    ).toBe(true);
  });

  it('is not offered with weeks of its own backups, many pages, or after a bring back', () => {
    expect(
      bringBackLaterOffered({ list: list([cp({ createdAt: hoursAgo(24 * 21) })]), unprotected: false, now }),
    ).toBe(false);
    expect(bringBackLaterOffered({ list: list([cp()], true), unprotected: false, now })).toBe(false);
    expect(bringBackLaterOffered({ list: list([cp({ own: false })]), unprotected: false, now })).toBe(false);
    expect(bringBackLaterOffered({ list: null, unprotected: false, now })).toBe(false);
  });
});

describe('the overview', () => {
  const base = {
    state: 'protected' as const,
    lastSuccessAt: hoursAgo(2),
    ageS: 7200,
    coverage: [],
    unprotected: [],
    relogin: [],
    lastFailure: null,
    recoverable: true,
  };
  const overview = (backup: BackupStatus) =>
    whombatOverview({
      status: {
        backup,
        recovery: { enrolled: true, kitVerified: false },
        update: null,
      } as never,
      devices: null,
      passkeys: null,
      access: null,
      agent: 'Dusty',
    });

  it('says “Can be brought back” with being backed up, and asks for the passkey in NEEDS YOU', () => {
    const ready = overview({ ...base, ...bringBack('ready') });
    expect(ready.glance.find((g) => g.key === 'backups')?.meta).toContain(THIS_WHOMBAT_TEXT.broughtBack);
    expect(ready.glance.some((g) => g.key === 'kit')).toBe(false);
    const asked = overview({ ...base, ...bringBack('needs_passkey') });
    expect(asked.needsYou.find((n) => n.key === 'passkey')?.action).toBe('setUpPasskey');
    expect(asked.badges.devices).toBe(1);
  });

  it('keeps the recovery kit’s quiet row on a Whombat from before the passkey', () => {
    expect(overview(base).glance.some((g) => g.key === 'kit')).toBe(true);
  });
});

describe('the paper copy', () => {
  it('reads plainly: no repository password or recovery secrets words', () => {
    const text = paperCopyText({
      applianceName: 'Home',
      appliancePeerId: '12D3KooWHome',
      material: {
        kind: 'whombat.backup-recovery-material/1',
        applianceId: 'wb-home',
        generation: 3,
        createdAt: '2026-11-04T10:00:00Z',
        repository: 'rest:http://192.168.1.40:8747/home/',
        restUser: 'home',
        restPassword: 'rest-secret',
        repositoryPassword: 'repo-secret',
        repositoryId: 'repo-1',
        manifestKey: 'ed25519:AAAA',
      },
      made: '2026-11-04',
    });
    expect(text).not.toMatch(/repository password|backup password|recovery secret/i);
    expect(text).toContain('repo-secret');
  });
});

describe('after the rehearsal', () => {
  it('a Whombat just brought back says when its list’s newest backup was, not “No backup yet”', () => {
    const list = {
      checkpoints: [cp({ id: 'a2', createdAt: hoursAgo(3), own: false })],
      total: 1,
      nextCursor: null,
    };
    const h = hero({ status: status({ lastSuccess: null }), list } as never);
    expect(h.state).toBe('ok');
    expect(h.title).toBe(T.backedUp(ago(hoursAgo(3))));
    expect(hero({ status: status({ lastSuccess: null }) }).state).toBe('none');
  });

  it('“First backup” is the first of each Whombat in the list, and only when the list reaches its start', () => {
    const list = {
      checkpoints: [
        cp({ id: 'b1', createdAt: hoursAgo(1), applianceId: 'wb-new0-0000-0001' }),
        cp({
          id: 'a2',
          createdAt: hoursAgo(5),
          applianceId: 'wb-old0-0000-0001',
          own: false,
          reason: 'manual',
        }),
        cp({ id: 'a1', createdAt: hoursAgo(6), applianceId: 'wb-old0-0000-0001', own: false }),
      ],
      total: 3,
      nextCursor: null,
    };
    const labels = Object.fromEntries(
      backupGroups(list as never, null, { now })
        .flatMap((g) => g.rows)
        .map((r) => [r.id, r.label]),
    );
    expect(labels).toEqual({ b1: T.list.first, a2: T.list.reasons.manual, a1: T.list.first });
    const more = backupGroups({ ...list, nextCursor: 'more' } as never, null, { now }).flatMap((g) => g.rows);
    expect(more.map((r) => r.label)).not.toContain(T.list.first);
  });

  it('what a backup left out is said plainly, never a path or a raw error', () => {
    const raw =
      "The servers couldn't be backed up this time (the hosts service couldn't make its backup (whombat-hosts: stat /persist/hosts/hub.db: no such file or directory)); everything else was.";
    const said = plainLeftOut({ reason: raw, servers: true });
    expect(said).toBe(T.leftOutWhy.servers);
    expect(said).not.toMatch(/\/persist|whombat-hosts|'/);
    expect(plainLeftOut({ reason: 'open /var/lib/x: permission denied', attachments: 2 })).toBe(
      T.leftOutWhy.files(2),
    );
    expect(plainLeftOut({ reason: 'ENOSPC while writing' })).toBe(T.leftOutWhy.other);
    // A plain sentence stays, with curly apostrophes.
    expect(plainLeftOut({ reason: "The servers weren't reachable", servers: true })).toBe(
      'The servers weren’t reachable.',
    );
    expect(plainLeftOut(null)).toBeNull();
    expect(hero({ summary: { incomplete: { reason: raw, servers: true } } }).leftOut).toBe(
      T.leftOutWhy.servers,
    );
  });

  it('a Whombat to bring back goes by its name, else “your Whombat”, never its device id', () => {
    expect(bringBackName('Home')).toBe('Home');
    expect(bringBackName('wb-2kd9-p4wz-7f30')).toBe(BACKUP_OPTIONS_TEXT.bringBack.yourWhombat);
    expect(bringBackName(null)).toBe(BACKUP_OPTIONS_TEXT.bringBack.yourWhombat);
    const B = BACKUP_OPTIONS_TEXT.bringBack;
    // At the start of a sentence it is capitalised.
    expect(B.doneTitle(bringBackName(null)).startsWith('Your Whombat')).toBe(true);
    expect(B.doneTitle('Home').startsWith('Home')).toBe(true);
  });

  it('the old Whombat’s later backups (a lost or stolen box after it was replaced) are marked and never picked first', () => {
    const OLD = 'wb-old0-0000-0001';
    const NEW = 'wb-new0-0000-0001';
    const list = [
      cp({ id: 'thief', createdAt: hoursAgo(1), applianceId: OLD }),
      cp({ id: 'b1', createdAt: hoursAgo(2), applianceId: NEW }),
      cp({ id: 'a2', createdAt: hoursAgo(5), applianceId: OLD }),
      cp({ id: 'a1', createdAt: hoursAgo(6), applianceId: OLD }),
    ];
    expect([...madeAfterReplaced(list)]).toEqual(['thief']);
    expect(backupToBringBack(list)).toBe('b1');
    // One Whombat only: the newest.
    expect(backupToBringBack(list.filter((c) => c.applianceId === OLD))).toBe('thief');
    expect(madeAfterReplaced(list.filter((c) => c.applianceId === OLD)).size).toBe(0);
  });

  it('the question and the done screen promise a new password only where Whombat can give one', () => {
    const B = BACKUP_OPTIONS_TEXT.bringBack;
    expect(oldWhombatMeta('lost', { by: 'whombat', place: 'BlackBox' })).toBe(B.oldLostMeta);
    expect(oldWhombatMeta('lost', { by: 'you', place: '10.0.2.2:8747' })).toContain('10.0.2.2:8747');
    expect(oldWhombatMeta(null, { by: 'you', place: null })).toBe(B.oldGoneMetaYou);
    expect(oldWhombatMeta(null, undefined)).toBe(B.oldGoneMeta);
    const lost = {
      oldApplianceId: 'wb-old0-0000-0001',
      newPassword: { by: 'you' as const, place: '10.0.2.2:8747' },
      items: [{ id: 'old-appliance', resolution: 'credentials-rotated' }],
    } as never;
    expect(oldWhombatDoneLines(lost, 'Home')).toEqual([
      B.doneOldOff('Home'),
      B.donePassword('10.0.2.2:8747'),
    ]);
    const gone = {
      ...(lost as object),
      items: [{ id: 'old-appliance', resolution: 'decommissioned' }],
    } as never;
    expect(oldWhombatDoneLines(gone, 'Home')).toEqual([B.doneOldOff('Home')]);
    expect(B.doneOldOff(bringBackName(null))).toContain('old Whombat');
  });
});
