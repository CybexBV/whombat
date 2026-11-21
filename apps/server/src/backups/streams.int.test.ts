/**
 * Backup files over the session (docs/decisions/backup-file.md BF-10, contracts CT-335): the person makes a file with the
 * secret op `backups.create`, downloads it with a `backup-file` download stream (whole and resumed by range), uploads it
 * to restore with `backups.stage` and a `backup-file` upload stream (resumable), and inspects it. A file gone after its
 * 24 hours is refused with `backup_file.expired`.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { backupFiles } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { backupsFor } from './service';

const m = useManagedRuntime({ seed: true });
let mara: Awaited<ReturnType<typeof m.enroll>>;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const PASSWORD = 'a long enough password';
const B = { burrow: 'burrow-hq' };

beforeAll(async () => {
  mara = await m.enroll(IDS.mara);
});

describe('backup files over the session', () => {
  let fileId = '';
  let bytes: Uint8Array = new Uint8Array(0);

  it('makes a file with the secret op and downloads it, whole and from a range', async () => {
    const c = await m.client(mara);
    const made = await c.request('backups.create', {
      params: B,
      body: { categories: ['agents', 'settings'], password: PASSWORD },
    });
    expect(made, JSON.stringify(made)).toMatchObject({ t: 'result' });
    fileId = (made as unknown as { output: { file: { id: string } } }).output.file.id;
    await backupsFor(m.t.services).settle();
    const got = await c.request('backups.get', { params: { ...B, backupFileId: fileId } });
    const file = (
      got as unknown as { output: { file: { status: string; size: number; sha256: string; name: string } } }
    ).output.file;
    expect(file.status).toBe('ready');

    const whole = await c.open({
      kind: 'download',
      resource: { type: 'backup-file', ...B, backupFileId: fileId },
    });
    expect(whole.answer).toMatchObject({
      t: 'opened',
      meta: {
        kind: 'download',
        size: file.size,
        sha256: file.sha256,
        contentType: 'application/vnd.whombat.backup',
        name: file.name,
      },
    });
    const all = await c.readStream(whole.stream);
    expect(all.reset).toBeNull();
    bytes = all.bytes;
    expect(sha(bytes)).toBe(file.sha256);

    const rest = await c.open({
      kind: 'download',
      resource: { type: 'backup-file', ...B, backupFileId: fileId },
      range: { start: 200, end: file.size },
    });
    expect(Buffer.from((await c.readStream(rest.stream)).bytes)).toEqual(Buffer.from(bytes.subarray(200)));
  });

  it('uploads it with a resumable stream and inspects it', async () => {
    const c = await m.client(mara);
    const staged = await c.request('backups.stage', {
      params: B,
      body: { fileName: 'back.wbk', size: bytes.length, sha256: sha(bytes) },
    });
    expect(staged, JSON.stringify(staged)).toMatchObject({ t: 'result' });
    const stagedBackupId = (staged as unknown as { output: { upload: { id: string } } }).output.upload.id;
    const CHUNK = 65_536;
    const spec = {
      kind: 'upload' as const,
      target: { type: 'backup-file' as const, ...B, stagedBackupId },
      size: bytes.length,
      sha256: sha(bytes),
      chunkSize: CHUNK,
    };
    const first = await c.open(spec);
    expect(first.answer).toMatchObject({ t: 'opened', meta: { kind: 'upload', received: 0 } });
    // One chunk, then the connection drops.
    const chunk0 = bytes.subarray(0, Math.min(CHUNK, bytes.length));
    c.send({
      t: 'chunk',
      stream: first.stream,
      index: 0,
      offset: 0,
      size: chunk0.length,
      sha256: sha(chunk0),
    });
    c.write(first.stream, chunk0);
    await c.waitFor((x) => x.t === 'chunk_ack' && x.stream === first.stream);
    c.close();
    await c.closed;

    const d = await m.client(mara);
    const second = await d.open(spec);
    const received = (second.answer as { meta: { received: number } }).meta.received;
    // It resumes after the last whole chunk that arrived (a file smaller than a chunk starts again).
    expect(received).toBe(chunk0.length - (chunk0.length % CHUNK));
    for (let offset = received, index = received / CHUNK; offset < bytes.length; offset += CHUNK, index++) {
      const part = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
      d.send({ t: 'chunk', stream: second.stream, index, offset, size: part.length, sha256: sha(part) });
      await d.writeWithCredit(second.stream, part);
      await d.waitFor((x) => x.t === 'chunk_ack' && x.stream === second.stream && x.index === index);
    }
    d.frame({ type: 'end', streamId: second.stream });
    const done = await d.waitFor((x) => x.t === 'stream_done' && x.stream === second.stream);
    expect(done).toMatchObject({ output: { stagedBackupId, size: bytes.length, sha256: sha(bytes) } });

    const preview = await d.request('backups.inspect', {
      params: { ...B, stagedBackupId },
      body: { password: PASSWORD },
    });
    expect(preview, JSON.stringify(preview)).toMatchObject({
      t: 'result',
      output: { sameBurrow: true, manifest: { format: 'whombat.backup-file/1' } },
    });
    const cats = (
      preview as unknown as { output: { categories: { id: string; here: number; new: number }[] } }
    ).output.categories;
    // Everything in it is here already: it came from this burrow.
    expect(cats.find((x) => x.id === 'agents')?.new).toBe(0);
    expect(cats.find((x) => x.id === 'agents')?.here).toBeGreaterThan(0);
  });

  it('takes a file without its whole sha256 up front and works it out itself (CT-1695)', async () => {
    const c = await m.client(mara);
    const staged = await c.request('backups.stage', {
      params: B,
      body: { fileName: 'unhashed.wbk', size: bytes.length },
    });
    const stagedBackupId = (staged as unknown as { output: { upload: { id: string } } }).output.upload.id;
    const CHUNK = 65_536;
    const opened = await c.open({
      kind: 'upload' as const,
      target: { type: 'backup-file' as const, ...B, stagedBackupId },
      size: bytes.length,
      chunkSize: CHUNK,
    });
    expect(opened.answer).toMatchObject({ t: 'opened', meta: { kind: 'upload', received: 0 } });
    for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK, index++) {
      const part = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
      c.send({ t: 'chunk', stream: opened.stream, index, offset, size: part.length, sha256: sha(part) });
      await c.writeWithCredit(opened.stream, part);
      await c.waitFor((x) => x.t === 'chunk_ack' && x.stream === opened.stream && x.index === index);
    }
    c.frame({ type: 'end', streamId: opened.stream });
    const done = await c.waitFor((x) => x.t === 'stream_done' && x.stream === opened.stream);
    expect(done).toMatchObject({ sha256: sha(bytes), output: { stagedBackupId, sha256: sha(bytes) } });
  });

  it('refuses a file past its 24 hours', async () => {
    await m.t.services.db
      .update(backupFiles)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(backupFiles.id, fileId));
    const c = await m.client(mara);
    const gone = await c.open({
      kind: 'download',
      resource: { type: 'backup-file', ...B, backupFileId: fileId },
    });
    expect(gone.answer).toMatchObject({
      t: 'error',
      code: 'stream_refused',
      details: { code: 'backup_file.expired' },
    });
  });
});
