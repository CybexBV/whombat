import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchFiles, FileRef } from '@whombat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchedAttachment, RunnerApi } from './api';
import { filesTreePaths, prepareConversationFiles, turnTreeDir } from './files';
import { FilesCache } from './files-cache';
import { testContext } from './test-context';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function ref(
  id: string,
  name: string,
  folder = '',
  bytes = Buffer.from(id),
  addedAt = '2026-10-05T10:00:00.000Z',
) {
  return {
    id,
    name,
    folder,
    contentType: 'application/octet-stream',
    size: bytes.length,
    kind: 'file' as const,
    sha256: sha(bytes),
    messageId: null,
    addedAt,
  } satisfies FileRef;
}

describe('filesTreePaths (FS-09)', () => {
  it('lays files out as <folder>/<name>, folders compared case-insensitively, the first spelling kept', () => {
    const paths = filesTreePaths([
      ref('att_1', 'plan.skp', 'Drawings'),
      ref('att_2', 'site.dxf', 'drawings/2024'),
      ref('att_3', 'notes.txt'),
    ]);
    expect([...paths.values()]).toEqual(['Drawings/plan.skp', 'Drawings/2024/site.dxf', 'notes.txt']);
  });

  it('de-duplicates names per folder (the newest keeps the plain name) and never takes a folder’s name', () => {
    const paths = filesTreePaths([
      ref('att_new', 'Q3.csv'),
      ref('att_old', 'q3.csv'),
      ref('att_in', 'q3.csv', 'Archive'),
      ref('att_clash', 'archive'),
    ]);
    expect(paths.get('att_new')).toBe('Q3.csv');
    expect(paths.get('att_old')).toBe('att_old-q3.csv');
    // Another folder: the plain name again.
    expect(paths.get('att_in')).toBe('Archive/q3.csv');
    expect(paths.get('att_clash')).toBe('att_clash-archive');
  });

  it('never lets a name or a folder leave the tree', () => {
    const paths = filesTreePaths([
      ref('att_a', '../../etc/passwd', '../..'),
      ref('att_b', '.hidden', '.git/hooks'),
      ref('att_c', 'a\u0000b\nc.txt', 'a/b/c/d/e/f'),
    ]);
    for (const p of paths.values()) {
      expect(p.split('/')).not.toContain('..');
      expect(p.split('/').some((s) => s.startsWith('.'))).toBe(false);
      expect([...p].some((c) => c.charCodeAt(0) < 0x20)).toBe(false);
    }
    expect(paths.get('att_a')).toBe('folder/folder/_.._etc_passwd');
    expect(paths.get('att_c')?.split('/')).toHaveLength(5);
  });
});

/** The server's bytes, by attachment id; counts fetches. */
class FilesApi {
  bytes = new Map<string, Buffer>();
  fetched: string[] = [];
  async fetchAttachment(_d: string, id: string): Promise<FetchedAttachment> {
    this.fetched.push(id);
    const b = this.bytes.get(id);
    if (!b) throw new Error('404');
    return {
      body: (async function* () {
        yield b;
      })(),
      size: b.length,
      sha256: sha(b),
    };
  }
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wb-files-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('FilesCache (FS-09)', () => {
  const fetcher = (bytes: Buffer, count: { n: number }) => async (path: string) => {
    count.n++;
    writeFileSync(path, bytes, { mode: 0o600 });
  };

  it('fetches a file once, keeps it private and read-only, and finds it again after a restart', async () => {
    const cache = new FilesCache({ root: join(root, 'cache') });
    const b = Buffer.from('a SketchUp model');
    const count = { n: 0 };
    const [one, two] = await Promise.all([
      cache.get({ sha256: sha(b), size: b.length }, fetcher(b, count)),
      cache.get({ sha256: sha(b), size: b.length }, fetcher(b, count)),
    ]);
    expect(count.n).toBe(1);
    expect(one?.path).toBe(two?.path);
    expect(readFileSync(one?.path as string, 'utf8')).toBe('a SketchUp model');
    expect(statSync(join(root, 'cache')).mode & 0o777).toBe(0o700);
    expect(statSync(one?.path as string).mode & 0o777).toBe(0o400);
    one?.release();
    two?.release();
    const again = new FilesCache({ root: join(root, 'cache') });
    await again.get({ sha256: sha(b), size: b.length }, fetcher(b, count));
    expect(count.n).toBe(1);
    expect(again.bytes).toBe(b.length);
  });

  it('refuses bytes of the wrong size and keeps nothing of them', async () => {
    const cache = new FilesCache({ root: join(root, 'cache') });
    const b = Buffer.from('twelve bytes');
    await expect(
      cache.get({ sha256: sha(b), size: b.length + 1 }, async (p) => writeFileSync(p, b)),
    ).rejects.toThrow(/wrong size/);
    expect(existsSync(cache.pathOf(sha(b)))).toBe(false);
    expect(cache.bytes).toBe(0);
  });

  it('evicts the least recently used files beyond its bound, never one a turn holds', async () => {
    let now = 1_000_000;
    const cache = new FilesCache({ root: join(root, 'cache'), maxBytes: 20, now: () => now });
    const put = async (text: string) => {
      const b = Buffer.from(text);
      now += 1000;
      return cache.get({ sha256: sha(b), size: b.length }, async (p) => writeFileSync(p, b));
    };
    const a = await put('aaaaaaaaaa'); // 10
    a.release();
    const b = await put('bbbbbbbbbb'); // 10, held
    const c = await put('cccccccccc'); // 10: a (least recently used) goes, b is held
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
    expect(existsSync(c.path)).toBe(true);
    // Used again: c is now newer than b; once b is let go, the next file evicts b.
    b.release();
    c.release();
    const c2 = await put('cccccccccc');
    c2.release();
    const d = await put('dddddddddd');
    d.release();
    expect(existsSync(b.path)).toBe(false);
    expect(existsSync(c.path)).toBe(true);
    expect(cache.bytes).toBe(20);
  });
});

function ctxWith(entries: FileRef[], extra: Partial<DispatchFiles> = {}) {
  return {
    ...testContext(),
    files: {
      conversationId: 'cnv_x',
      count: entries.length,
      totalBytes: entries.reduce((n, e) => n + e.size, 0),
      truncated: false,
      entries,
      ...extra,
    },
  };
}

describe('prepareConversationFiles (FS-09)', () => {
  it('a commands turn: a private tree of hardlinks into the cache, removed when the turn ends', async () => {
    const api = new FilesApi();
    const model = Buffer.from('model bytes');
    const notes = Buffer.from('notes');
    api.bytes.set('att_skp', model);
    api.bytes.set('att_txt', notes);
    const ctx = ctxWith([
      ref('att_skp', '1904Technischmodel.skp', 'Drawings', model),
      ref('att_txt', 'notes.txt', '', notes),
    ]);
    const cache = new FilesCache({ root: join(root, 'ws', '.files-cache') });
    const workspacesRoot = join(root, 'ws');
    const got = await prepareConversationFiles(ctx, {
      api: api as unknown as RunnerApi,
      cache,
      workspacesRoot,
    });
    expect(got?.dir).toBe(turnTreeDir(workspacesRoot, ctx));
    expect([...(got?.paths ?? [])]).toEqual([
      ['att_skp', 'Drawings/1904Technischmodel.skp'],
      ['att_txt', 'notes.txt'],
    ]);
    const placed = join(got?.dir as string, 'Drawings/1904Technischmodel.skp');
    expect(readFileSync(placed, 'utf8')).toBe('model bytes');
    // The same inode as the cache's file (read-only there; the commands get the tree read-only).
    expect(statSync(placed).ino).toBe(statSync(cache.pathOf(sha(model))).ino);
    expect(statSync(got?.dir as string).mode & 0o777).toBe(0o700);
    // A second turn needs no fetch.
    await got?.release();
    expect(existsSync(got?.dir as string)).toBe(false);
    await prepareConversationFiles(ctx, { api: api as unknown as RunnerApi, cache, workspacesRoot });
    expect(api.fetched.sort()).toEqual(['att_skp', 'att_txt']);
  });

  it('leaves out what doesn’t fit or can’t be fetched, and says which', async () => {
    const api = new FilesApi();
    const ok = Buffer.from('ok');
    const bad = Buffer.from('tampered');
    api.bytes.set('att_ok', ok);
    api.bytes.set('att_bad', bad);
    const logs: string[] = [];
    const big = { ...ref('att_big', 'huge.zip'), size: 300 * 1024 * 1024 };
    const got = await prepareConversationFiles(
      ctxWith([
        ref('att_ok', 'ok.txt', '', ok),
        { ...ref('att_bad', 'bad.txt', '', bad), sha256: 'f'.repeat(64) },
        big,
      ]),
      {
        api: api as unknown as RunnerApi,
        cache: new FilesCache({ root: join(root, 'cache') }),
        workspacesRoot: join(root, 'ws'),
        log: (_l, msg) => logs.push(msg),
      },
    );
    expect([...(got?.paths.keys() ?? [])]).toEqual(['att_ok']);
    expect(got?.unavailable.map((r) => r.id)).toEqual(['att_bad']);
    expect(got?.plan.left.map((l) => [l.ref.id, l.why])).toEqual([['att_big', 'too_large']]);
    expect(api.fetched).not.toContain('att_big');
    expect(logs.join('\n')).toMatch(/att_bad .*sha256/);
    expect(existsSync(join(got?.dir as string, 'bad.txt'))).toBe(false);
  });

  it('is null without Files, or without anything that fits', async () => {
    const deps = {
      api: new FilesApi() as unknown as RunnerApi,
      cache: new FilesCache({ root: join(root, 'cache') }),
      workspacesRoot: join(root, 'ws'),
    };
    expect(await prepareConversationFiles(testContext(), deps)).toBeNull();
    const big = { ...ref('att_big', 'huge.zip'), size: 300 * 1024 * 1024 };
    expect(await prepareConversationFiles(ctxWith([big]), deps)).toBeNull();
  });
});
