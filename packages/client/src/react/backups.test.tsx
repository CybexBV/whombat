// @vitest-environment jsdom
/**
 * The backup panels' hooks (backup-file.md AP-1188…AP-1198) against a small REST server: the download panel from its
 * defaults to a ready file, “Make these the default”; the restore panel from a chosen file to what came back.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { encodeBackupHeader } from '@whombat/core/backup';
import type { BackupFileView, BackupRestoreView, BackupUploadView } from '@whombat/core/contracts';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { ChunkSource } from '../session/types';
import { fakeClient } from '../test/session';
import { useBackupMaker, useBackupRestorer } from './backups';
import { WhombatClientProvider } from './context';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const T0 = '2026-10-11T11:00:00.000Z';

/** One owner's backups in memory, answering like the contract says. */
function server() {
  const s = {
    defaults: { categories: ['agents', 'memories', 'automations'], custom: true, updatedAt: T0 },
    files: [] as BackupFileView[],
    uploads: [] as BackupUploadView[],
    restores: [] as BackupRestoreView[],
    created: [] as unknown[],
    inspected: [] as unknown[],
    restoreBodies: [] as unknown[],
    /** What `inspect` adds to its answer (the servers' part, BF-14). */
    inspectExtra: {} as Record<string, unknown>,
    serversOffered: false,
  };
  const est = (id: string, count: number, bytes: number) => ({
    id,
    count,
    bytes,
  });
  const fetch = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace('/api/v1/burrows/lumio', '');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const method = init.method ?? 'GET';
    if (path === '/backups/defaults' && method === 'GET') return json(s.defaults);
    if (path === '/backups/defaults' && method === 'PUT') {
      s.defaults = { categories: body.categories, custom: true, updatedAt: T0 };
      return json(s.defaults);
    }
    if (path === '/backups/estimate')
      return json({
        categories: [
          est('agents', 5, 12_000),
          est('memories', 142, 640_000),
          est('automations', 9, 48_000),
          est('connections', 14, 20_000),
          est('skills', 23, 1_100_000),
          est('settings', 6, 9_000),
          est('vault', 8, 4_000),
          est('messages', 18_402, 120_000_000),
          { ...est('servers', 5, 2_000_000), offered: s.serversOffered },
          est('files', 312, 1_400_000_000),
          est('repositories', 0, 0),
        ],
        freeBytes: 40_000_000_000,
        maxBytes: 10 * 1024 ** 3,
        generatedAt: T0,
      });
    if (path === '/backups' && method === 'GET')
      return json({ files: s.files, uploads: s.uploads, restores: s.restores });
    if (path === '/backups' && method === 'POST') {
      s.created.push(body);
      const file: BackupFileView = {
        id: 'bkf_aaaaaaaaaaaa',
        name: 'lumio-bv-2026-10-11.wbk',
        status: 'making',
        progress: { done: 1, total: 4, step: 'agents' },
        categories: body.categories,
        includesSecrets: false,
        size: null,
        sha256: null,
        createdAt: T0,
        readyAt: null,
        expiresAt: null,
        error: null,
        downloadUrl: null,
      };
      s.files = [file];
      return json({ file }, 201);
    }
    if (path === '/backup-uploads' && method === 'POST') {
      const upload: BackupUploadView = {
        id: 'bku_aaaaaaaaaaaa',
        fileName: body.fileName,
        size: body.size,
        received: 0,
        status: 'uploading',
        sha256: null,
        createdAt: '2026-10-11T11:30:00.000Z',
        expiresAt: '2026-10-12T11:30:00.000Z',
        uploadUrl: '/api/v1/burrows/lumio/backup-uploads/bku_aaaaaaaaaaaa/content',
        chunkBytes: 1_000,
        maxChunkBytes: 16 * 1024 * 1024,
      };
      s.uploads = [upload];
      return json({ upload }, 201);
    }
    if (path === '/backup-uploads/bku_aaaaaaaaaaaa/content' && method === 'PUT') {
      // Chunk PUTs: where the upload stands.
      const range = new Headers(init.headers).get('content-range') ?? '';
      const [, , last, size] = /bytes (\d+)-(\d+)\/(\d+)/.exec(range) ?? [];
      const received = Number(last) + 1;
      const upload = s.uploads[0] as BackupUploadView;
      s.uploads = [{ ...upload, received, status: received === Number(size) ? 'uploaded' : 'uploading' }];
      return json({ upload: s.uploads[0] });
    }
    if (path === '/backup-uploads/bku_aaaaaaaaaaaa' && method === 'GET')
      return json({ upload: s.uploads[0] });
    if (path === '/backup-uploads/bku_aaaaaaaaaaaa' && method === 'DELETE') {
      s.uploads = [];
      return json({ ok: true });
    }
    if (path === '/backup-uploads/bku_aaaaaaaaaaaa/inspect') {
      s.inspected.push(body);
      if (body.password !== 'correct horse battery')
        return json(
          {
            error: {
              code: 'validation_failed',
              message: 'That password doesn’t open this file.',
              details: { code: 'backup_file.wrong_password' },
            },
          },
          422,
        );
      return json({
        fileName: 'lumio-bv-2026-10-11.wbk',
        size: 2_500,
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
        },
        sameBurrow: true,
        categories: [
          { id: 'agents', count: 5, new: 1, here: 4, different: 0 },
          { id: 'memories', count: 145, new: 130, here: 12, different: 3 },
          { id: 'automations', count: 9, new: 9, here: 0, different: 0 },
        ],
        notes: [],
        ...s.inspectExtra,
      });
    }
    if (path === '/backup-uploads/bku_aaaaaaaaaaaa/restore') {
      s.restoreBodies.push(body);
      const restore: BackupRestoreView = {
        id: 'bkr_aaaaaaaaaaaa',
        upload: 'bku_aaaaaaaaaaaa',
        fileName: 'lumio-bv-2026-10-11.wbk',
        madeAt: '2026-10-11T09:12:00.000Z',
        sourceName: 'Lumio BV',
        categories: body.categories,
        onDifferent: body.onDifferent,
        status: 'restoring',
        progress: { done: 0, total: 10, step: null },
        startedAt: '2026-10-11T11:40:00.000Z',
        finishedAt: null,
        summary: null,
        error: null,
      };
      s.restores = [restore];
      return json({ restore }, 201);
    }
    return json({ error: { code: 'not_found', message: `No ${method} ${path}` } }, 404);
  };
  const client = fakeClient(fetch as never, {
    validateResponses: false,
    origin: 'https://w.example',
    fake: {
      // The file's bytes arrive through the session's backup-file upload stream.
      completeUpload: async ({ bytes, target }) => {
        if (target.type !== 'backup-file') return null;
        const upload = s.uploads[0] as BackupUploadView;
        s.uploads = [{ ...upload, received: bytes.byteLength, status: 'uploaded' }];
        return { stagedBackupId: upload.id, size: bytes.byteLength, sha256: '0'.repeat(64) };
      },
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhombatClientProvider client={client} queryClient={queryClient} connect={false}>
      {children}
    </WhombatClientProvider>
  );
  return { s, wrapper };
}

const NOW = () => Date.parse('2026-10-11T12:00:00.000Z');

describe('useBackupMaker', () => {
  it('lists servers where they are offered and ticks them from the defaults (AP-4411)', async () => {
    const { s, wrapper } = server();
    s.serversOffered = true;
    s.defaults = { categories: ['agents', 'servers'], custom: true, updatedAt: T0 };
    const { result } = renderHook(() => useBackupMaker('lumio', { now: NOW }), { wrapper });
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toContain('servers'));
    expect(result.current.ticked).toEqual(['agents', 'servers']);
    expect(result.current.defaults.differ).toBe(false);
  });

  it('starts from the defaults, makes a file with the password, follows it to ready, saves new defaults', async () => {
    const { s, wrapper } = server();
    const { result } = renderHook(() => useBackupMaker('lumio', { now: NOW }), { wrapper });
    await waitFor(() => expect(result.current.rows[0]?.size).toBe('12 KB'));
    expect(result.current.ticked).toEqual(['agents', 'memories', 'automations']);
    // Servers aren't offered here (BF-13): not listed (AP-4411).
    expect(result.current.rows.map((r) => r.id)).not.toContain('servers');
    expect(result.current.label).toBe('Download · 700 KB');
    expect(result.current.problem).toBe('Use at least 10 characters.');
    expect(result.current.defaults.differ).toBe(false);
    act(() => result.current.toggle('vault'));
    expect(result.current.defaults.differ).toBe(true);
    act(() => result.current.setPassword('correct horse battery'));
    expect(result.current.problem).toBeNull();
    await act(() => result.current.make());
    expect(s.created).toEqual([
      { categories: ['agents', 'memories', 'automations', 'vault'], password: 'correct horse battery' },
    ]);
    expect(result.current.password).toBe('');
    expect(result.current.step).toBe('making');
    expect(result.current.progress).toEqual({ pct: 25, text: 'Making the file · The agent · 25 %' });
    // The server finishes; the panel reads the list again while something is being made.
    s.files = [
      {
        ...(s.files[0] as BackupFileView),
        status: 'ready',
        progress: null,
        size: 1_833_000,
        sha256: 'a'.repeat(64),
        readyAt: T0,
        expiresAt: '2026-10-12T11:01:00.000Z',
        downloadUrl: '/api/v1/burrows/lumio/backups/bkf_aaaaaaaaaaaa/content',
      },
    ];
    await waitFor(() => expect(result.current.step).toBe('ready'), { timeout: 3000 });
    expect(result.current.readyLine).toBe('1.8 MB · expires in 23 hours');
    await act(() => result.current.defaults.save());
    expect(s.defaults.categories).toEqual(['agents', 'memories', 'automations', 'vault']);
    expect(result.current.defaults).toMatchObject({ differ: false, saved: true });
  });
});

function backupSource(size: number): ChunkSource {
  const bytes = new Uint8Array(size).fill(7);
  bytes.set(
    encodeBackupHeader({
      kdf: { memoryKiB: 64, passes: 1, parallelism: 1 },
      salt: new Uint8Array(16),
      chunkBytes: 65_536,
      noncePrefix: new Uint8Array(16),
      keyCheck: new Uint8Array(16),
    }),
  );
  return { name: 'lumio-bv-2026-10-11.wbk', type: '', size, read: async (o, l) => bytes.slice(o, o + l) };
}

describe('useBackupRestorer', () => {
  it('uploads a chosen file, opens it with its password, restores the ticked categories, then shows what came back', async () => {
    const { s, wrapper } = server();
    const { result } = renderHook(() => useBackupRestorer('lumio', { now: NOW }), { wrapper });
    await waitFor(() => expect(result.current.step).toBe('choose'));
    await act(() => result.current.choose(backupSource(2_500)));
    expect(result.current.step).toBe('password');
    expect(result.current.upload?.received).toBe(2_500);
    act(() => result.current.setPassword('wrong password!'));
    await act(() => result.current.open());
    expect(result.current.error).toBe('That password doesn’t open this file.');
    expect(result.current.errorCode).toBe('wrong_password');
    act(() => result.current.setPassword('correct horse battery'));
    await act(() => result.current.open());
    expect(result.current.step).toBe('preview');
    expect(result.current.madeLine).toBe('Made 11 Oct 2026 on Lumio BV · Whombat 0.83');
    expect(result.current.ticked).toEqual(['agents', 'memories', 'automations']);
    expect(result.current.hasDifferent).toBe(true);
    act(() => result.current.toggle('agents'));
    act(() => result.current.setOnDifferent('replace'));
    await act(() => result.current.restore());
    expect(s.restoreBodies).toEqual([
      { password: 'correct horse battery', categories: ['memories', 'automations'], onDifferent: 'replace' },
    ]);
    expect(result.current.step).toBe('restoring');
    expect(result.current.password).toBe('');
    s.uploads = [];
    s.restores = [
      {
        ...(s.restores[0] as BackupRestoreView),
        status: 'done',
        progress: null,
        finishedAt: '2026-10-11T11:41:00.000Z',
        upload: null,
        summary: {
          categories: [
            { id: 'memories', added: 130, updated: 3, unchanged: 12, kept: 0, skipped: 0 },
            { id: 'automations', added: 9, updated: 0, unchanged: 0, kept: 0, skipped: 0 },
          ],
          connectionsToSignIn: [],
          automationsOff: 9,
          schedulesPaused: 0,
          notes: [],
          servers: null,
          finishedAt: '2026-10-11T11:41:00.000Z',
        },
      },
    ];
    await waitFor(() => expect(result.current.step).toBe('done'), { timeout: 3000 });
    expect(result.current.outcome).toEqual({
      title: 'Restored',
      lines: [
        'Brought back 133 memories and 9 automations.',
        '9 automations are switched off. Switch them on when you’re ready.',
      ],
      links: ['automations'],
      toPoint: [],
      failed: false,
    });
    act(() => result.current.dismiss());
    expect(result.current.step).toBe('choose');
  });

  it('sends the answer to the address question with the servers, and only then (BF-15, AP-4414)', async () => {
    const { s, wrapper } = server();
    s.inspectExtra = {
      categories: [
        { id: 'agents', count: 5, new: 1, here: 4, different: 0 },
        { id: 'servers', count: 5, new: 5, here: 0, different: 0 },
      ],
      servers: {
        state: 'new',
        count: 5,
        blockedBy: null,
        address: { from: '10.100.1.160', to: '10.100.1.158' },
      },
    };
    const { result } = renderHook(() => useBackupRestorer('lumio', { now: NOW }), { wrapper });
    await waitFor(() => expect(result.current.step).toBe('choose'));
    await act(() => result.current.choose(backupSource(2_500)));
    act(() => result.current.setPassword('correct horse battery'));
    await act(() => result.current.open());
    expect(result.current.ticked).toEqual(['agents', 'servers']);
    expect(result.current.serversQuestion).toContain('10.100.1.158');
    expect(result.current.pointHere).toBe(true);
    act(() => result.current.setPointHere(false));
    await act(() => result.current.restore());
    expect(s.restoreBodies).toEqual([
      {
        password: 'correct horse battery',
        categories: ['agents', 'servers'],
        onDifferent: 'keep',
        servers: { pointHere: false },
      },
    ]);
  });

  it('can’t tick servers another Whombat’s fleet would replace, and asks nothing then (BF-14, AP-4413)', async () => {
    const { s, wrapper } = server();
    s.inspectExtra = {
      categories: [
        { id: 'agents', count: 5, new: 1, here: 4, different: 0 },
        { id: 'servers', count: 5, new: 0, here: 0, different: 0 },
      ],
      servers: { state: 'blocked', count: 5, blockedBy: 3, address: null },
    };
    const { result } = renderHook(() => useBackupRestorer('lumio', { now: NOW }), { wrapper });
    await waitFor(() => expect(result.current.step).toBe('choose'));
    await act(() => result.current.choose(backupSource(2_500)));
    act(() => result.current.setPassword('correct horse battery'));
    await act(() => result.current.open());
    expect(result.current.ticked).toEqual(['agents']);
    act(() => result.current.toggle('servers', true));
    expect(result.current.ticked).toEqual(['agents']);
    expect(result.current.rows.find((r) => r.id === 'servers')).toMatchObject({ disabled: true });
    expect(result.current.serversQuestion).toBeNull();
    await act(() => result.current.restore());
    expect(s.restoreBodies).toEqual([
      { password: 'correct horse battery', categories: ['agents'], onDifferent: 'keep' },
    ]);
  });

  it('refuses a file that isn’t a backup file without staging it, and Cancel removes a staged one', async () => {
    const { s, wrapper } = server();
    const { result } = renderHook(() => useBackupRestorer('lumio', { now: NOW }), { wrapper });
    await waitFor(() => expect(result.current.step).toBe('choose'));
    const text = new TextEncoder().encode('just some notes, not a backup at all, really not.'.repeat(4));
    await act(() =>
      result.current.choose({
        name: 'notes.txt',
        type: 'text/plain',
        size: text.byteLength,
        read: async (o, l) => text.slice(o, o + l),
      }),
    );
    expect(result.current.error).toBe('This isn’t a Whombat backup file.');
    expect(s.uploads).toEqual([]);
    await act(() => result.current.choose(backupSource(1_500)));
    expect(result.current.step).toBe('password');
    await act(() => result.current.cancel());
    expect(s.uploads).toEqual([]);
    expect(result.current.step).toBe('choose');
  });
});
