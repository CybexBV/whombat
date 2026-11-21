import type { BackupRestorePreview } from '@whombat/core/backup';
import type { BackupFileView, BackupRestoreView, BackupUploadView } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '../http/errors';
import { OutcomeUnknownError, StreamError } from '../session/types';
import {
  BACKUP_FILE_TEXT,
  backupChosenBytes,
  backupDownloadRows,
  backupFileFailure,
  backupFileProgress,
  backupFileReadyLine,
  backupMakeLabel,
  backupMakeProblem,
  backupMakeStep,
  backupProblem,
  backupRestoreFileLine,
  backupRestoreHasDifferent,
  backupRestoreMadeLine,
  backupRestoreOutcome,
  backupRestoreRows,
  backupRestoreStartingTicks,
  backupRestoreStep,
  backupServersQuestion,
  backupShownCategories,
  backupShownTicks,
  backupStartingTicks,
  backupsBusy,
  backupTimeLeft,
  backupTransferPct,
  currentBackupFile,
  currentBackupRestore,
  resumableBackupUpload,
  sameBackupCategories,
  toggleBackupCategory,
} from './model';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');

/** The sketch's download panel (mock-dark.png). */
const estimate = {
  categories: [
    { id: 'agents' as const, count: 5, bytes: 12_000, offered: true },
    {
      id: 'memories' as const,
      count: 142,
      bytes: 640_000,
      offered: true,
    },
    {
      id: 'automations' as const,
      count: 9,
      bytes: 48_000,
      offered: true,
    },
    { id: 'connections' as const, count: 14, bytes: 20_000, offered: true },
    {
      id: 'skills' as const,
      count: 23,
      bytes: 1_100_000,
      offered: true,
    },
    { id: 'settings' as const, count: 6, bytes: 9_000, offered: true },
    { id: 'vault' as const, count: 8, bytes: 4_000, offered: true },
    {
      id: 'messages' as const,
      count: 18_402,
      bytes: 120_000_000,
      offered: true,
    },
    // This Whombat watches no servers (BF-13): the panel leaves them out.
    { id: 'servers' as const, count: 0, bytes: 0, offered: false },
    {
      id: 'files' as const,
      count: 312,
      bytes: 1_400_000_000,
      offered: true,
    },
    { id: 'repositories' as const, count: 0, bytes: 0, offered: true },
  ],
  freeBytes: 40_000_000_000,
  maxBytes: 10 * 1024 ** 3,
  generatedAt: '2026-10-11T12:00:00.000Z',
};

/** The same Whombat watching five servers (BF-13). */
const withServers = {
  ...estimate,
  categories: estimate.categories.map((c) =>
    c.id === 'servers' ? { ...c, count: 5, bytes: 2_000_000, offered: true } : c,
  ),
};

const file = (over: Partial<BackupFileView> = {}): BackupFileView => ({
  id: 'bkf_aaaaaaaaaaaa',
  name: 'lumio-bv-2026-10-11.wbk',
  status: 'ready',
  progress: null,
  categories: ['agents', 'memories'],
  includesSecrets: false,
  size: 1_833_000,
  sha256: 'a'.repeat(64),
  createdAt: '2026-10-11T11:00:00.000Z',
  readyAt: '2026-10-11T11:01:00.000Z',
  expiresAt: '2026-10-12T11:01:00.000Z',
  error: null,
  downloadUrl: '/api/v1/burrows/lumio/backups/bkf_aaaaaaaaaaaa/content',
  ...over,
});

const upload = (over: Partial<BackupUploadView> = {}): BackupUploadView => ({
  id: 'bku_aaaaaaaaaaaa',
  fileName: 'lumio-bv-2026-10-11.wbk',
  size: 1_833_000,
  received: 1_833_000,
  status: 'uploaded',
  sha256: null,
  createdAt: '2026-10-11T11:30:00.000Z',
  expiresAt: '2026-10-12T11:30:00.000Z',
  uploadUrl: '/api/v1/burrows/lumio/backup-uploads/bku_aaaaaaaaaaaa/content',
  chunkBytes: 8 * 1024 * 1024,
  maxChunkBytes: 16 * 1024 * 1024,
  ...over,
});

const restore = (over: Partial<BackupRestoreView> = {}): BackupRestoreView => ({
  id: 'bkr_aaaaaaaaaaaa',
  upload: 'bku_aaaaaaaaaaaa',
  fileName: 'lumio-bv-2026-10-11.wbk',
  madeAt: '2026-10-11T11:00:00.000Z',
  sourceName: 'Lumio BV',
  categories: ['automations', 'connections'],
  onDifferent: 'keep',
  status: 'done',
  progress: null,
  startedAt: '2026-10-11T11:40:00.000Z',
  finishedAt: '2026-10-11T11:41:00.000Z',
  summary: {
    categories: [
      { id: 'automations', added: 9, updated: 0, unchanged: 0, kept: 0, skipped: 0 },
      { id: 'connections', added: 14, updated: 0, unchanged: 0, kept: 0, skipped: 0 },
    ],
    connectionsToSignIn: [{ id: 'con_aaaaaaaaaaaa', label: 'Fusebox' }],
    automationsOff: 9,
    schedulesPaused: 0,
    notes: [],
    servers: null,
    finishedAt: '2026-10-11T11:41:00.000Z',
  },
  error: null,
  ...over,
});

const preview: BackupRestorePreview = {
  fileName: 'lumio-bv-2026-10-11.wbk',
  size: 1_833_000,
  manifest: {
    format: 'whombat.backup-file/1',
    schemaVersion: 1,
    createdAt: '2026-10-11T09:12:00.000Z',
    timeZone: 'Europe/Amsterdam',
    whombatVersion: '0.83.1',
    source: { burrowId: 'brw_aaaaaaaaaaaa', name: 'Lumio BV', slug: 'lumio-bv' },
    madeBy: { name: 'Mara', email: 'mara@lumio.example.net' },
    categories: [],
    includesSecrets: true,
    notes: [],
  },
  sameBurrow: true,
  categories: [
    { id: 'memories', count: 145, new: 130, here: 12, different: 3, notes: [] },
    { id: 'agents', count: 5, new: 1, here: 4, different: 0, notes: [] },
    {
      id: 'automations',
      count: 9,
      new: 9,
      here: 0,
      different: 0,
      notes: [{ code: 'drafts', category: 'automations', count: 2 }],
    },
    { id: 'settings', count: 4, new: 2, here: 2, different: 0, notes: [] },
  ],
  notes: [{ code: 'unknown_authors', category: null, count: 3 }],
  servers: null,
};

describe('the download panel', () => {
  it('starts from the burrow’s defaults, the contracts’ nine until they load, without what isn’t offered', () => {
    const seven = ['agents', 'memories', 'automations', 'connections', 'skills', 'settings', 'vault'];
    // Before the estimate is in, servers aren't listed (AP-4411); without servers here, the eight others.
    expect(backupStartingTicks(null)).toEqual([...seven, 'messages']);
    expect(backupStartingTicks(null, estimate)).toEqual([...seven, 'messages']);
    expect(backupStartingTicks(null, withServers)).toEqual([...seven, 'messages', 'servers']);
    expect(backupStartingTicks({ categories: ['messages', 'agents'] })).toEqual(['agents', 'messages']);
    expect(backupShownTicks(['servers', 'agents'], estimate)).toEqual(['agents']);
    expect(backupShownTicks(['servers', 'agents'], withServers)).toEqual(['agents', 'servers']);
  });

  it('lists every category this Whombat offers with the sketch’s meta lines and sizes', () => {
    const rows = backupDownloadRows(estimate, backupStartingTicks(null, estimate));
    expect(rows.map((r) => [r.label, r.meta, r.size, r.ticked])).toEqual([
      ['The agent', 'Its name, face, model and keys', '12\u00a0KB', true],
      ['Memories', 'What the agent remembers about you, and its notes', '640\u00a0KB', true],
      ['Automations', '9 automations · come back switched off', '48\u00a0KB', true],
      ['Connections', '14 connections, with their sign-ins', '20\u00a0KB', true],
      ['Skills', '23 skills and which are on', '1.1\u00a0MB', true],
      ['Settings', 'Your settings, repositories and pinned widgets', '9\u00a0KB', true],
      ['Your Vault', 'Your 8 entries', '4\u00a0KB', true],
      ['Messages', '18,402 messages in chats and threads', '120\u00a0MB', true],
      ['Files', '312 files you and the agent saved', '1.4\u00a0GB', false],
      ['Repositories on this Whombat', 'No repositories on this Whombat', null, false],
    ]);
    expect(backupDownloadRows(null, [])[0]).toMatchObject({ label: 'The agent', meta: null, size: null });
    expect(backupDownloadRows(null, []).map((r) => r.id)).not.toContain('servers');
    const servers = backupDownloadRows(withServers, backupStartingTicks(null, withServers)).find(
      (r) => r.id === 'servers',
    );
    expect(servers).toMatchObject({ label: 'Servers', ticked: true });
    expect(servers?.meta).toContain('5 servers');
    // An older Whombat's estimate has no servers row (and no `offered`): everything it lists is offered.
    const older = {
      categories: estimate.categories
        .filter((c) => c.id !== 'servers')
        .map(({ offered: _, ...c }) => c) as typeof estimate.categories,
    };
    expect(backupShownCategories(older)).toHaveLength(10);
    expect(backupShownCategories(older)).not.toContain('servers');
  });

  it('sizes the button by the ticked categories', () => {
    const ticked = backupStartingTicks(null).filter((id) => id !== 'messages');
    expect(backupChosenBytes(estimate, ticked)).toBe(1_833_000);
    expect(backupMakeLabel(estimate, ticked)).toBe('Download · 1.8\u00a0MB');
    expect(backupMakeLabel(null, ticked)).toBe('Download');
  });

  it('switches ticks in category order and compares them with the defaults', () => {
    const ticked = toggleBackupCategory(['vault', 'agents'], 'messages');
    expect(ticked).toEqual(['agents', 'vault', 'messages']);
    expect(toggleBackupCategory(ticked, 'agents')).toEqual(['vault', 'messages']);
    expect(toggleBackupCategory(ticked, 'agents', true)).toEqual(ticked);
    expect(sameBackupCategories(['vault', 'agents'], ['agents', 'vault'])).toBe(true);
    expect(sameBackupCategories(['vault'], ['agents', 'vault'])).toBe(false);
  });

  it('says why a file can’t be made yet', () => {
    const ticked = backupStartingTicks(null).filter((id) => id !== 'messages');
    const password = 'correct horse';
    expect(backupMakeProblem({ estimate, ticked: [], password })).toBe('Choose at least one thing.');
    expect(backupMakeProblem({ estimate, ticked, password: 'short' })).toBe('Use at least 10 characters.');
    expect(backupMakeProblem({ estimate: { ...estimate, freeBytes: 1_000 }, ticked, password })).toBe(
      'There isn’t enough room on this Whombat for that. Free up some space and try again.',
    );
    expect(backupMakeProblem({ estimate: { ...estimate, maxBytes: 1_000 }, ticked, password })).toBe(
      'This file is too large for a backup file.',
    );
    expect(backupMakeProblem({ estimate, ticked, password })).toBeNull();
    expect(backupMakeProblem({ estimate: null, ticked, password })).toBeNull();
  });

  it('shows the newest file that hasn’t expired: being made, ready or failed', () => {
    const making = file({
      id: 'bkf_bbbbbbbbbbbb',
      status: 'making',
      progress: { done: 42, total: 100, step: 'messages' },
      size: null,
      expiresAt: null,
    });
    expect(currentBackupFile({ files: [making, file()] }, NOW)).toBe(making);
    expect(backupMakeStep(making)).toBe('making');
    expect(backupFileProgress(making)).toEqual({ pct: 42, text: 'Making the file · Messages · 42 %' });
    const old = file({ expiresAt: '2026-10-11T11:59:00.000Z' });
    expect(currentBackupFile({ files: [old] }, NOW)).toBeNull();
    expect(backupMakeStep(null)).toBe('choose');
    const failed = file({
      status: 'failed',
      error: { code: 'no_room', message: 'There isn’t enough room.' },
    });
    expect(backupMakeStep(failed)).toBe('choose');
    expect(backupFileFailure(failed)).toBe('The file couldn’t be made. There isn’t enough room.');
    expect(backupFileFailure(file())).toBeNull();
  });

  it('says the ready file’s name, size and how long it stays', () => {
    expect(backupFileReadyLine(file(), NOW)).toBe('1.8\u00a0MB · expires in 23 hours');
    expect(backupRestoreFileLine(restore(), 'Europe/Amsterdam')).toBe('Made 11 Oct 2026 on Lumio BV');
    expect(backupTimeLeft('2026-10-11T13:00:00.000Z', NOW)).toBe('1 hour');
    expect(backupTimeLeft('2026-10-11T12:40:30.000Z', NOW)).toBe('40 minutes');
    expect(backupTimeLeft('2026-10-11T12:00:20.000Z', NOW)).toBe('1 minute');
    expect(backupTransferPct(0, 0)).toBe(0);
    expect(backupTransferPct(999, 1000)).toBe(99);
    expect(backupTransferPct(1000, 1000)).toBe(100);
  });
});

describe('the restore panel', () => {
  it('goes choose → uploading → password → preview → restoring → done', () => {
    const base = { restore: null, uploading: false, upload: null, preview: null };
    expect(backupRestoreStep(base)).toBe('choose');
    expect(backupRestoreStep({ ...base, uploading: true })).toBe('uploading');
    expect(backupRestoreStep({ ...base, upload: upload({ status: 'uploading' }) })).toBe('choose');
    expect(backupRestoreStep({ ...base, upload: upload() })).toBe('password');
    expect(backupRestoreStep({ ...base, upload: upload(), preview })).toBe('preview');
    expect(backupRestoreStep({ ...base, restore: restore({ status: 'restoring' }), upload: upload() })).toBe(
      'restoring',
    );
    expect(backupRestoreStep({ ...base, restore: restore() })).toBe('done');
    // A failed restore whose file is still here says why first; a file uploaded after it goes on.
    expect(backupRestoreStep({ ...base, restore: restore({ status: 'failed' }), upload: upload() })).toBe(
      'failed',
    );
    expect(
      backupRestoreStep({
        ...base,
        restore: restore(),
        upload: upload({ id: 'bku_bbbbbbbbbbbb', createdAt: '2026-10-11T11:50:00.000Z' }),
      }),
    ).toBe('password');
  });

  it('shows a running restore, else the newest finished one not put away', () => {
    const running = restore({ id: 'bkr_bbbbbbbbbbbb', status: 'restoring' });
    expect(currentBackupRestore({ restores: [restore(), running] }, new Set())).toBe(running);
    expect(currentBackupRestore({ restores: [restore()] }, new Set())?.id).toBe('bkr_aaaaaaaaaaaa');
    expect(currentBackupRestore({ restores: [restore()] }, new Set(['bkr_aaaaaaaaaaaa']))).toBeNull();
    expect(backupsBusy({ files: [], restores: [running] })).toBe(true);
    expect(backupsBusy({ files: [file()], restores: [restore()] })).toBe(false);
  });

  it('goes on with a stopped upload of the same file', () => {
    const stopped = upload({ status: 'uploading', received: 8_388_608 });
    const list = { uploads: [stopped] };
    expect(resumableBackupUpload(list, { name: 'lumio-bv-2026-10-11.wbk', size: 1_833_000 }, NOW)).toBe(
      stopped,
    );
    expect(resumableBackupUpload(list, { name: 'other.wbk', size: 1_833_000 }, NOW)).toBeNull();
    expect(
      resumableBackupUpload({ uploads: [upload()] }, { name: upload().fileName, size: 1_833_000 }, NOW),
    ).toBeNull();
  });

  it('lays out the preview as the sketch: rows in order, chips, the fixed lines and notes', () => {
    const ticked = backupRestoreStartingTicks(preview);
    expect(ticked).toEqual(['agents', 'memories', 'automations', 'settings']);
    const rows = backupRestoreRows(preview, ticked);
    expect(rows.map((r) => [r.label, r.chips.map((c) => c.label), r.hint, r.notes])).toEqual([
      ['The agent', ['1 new', '4 already here'], null, []],
      ['Memories', ['130 new', '12 already here', '3 different'], null, []],
      [
        'Automations',
        ['9 new'],
        'They start switched off, so they don’t run twice.',
        ['2 automations no longer fit this Whombat, so they come back as drafts.'],
      ],
      ['Settings', ['2 new', '2 already here'], null, []],
    ]);
    expect(rows[1]?.chips[2]?.tone).toBe('warn');
    expect(backupRestoreMadeLine(preview)).toBe('Made 11 Oct 2026 on Lumio BV · Whombat 0.83');
    expect(backupRestoreHasDifferent(preview, ticked)).toBe(true);
    expect(backupRestoreHasDifferent(preview, ['agents'])).toBe(false);
  });

  it('says what a finished restore brought back and where the person is needed', () => {
    expect(backupRestoreOutcome(restore())).toEqual({
      title: 'Restored',
      lines: [
        'Brought back 9 automations and 14 connections.',
        'Fusebox needs you to sign in again. It’s in the Inbox.',
        '9 automations are switched off. Switch them on when you’re ready.',
      ],
      links: ['connections', 'automations'],
      toPoint: [],
      failed: false,
    });
    const stopped = backupRestoreOutcome(
      restore({ status: 'failed', summary: null, error: { code: 'restore_failed', message: 'It stopped.' } }),
    );
    expect(stopped).toMatchObject({ title: 'It stopped.', lines: [], links: [], toPoint: [], failed: true });
  });

  it('shows the servers’ state, asks about the address and lists the servers to point by hand (BF-14, BF-15)', () => {
    const servers = {
      id: 'servers' as const,
      count: 5,
      new: 5,
      here: 0,
      different: 0,
      notes: [],
    };
    const fresh = {
      ...preview,
      categories: [...preview.categories, servers],
      servers: {
        state: 'new' as const,
        count: 5,
        blockedBy: null,
        address: { from: '10.100.1.160', to: '10.100.1.158' },
      },
    };
    const ticked = backupRestoreStartingTicks(fresh);
    expect(ticked).toContain('servers');
    const row = backupRestoreRows(fresh, ticked).find((r) => r.id === 'servers');
    expect(row).toMatchObject({ label: 'Servers', ticked: true, disabled: false, hint: null });
    expect(row?.chips.map((c) => c.label)).toEqual(['5 new']);
    const question = backupServersQuestion(fresh, ticked);
    expect(question).toContain('10.100.1.160');
    expect(question).toContain('10.100.1.158');
    expect(backupServersQuestion(fresh, ['agents'])).toBeNull();
    expect(
      backupServersQuestion({ ...fresh, servers: { ...fresh.servers, address: null } }, ticked),
    ).toBeNull();

    // Another Whombat's fleet where this one already watches 3: the row says so and can't be ticked.
    const blocked = {
      ...fresh,
      categories: [...preview.categories, { ...servers, new: 0 }],
      servers: { state: 'blocked' as const, count: 5, blockedBy: 3, address: null },
    };
    expect(backupRestoreStartingTicks(blocked)).not.toContain('servers');
    const no = backupRestoreRows(blocked, [...ticked, 'servers']).find((r) => r.id === 'servers');
    expect(no).toMatchObject({ ticked: false, disabled: true });
    expect(no?.chips).toEqual([{ label: 'Can’t come back', tone: 'warn' }]);
    expect(no?.hint).toContain('3 servers');
    expect(backupServersQuestion(blocked, ['servers'])).toBeNull();
    const none = {
      ...blocked,
      servers: { state: 'unavailable' as const, count: 5, blockedBy: null, address: null },
    };
    expect(backupRestoreRows(none, []).find((r) => r.id === 'servers')).toMatchObject({ disabled: true });

    // The summary: pointed here, and pve-01 to point by hand.
    const toPoint = [{ id: 'srv_pve01', name: 'pve-01', address: '10.100.1.20' }];
    const outcome = backupRestoreOutcome(
      restore({
        summary: {
          ...(restore().summary as NonNullable<BackupRestoreView['summary']>),
          connectionsToSignIn: [],
          automationsOff: 0,
          servers: { back: 5, pointed: 4, toPoint },
        },
      }),
    );
    expect(outcome.toPoint).toEqual(toPoint);
    expect(outcome.lines.some((l) => l.includes('Pointed 4 servers'))).toBe(true);
    expect(outcome.lines.some((l) => l.startsWith('pve-01'))).toBe(true);
  });
});

describe('backupProblem', () => {
  const api = (status: number, code: string | null, message = 'Server words.') =>
    new ApiError(
      status,
      'validation_failed',
      message,
      {},
      'backups.inspect',
      {},
      code ? { code } : undefined,
    );

  it('says the contracts’ sentence for a backup-file code, wherever it came from', () => {
    expect(backupProblem(api(400, 'backup_file.wrong_password'))).toEqual({
      code: 'wrong_password',
      message: 'That password doesn’t open this file.',
      cancelled: false,
    });
    expect(backupProblem(new StreamError('backup_file.expired', 'Refused.')).code).toBe('expired');
    expect(backupProblem(new StreamError('backup_file.upload_mismatch', 'Refused.')).message).toBe(
      'The upload doesn’t match the file. Upload it again.',
    );
    expect(backupProblem({ name: 'BackupFileError', code: 'newer_format' }).message).toBe(
      'This file was made by a newer Whombat. Update this one first.',
    );
  });

  it('reads a missing stream by what was going on, and the network as the network', () => {
    expect(backupProblem(new StreamError('not_found', 'x'), 'download').code).toBe('expired');
    expect(backupProblem(new StreamError('not_found', 'x'), 'upload').code).toBe('upload_expired');
    expect(backupProblem(new StreamError('lost', 'x')).message).toBe(BACKUP_FILE_TEXT.connection);
    expect(backupProblem(new NetworkError('backups.list', null)).message).toBe(BACKUP_FILE_TEXT.connection);
    expect(backupProblem(new StreamError('cancelled', 'x')).cancelled).toBe(true);
    expect(backupProblem(new OutcomeUnknownError('backups.create', 'req_1')).message).toBe(
      BACKUP_FILE_TEXT.noAnswer,
    );
    expect(backupProblem(api(403, null)).code).toBe('people_only');
    expect(backupProblem(api(500, null)).message).toBe(BACKUP_FILE_TEXT.failed);
    expect(backupProblem(new Error('boom')).message).toBe(BACKUP_FILE_TEXT.failed);
  });
});
