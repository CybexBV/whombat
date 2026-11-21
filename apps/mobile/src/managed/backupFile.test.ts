import { createHash } from 'node:crypto';
import {
  backupDownloadRows,
  backupFileProgress,
  backupRestoreOutcome,
  backupRestoreRows,
  downloadBackupFile,
} from '@whombat/client';
import { type ResourceRef, type ResourceStream, StreamError } from '@whombat/client/session';
import {
  BACKUP_COPY,
  BACKUP_DEFAULT_CATEGORIES,
  type BackupRestorePreview,
  backupDownloadLabel,
} from '@whombat/core/backup';
import type { BackupFileView, BackupRestoreView, BackupUploadView } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_SAVE_MIME,
  backupDownloadPanel,
  backupLeaveQuestion,
  backupRestorePanel,
  documentSink,
  downloadRowLabel,
  pickedBackupFile,
  pickSaveTarget,
  restoreRowLabel,
  storedDismissedRestores,
  type WritableDocuments,
} from './backupFile';

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/* Fixtures: the sketch's world (mock-dark.png) ------------------------------------------------------------------- */

const estimate = {
  categories: [
    { id: 'agents' as const, count: 1, bytes: 12_000 },
    { id: 'memories' as const, count: 142, bytes: 640_000 },
    { id: 'automations' as const, count: 9, bytes: 48_000 },
    { id: 'connections' as const, count: 14, bytes: 20_000 },
    { id: 'skills' as const, count: 23, bytes: 1_100_000 },
    { id: 'settings' as const, count: 6, bytes: 9_000 },
    { id: 'vault' as const, count: 8, bytes: 4_000 },
    { id: 'messages' as const, count: 18_402, bytes: 120_000_000 },
    { id: 'servers' as const, count: 0, bytes: 0, offered: false },
    { id: 'files' as const, count: 312, bytes: 1_400_000_000 },
    { id: 'repositories' as const, count: 0, bytes: 0 },
  ].map((c) => ({ offered: true, ...c })),
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

const restoreView = (over: Partial<BackupRestoreView> = {}): BackupRestoreView => ({
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
    { id: 'agents', count: 1, new: 0, here: 1, different: 0, notes: [] },
    { id: 'memories', count: 145, new: 130, here: 12, different: 3, notes: [] },
    { id: 'automations', count: 9, new: 9, here: 0, different: 0, notes: [] },
  ],
  notes: [],
  servers: null,
};

type Maker = Parameters<typeof backupDownloadPanel>[0];
const maker = (over: Partial<Maker> = {}): Maker => ({
  rows: backupDownloadRows(
    estimate,
    BACKUP_DEFAULT_CATEGORIES.filter((id) => id !== 'messages'),
  ),
  label: backupDownloadLabel(1_833_000),
  starting: false,
  error: null,
  defaults: { differ: false, saving: false, saved: false, save: async () => {} },
  file: null,
  step: 'choose',
  progress: null,
  readyLine: null,
  failure: null,
  removing: false,
  download: { status: 'idle', done: 0, total: 0, pct: 0, error: null },
  downloaded: false,
  ...over,
});

type Restorer = Parameters<typeof backupRestorePanel>[0];
const panelOf = (r: Restorer) => backupRestorePanel(r, 'Europe/Amsterdam');
const restorer = (over: Partial<Restorer> = {}): Restorer => ({
  step: 'choose',
  password: '',
  ticked: [],
  upload: null,
  stopped: null,
  uploading: null,
  opening: false,
  preview: null,
  madeLine: null,
  rows: [],
  fileNotes: [],
  hasDifferent: false,
  onDifferent: 'keep',
  serversQuestion: null,
  pointHere: true,
  starting: false,
  cancelling: false,
  restoreView: null,
  progress: null,
  outcome: null,
  error: null,
  errorCode: null,
  ...over,
});

/* Download a backup ------------------------------------------------------------------------------------------------ */

describe('download panel (AP-1212, AP-1213)', () => {
  it('chooses: the ticks, “Download · 1.8 MB”, the password’s problem under the field, other failures below', () => {
    const p = backupDownloadPanel(maker());
    expect(p.step).toBe('choose');
    if (p.step !== 'choose') return;
    expect(p.rows.map((r) => r.ticked)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(p.make).toEqual({ label: 'Download · 1.8 MB', busy: false });
    expect(p.defaults).toEqual({ offer: true, saving: false, saved: null });

    const short = backupDownloadPanel(maker({ error: BACKUP_COPY.download.passwordShort }));
    expect(short.step === 'choose' && short.passwordError).toBe('Use at least 10 characters.');
    expect(short.step === 'choose' && short.notes).toEqual([]);

    const failed = backupDownloadPanel(
      maker({
        failure: 'The file couldn’t be made.',
        error: 'Couldn’t reach your Whombat. Check your connection and try again.',
      }),
    );
    expect(failed.step === 'choose' && failed.notes).toEqual([
      'The file couldn’t be made.',
      'Couldn’t reach your Whombat. Check your connection and try again.',
    ]);
    expect(failed.step === 'choose' && failed.passwordError).toBeNull();
  });

  it('offers “Make these the default” until it saved them, then says so', () => {
    const offer = backupDownloadPanel(
      maker({ defaults: { differ: true, saving: true, saved: false, save: async () => {} } }),
    );
    expect(offer.step === 'choose' && offer.defaults).toEqual({ offer: true, saving: true, saved: null });
    const saved = backupDownloadPanel(
      maker({ defaults: { differ: false, saving: false, saved: true, save: async () => {} } }),
    );
    expect(saved.step === 'choose' && saved.defaults).toEqual({
      offer: false,
      saving: false,
      saved: 'These are the default now.',
    });
  });

  it('follows the file being made, with Cancel to stop it', () => {
    const making = file({
      status: 'making',
      progress: { done: 42, total: 100, step: 'messages' },
      size: null,
    });
    const p = backupDownloadPanel(
      maker({ file: making, step: 'making', progress: backupFileProgress(making), removing: true }),
    );
    expect(p).toEqual({
      step: 'making',
      file: { name: 'lumio-bv-2026-10-11.wbk', line: 'Making the file · Messages · 42 %', pct: 42 },
      cancel: { label: 'Cancel', busy: true },
      error: null,
    });
  });

  it('saves the ready file: Download with its size, then the transfer, then “Download again”', () => {
    const ready = { file: file(), step: 'ready' as const, readyLine: '1.8 MB · expires in 23 hours' };
    const first = backupDownloadPanel(maker(ready));
    expect(first).toEqual({
      step: 'ready',
      title: 'Your file is ready.',
      file: { name: 'lumio-bv-2026-10-11.wbk', line: '1.8 MB · expires in 23 hours', pct: null },
      transfer: null,
      saved: null,
      save: { label: 'Download · 1.8 MB', busy: false, primary: true },
      remove: { label: 'Remove', busy: false, disabled: false },
      error: null,
    });

    const moving = backupDownloadPanel(
      maker({
        ...ready,
        download: { status: 'downloading', done: 770_000, total: 1_833_000, pct: 42, error: null },
      }),
    );
    expect(moving.step === 'ready' && moving.transfer).toEqual({ pct: 42, text: 'Downloading · 42 %' });
    expect(moving.step === 'ready' && moving.save).toBeNull();
    expect(moving.step === 'ready' && moving.remove.disabled).toBe(true);

    const done = backupDownloadPanel(
      maker({
        ...ready,
        downloaded: true,
        download: { status: 'saved', done: 1_833_000, total: 1_833_000, pct: 100, error: null },
      }),
    );
    expect(done.step === 'ready' && done.saved).toBe('Saved to your device.');
    expect(done.step === 'ready' && done.save).toEqual({
      label: 'Download again',
      busy: false,
      primary: false,
    });
  });

  it('says why a download failed and keeps its button, as on the web', () => {
    const p = backupDownloadPanel(
      maker({
        file: file(),
        step: 'ready',
        readyLine: 'x',
        download: {
          status: 'failed',
          done: 0,
          total: 0,
          pct: 0,
          error: 'This file is damaged or incomplete.',
        },
      }),
    );
    expect(p.step === 'ready' && p.save?.label).toBe('Download · 1.8 MB');
    expect(p.step === 'ready' && p.error).toBe('This file is damaged or incomplete.');
  });

  it('names a tick for TalkBack: label, size, then its line', () => {
    const [agents] = backupDownloadRows(estimate, ['agents']);
    // The one agent's line (AP-4911): its name, face, model and keys, no roles.
    const label = downloadRowLabel(agents as never);
    expect(label).toMatch(/^The agent, 12\sKB\. /);
    expect(label).not.toMatch(/roles/);
    expect(downloadRowLabel({ label: 'The agent', size: null, meta: null })).toBe('The agent');
  });
});

/* Restore from a file ---------------------------------------------------------------------------------------------- */

describe('restore panel (AP-1216, AP-1217)', () => {
  it('chooses a file, and says where a stopped upload got to', () => {
    expect(panelOf(restorer())).toEqual({
      step: 'choose',
      choose: { label: 'Choose a file', busy: false },
      stopped: null,
      error: null,
    });
    const p = panelOf(
      restorer({ stopped: upload({ status: 'uploading', received: 770_000, size: 1_833_000 }) }),
    );
    expect(p.step === 'choose' && p.stopped).toEqual({
      name: 'lumio-bv-2026-10-11.wbk',
      line: 'Uploading stopped at 42 %. Choose the same file to go on.',
      pct: null,
    });
  });

  it('shows the upload moving on the file card', () => {
    const p = panelOf(
      restorer({
        step: 'uploading',
        uploading: { fileName: 'lumio-bv-2026-10-11.wbk', size: 1_833_000, done: 770_000, pct: 42 },
      }),
    );
    expect(p).toEqual({
      step: 'uploading',
      file: { name: 'lumio-bv-2026-10-11.wbk', line: 'Uploading · 42 %', pct: 42 },
      cancel: { label: 'Cancel', busy: false },
    });
  });

  it('asks for the password; a wrong one is said under the field', () => {
    const p = panelOf(
      restorer({
        step: 'password',
        upload: upload(),
        error: 'That password doesn’t open this file.',
        errorCode: 'wrong_password',
      }),
    );
    expect(p).toMatchObject({
      step: 'password',
      file: { name: 'lumio-bv-2026-10-11.wbk', line: 'Uploaded · 1.8 MB', pct: null },
      open: { label: 'Open', busy: false },
      passwordError: 'That password doesn’t open this file.',
      error: null,
    });
    const opening = panelOf(
      restorer({
        step: 'password',
        upload: upload(),
        opening: true,
        error: 'This file is damaged or incomplete.',
        errorCode: 'damaged',
      }),
    );
    expect(opening).toMatchObject({
      open: { label: 'Opening the file…', busy: true },
      passwordError: null,
      error: 'This file is damaged or incomplete.',
    });
  });

  it('previews what the file holds, with the choice for what differs', () => {
    const ticked = ['agents', 'memories', 'automations'] as const;
    const p = panelOf(
      restorer({
        step: 'preview',
        upload: upload(),
        preview,
        madeLine: 'Made 11 Oct 2026 on Lumio BV · Whombat 0.83',
        rows: backupRestoreRows(preview, [...ticked]),
        ticked: [...ticked],
        hasDifferent: true,
        onDifferent: 'replace',
      }),
    );
    expect(p.step).toBe('preview');
    if (p.step !== 'preview') return;
    expect(p.file).toEqual({
      name: 'lumio-bv-2026-10-11.wbk',
      line: 'Made 11 Oct 2026 on Lumio BV · Whombat 0.83',
      pct: null,
    });
    expect(p.different).toEqual({
      show: true,
      value: 'replace',
      options: [
        { value: 'keep', label: 'Keep what’s here' },
        { value: 'replace', label: 'Use the backup' },
      ],
    });
    expect(p.restore).toEqual({ label: 'Restore', busy: false, disabled: false });
    const none = panelOf(restorer({ step: 'preview', preview, ticked: [] }));
    expect(none.step === 'preview' && none.restore.disabled).toBe(true);
    expect(p.rows.map((r) => r.chips.map((c) => c.label))).toEqual([
      ['1 already here'],
      ['130 new', '12 already here', '3 different'],
      ['9 new'],
    ]);
    expect(restoreRowLabel(p.rows[1] as never)).toBe('Memories. 130 new, 12 already here, 3 different');
    expect(restoreRowLabel(p.rows[2] as never)).toBe(
      'Automations. 9 new. They start switched off, so they don’t run twice.',
    );
  });

  it('follows the restore, then says what came back and where to go next', () => {
    const running = restoreView({
      status: 'restoring',
      progress: { done: 3, total: 10, step: 'automations' },
    });
    const p = panelOf(
      restorer({
        step: 'restoring',
        restoreView: running,
        progress: { pct: 30, text: 'Restoring · Automations · 30 %' },
      }),
    );
    expect(p).toEqual({
      step: 'restoring',
      file: { name: 'lumio-bv-2026-10-11.wbk', line: 'Restoring · Automations · 30 %', pct: 30 },
    });

    const done = restoreView();
    const outcome = panelOf(
      restorer({ step: 'done', restoreView: done, outcome: backupRestoreOutcome(done) }),
    );
    expect(outcome).toMatchObject({
      step: 'outcome',
      file: { name: 'lumio-bv-2026-10-11.wbk', line: 'Made 11 Oct 2026 on Lumio BV' },
      failed: false,
      title: 'Restored',
      links: [
        { link: 'connections', label: 'Open Connections' },
        { link: 'automations', label: 'Open Automations' },
      ],
      dismiss: 'Done',
    });
    expect(outcome.step === 'outcome' && outcome.lines.length).toBeGreaterThan(0);

    const failed = restoreView({ status: 'failed', summary: null, error: null });
    expect(
      panelOf(restorer({ step: 'failed', restoreView: failed, outcome: backupRestoreOutcome(failed) })),
    ).toMatchObject({ step: 'outcome', failed: true, links: [], toPoint: [], dismiss: 'Try again' });
  });

  it('asks the address question with the servers, can’t tick servers that can’t come back, lists the ones to point (AP-4420)', () => {
    const servers = {
      id: 'servers' as const,
      count: 5,
      new: 5,
      here: 0,
      different: 0,
      notes: [],
    };
    const withServers = {
      ...preview,
      categories: [...preview.categories, servers],
      servers: {
        state: 'new' as const,
        count: 5,
        blockedBy: null,
        address: { from: '10.100.1.160', to: '10.100.1.158' },
      },
    };
    const asked = panelOf(
      restorer({
        step: 'preview',
        preview: withServers,
        rows: backupRestoreRows(withServers, ['servers']),
        ticked: ['servers'],
        serversQuestion:
          'Your servers look for your Whombat at 10.100.1.160. This Whombat is at 10.100.1.158.',
        pointHere: false,
      }),
    );
    expect(asked.step === 'preview' && asked.address).toMatchObject({
      value: 'leave',
      options: [
        { value: 'here', label: 'Point them here' },
        { value: 'leave', label: 'Leave them' },
      ],
    });
    expect(asked.step === 'preview' && asked.address?.text).toContain('10.100.1.158');
    const plain = panelOf(restorer({ step: 'preview', preview }));
    expect(plain.step === 'preview' && plain.address).toBeNull();

    const blocked = {
      ...withServers,
      servers: { state: 'blocked' as const, count: 5, blockedBy: 3, address: null },
    };
    const row = backupRestoreRows(blocked, ['servers']).find((r) => r.id === 'servers');
    expect(row).toMatchObject({ disabled: true, ticked: false });
    expect(restoreRowLabel(row as never)).toMatch(
      /^Servers\. Can’t come back\. This Whombat already watches 3/,
    );

    const done = restoreView({
      summary: {
        ...(restoreView().summary as NonNullable<BackupRestoreView['summary']>),
        servers: {
          back: 5,
          pointed: 4,
          toPoint: [{ id: 'blackbox', name: 'blackbox', address: '10.100.1.31' }],
        },
      },
    });
    const outcome = panelOf(
      restorer({ step: 'done', restoreView: done, outcome: backupRestoreOutcome(done) }),
    );
    expect(outcome.step === 'outcome' && outcome.toPoint).toEqual([
      { id: 'blackbox', name: 'blackbox', address: '10.100.1.31', label: 'Point it here' },
    ]);
  });
});

describe('leaving while a file moves (AP-1215)', () => {
  it('asks before stopping a download or an upload, and not otherwise', () => {
    expect(backupLeaveQuestion({ downloading: false, uploading: false })).toBeNull();
    expect(backupLeaveQuestion({ downloading: true, uploading: false })).toEqual({
      title: 'Stop the download?',
      text: 'The file isn’t saved yet.',
      stay: 'Keep going',
      stop: 'Stop',
    });
    expect(backupLeaveQuestion({ downloading: false, uploading: true })?.title).toBe('Stop the upload?');
  });
});

/* Where a download goes ------------------------------------------------------------------------------------------- */

describe('saving a download (AP-1214)', () => {
  it('asks Android’s “Save as” for the name, else a folder and a new file in it', async () => {
    const asked: string[] = [];
    const uri = await pickSaveTarget(
      {
        saveAs: async (name, mime) => {
          asked.push(`${name} ${mime}`);
          return 'content://downloads/document/7';
        },
        pickFolder: async () => {
          throw new Error('not asked');
        },
      },
      'lumio-bv-2026-10-11.wbk',
    );
    expect(uri).toBe('content://downloads/document/7');
    expect(asked).toEqual([`lumio-bv-2026-10-11.wbk ${BACKUP_SAVE_MIME}`]);

    const created: string[] = [];
    const folder = {
      createFile: (name: string, mime: string) => {
        created.push(`${name} ${mime}`);
        return { uri: `content://tree/docs/${name}` };
      },
    };
    expect(await pickSaveTarget({ saveAs: null, pickFolder: async () => folder }, 'a.wbk')).toBe(
      'content://tree/docs/a.wbk',
    );
    expect(created).toEqual([`a.wbk ${BACKUP_SAVE_MIME}`]);
    expect(
      await pickSaveTarget({ saveAs: async () => null, pickFolder: async () => folder }, 'a.wbk'),
    ).toBeNull();
    expect(await pickSaveTarget({ saveAs: null, pickFolder: async () => null }, 'a.wbk')).toBeNull();
  });

  /** Documents in memory: what was written to each, which are open, which were removed. */
  function memoryDocuments(options: { failRemove?: boolean } = {}) {
    const written = new Map<string, number[]>();
    const log: string[] = [];
    let open = 0;
    const docs: WritableDocuments = {
      openWrite(uri) {
        log.push(`open ${uri}`);
        open += 1;
        written.set(uri, []);
        return {
          writeBytes: (bytes) => written.get(uri)?.push(...bytes),
          close: () => {
            log.push(`close ${uri}`);
            open -= 1;
          },
        };
      },
      remove(uri) {
        log.push(`remove ${uri}`);
        if (options.failRemove) throw new Error('read-only provider');
        written.delete(uri);
      },
    };
    return { docs, written, log, openCount: () => open };
  }

  it('writes each chunk into the document as it comes, opened once, closed at the end', async () => {
    const m = memoryDocuments();
    const sink = documentSink(m.docs, 'content://d/1');
    await sink.write(new Uint8Array([1, 2]));
    await sink.write(new Uint8Array([3]));
    await sink.close();
    expect(m.written.get('content://d/1')).toEqual([1, 2, 3]);
    expect(m.log).toEqual(['open content://d/1', 'close content://d/1']);
    expect(m.openCount()).toBe(0);
  });

  it('removes the document when the download fails or is cancelled (no half file stays)', async () => {
    const m = memoryDocuments();
    const sink = documentSink(m.docs, 'content://d/2');
    await sink.write(new Uint8Array([1]));
    await sink.abort?.();
    expect(m.log).toEqual(['open content://d/2', 'close content://d/2', 'remove content://d/2']);
    expect(m.written.has('content://d/2')).toBe(false);

    const stubborn = memoryDocuments({ failRemove: true });
    await expect(
      Promise.resolve(documentSink(stubborn.docs, 'content://d/3').abort?.()),
    ).resolves.toBeUndefined();
  });

  /** A session serving `bytes` that drops the connection once after `dropAfter` bytes. */
  function session(bytes: Uint8Array, dropAfter: number) {
    const starts: number[] = [];
    return {
      starts,
      session: {
        transport: 'secure',
        async openResource(
          _ref: ResourceRef,
          o: { range?: { start: number } } = {},
        ): Promise<ResourceStream> {
          const start = o.range?.start ?? 0;
          starts.push(start);
          const drop = starts.length === 1 ? dropAfter : null;
          async function* chunks() {
            for (let at = start; at < bytes.byteLength; at += 1000) {
              if (drop !== null && at >= drop) throw new StreamError('lost', 'The connection dropped.');
              yield bytes.slice(at, Math.min(at + 1000, bytes.byteLength));
            }
          }
          return {
            meta: { contentType: 'application/vnd.whombat.backup', size: bytes.byteLength - start },
            chunks: chunks(),
            cancel: () => {},
          } as unknown as ResourceStream;
        },
      },
    };
  }

  it('picks up where a dropped download stopped, into the same document, every byte once', async () => {
    const bytes = new Uint8Array(5500).map((_, i) => (i * 7) % 251);
    const m = memoryDocuments();
    const s = session(bytes, 3000);
    await downloadBackupFile(
      s.session as never,
      { burrow: 'lumio', file: { id: 'bkf_aaaaaaaaaaaa', size: bytes.byteLength, sha256: sha256Hex(bytes) } },
      documentSink(m.docs, 'content://d/4'),
      { retryMs: 1 },
    );
    expect(s.starts).toEqual([0, 3000]);
    expect(m.written.get('content://d/4')).toEqual([...bytes]);
    expect(m.log).toEqual(['open content://d/4', 'close content://d/4']);
  });

  it('throws the document away when the bytes aren’t the file’s', async () => {
    const bytes = new Uint8Array(2000).fill(9);
    const m = memoryDocuments();
    await expect(
      downloadBackupFile(
        session(bytes, 10_000).session as never,
        { burrow: 'lumio', file: { id: 'bkf_aaaaaaaaaaaa', size: bytes.byteLength, sha256: 'b'.repeat(64) } },
        documentSink(m.docs, 'content://d/5'),
      ),
    ).rejects.toMatchObject({ code: 'damaged' });
    expect(m.log.at(-1)).toBe('remove content://d/5');
  });
});

/* The file to restore --------------------------------------------------------------------------------------------- */

describe('the picked file (AP-1216)', () => {
  it('is uploaded from where it is, by its name and size', () => {
    expect(
      pickedBackupFile({
        uri: 'content://d/9',
        name: 'lumio-bv-2026-10-11.wbk',
        size: 1_833_000,
        mimeType: null,
      }),
    ).toEqual({
      file: {
        uri: 'content://d/9',
        name: 'lumio-bv-2026-10-11.wbk',
        type: BACKUP_SAVE_MIME,
        size: 1_833_000,
      },
    });
  });

  it('says so when the provider doesn’t tell its size', () => {
    expect(pickedBackupFile({ uri: 'content://d/9', name: 'x.wbk', size: null })).toEqual({
      problem: 'Whombat can’t tell how big that file is. Save it on this phone first, then choose it again.',
    });
  });
});

describe('restores put away on this phone (AP-1219)', () => {
  function memoryStorage() {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
      removeItem: (k: string) => {
        data.delete(k);
      },
    };
  }

  it('keeps them across starts, the newest 20', () => {
    const storage = memoryStorage();
    const first = storedDismissedRestores(storage);
    first.add('bkr_one');
    first.add('bkr_two');
    first.add('bkr_one');
    expect([...storedDismissedRestores(storage).read()]).toEqual(['bkr_two', 'bkr_one']);
    for (let i = 0; i < 30; i++) first.add(`bkr_${i}`);
    const kept = [...storedDismissedRestores(storage).read()];
    expect(kept).toHaveLength(20);
    expect(kept.at(-1)).toBe('bkr_29');
  });

  it('reads a damaged entry as none', () => {
    const storage = memoryStorage();
    storage.setItem('backup.dismissedRestores', '{nope');
    expect(storedDismissedRestores(storage).read().size).toBe(0);
  });
});
