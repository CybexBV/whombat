/**
 * Streams over the session (MA-08, MR-14): a chunked resumable upload (per-chunk and whole-file sha256, resume
 * after a dropped stream, a corrupt chunk refused), downloads (whole, range, credit flow control), exports (the audit
 * CSV, Settings → Skills read as one, CT-1418), and canvas collaboration bridged to the server's Yjs documents.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_MAX_OPEN_STREAMS } from '@whombat/protocol';
import { EXPORT_READ_OPS } from '@whombat/protocol/session';
import { fakeHermesSkills, HermesHomeService } from '@whombat/runner';
import { eq } from 'drizzle-orm';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { canvases } from '../db/schema/index';
import { previewPath } from '../files/previews';
import { filesDir } from '../files/service';
import { useHermesHome } from '../hermes-home/service';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { STREAM_RESET } from './ports';
import { LengthFramer } from './session/streams';

const m = useManagedRuntime({ seed: true });
let mara: Awaited<ReturnType<typeof m.enroll>>;

beforeAll(async () => {
  mara = await m.enroll(IDS.mara);
});

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const CHUNK = 65_536;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function reserve(c: Awaited<ReturnType<typeof m.client>>, name: string, size: number) {
  const r = await c.request('uploads.create', {
    params: { burrow: 'burrow-hq' },
    body: { conversationId: IDS.general, name, size, contentType: 'application/octet-stream' },
  });
  expect(r).toMatchObject({ t: 'result' });
  return (r as unknown as { output: { attachment: { id: string } } }).output.attachment.id;
}

describe('uploads and downloads', () => {
  const file = new Uint8Array(randomBytes(CHUNK * 2 + 1234));
  let attachmentId = '';

  it('allows only one stream to set up an upload of the same file at once', async () => {
    const c = await m.client(mara);
    const id = await reserve(c, 'concurrent.bin', file.length);
    const spec = {
      kind: 'upload' as const,
      target: { type: 'attachment' as const, burrow: 'burrow-hq', attachmentId: id },
      size: file.length,
      sha256: sha(file),
      chunkSize: CHUNK,
    };
    const attempts = await Promise.all([c.open(spec), c.open(spec)]);
    try {
      expect(attempts.filter((a) => a.answer.t === 'opened')).toHaveLength(1);
      expect(attempts.find((a) => a.answer.t === 'error')?.answer).toMatchObject({
        code: 'stream_refused',
        details: { code: 'conflict' },
      });
    } finally {
      c.close();
      await c.closed;
    }
  });

  it('keeps a cancelled upload reserved until its pending write has stopped', async () => {
    const c = await m.client(mara);
    const id = await reserve(c, 'cancel-during-write.bin', file.length);
    const spec = {
      kind: 'upload' as const,
      target: { type: 'attachment' as const, burrow: 'burrow-hq', attachmentId: id },
      size: file.length,
      sha256: sha(file),
      chunkSize: CHUNK,
    };
    const first = await c.open(spec);
    const entered = gate();
    const resume = gate();
    const barrier = vi.spyOn(m.t.services.maintenance, 'writeBarrier').mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
    });
    try {
      const bytes = file.subarray(0, CHUNK);
      c.send({ t: 'chunk', stream: first.stream, index: 0, offset: 0, size: CHUNK, sha256: sha(bytes) });
      c.write(first.stream, bytes);
      await entered.promise;
      c.frame({ type: 'reset', streamId: first.stream, code: STREAM_RESET.cancelled });
      c.send({ t: 'ping', n: 101 });
      await c.waitFor((message) => message.t === 'pong' && message.n === 101);
      const next = await c.open(spec);
      expect(next.answer).toMatchObject({ t: 'error', details: { code: 'conflict' } });
      resume.resolve();
      await vi.waitFor(async () => {
        const retried = await c.open(spec);
        expect(retried.answer).toMatchObject({ t: 'opened', meta: { received: 0 } });
      });
    } finally {
      resume.resolve();
      barrier.mockRestore();
      c.close();
      await c.closed;
    }
  });

  it('does not start an upload cancelled while its session permissions were being checked', async () => {
    const c = await m.client(mara);
    const id = await reserve(c, 'cancel-before-setup.bin', file.length);
    const entered = gate();
    const resume = gate();
    const recheck = m.runtime.trust.recheck.bind(m.runtime.trust);
    const permission = vi.spyOn(m.runtime.trust, 'recheck').mockImplementationOnce(async (principal) => {
      const result = await recheck(principal);
      entered.resolve();
      await resume.promise;
      return result;
    });
    const uploading = vi.spyOn(m.runtime.uploads, 'open');
    try {
      c.send({
        t: 'open',
        stream: 101,
        spec: {
          kind: 'upload',
          target: { type: 'attachment', burrow: 'burrow-hq', attachmentId: id },
          size: file.length,
          sha256: sha(file),
          chunkSize: CHUNK,
        },
      });
      await entered.promise;
      c.frame({ type: 'reset', streamId: 101, code: STREAM_RESET.cancelled });
      c.send({ t: 'ping', n: 101 });
      await c.waitFor((message) => message.t === 'pong' && message.n === 101);
      resume.resolve();
      await c.request('health.get', {});
      expect(uploading).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await Promise.allSettled(uploading.mock.results.map((result) => result.value));
      permission.mockRestore();
      uploading.mockRestore();
      c.close();
      await c.closed;
    }
  });

  it('frees an upload cancelled while its file resources were being acquired', async () => {
    const c = await m.client(mara);
    const id = await reserve(c, 'cancel-during-setup.bin', file.length);
    const spec = {
      kind: 'upload' as const,
      target: { type: 'attachment' as const, burrow: 'burrow-hq', attachmentId: id },
      size: file.length,
      sha256: sha(file),
      chunkSize: CHUNK,
    };
    const entered = gate();
    const resume = gate();
    const finished = gate();
    const open = m.runtime.uploads.open.bind(m.runtime.uploads);
    const setup = vi.spyOn(m.runtime.uploads, 'open').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resume.promise;
      try {
        return await open(...args);
      } finally {
        finished.resolve();
      }
    });
    try {
      c.send({ t: 'open', stream: 101, spec });
      await entered.promise;
      c.frame({ type: 'reset', streamId: 101, code: STREAM_RESET.cancelled });
      c.send({ t: 'ping', n: 101 });
      await c.waitFor((message) => message.t === 'pong' && message.n === 101);
      resume.resolve();
      await finished.promise;
      await vi.waitFor(async () => {
        const next = await c.open(spec);
        expect(next.answer).toMatchObject({ t: 'opened', meta: { received: 0 } });
      });
      expect(c.received.some((message) => message.t === 'opened' && message.stream === 101)).toBe(false);
    } finally {
      resume.resolve();
      setup.mockRestore();
      c.close();
      await c.closed;
    }
  });

  it('uploads in chunks, resumes after a dropped stream and refuses a corrupt chunk', async () => {
    const c = await m.client(mara);
    attachmentId = await reserve(c, 'data.bin', file.length);
    const target = { type: 'attachment' as const, burrow: 'burrow-hq', attachmentId };
    const spec = { kind: 'upload' as const, target, size: file.length, sha256: sha(file), chunkSize: CHUNK };
    const first = await c.open(spec);
    expect(first.answer).toMatchObject({
      t: 'opened',
      meta: { kind: 'upload', received: 0, chunkSize: CHUNK },
    });
    const chunk0 = file.subarray(0, CHUNK);
    c.send({ t: 'chunk', stream: first.stream, index: 0, offset: 0, size: CHUNK, sha256: sha(chunk0) });
    c.write(first.stream, chunk0);
    expect(await c.waitFor((x) => x.t === 'chunk_ack' && x.stream === first.stream)).toMatchObject({
      index: 0,
      received: CHUNK,
    });
    // The connection drops mid-upload.
    c.close();
    await c.closed;

    const d = await m.client(mara);
    const second = await d.open(spec);
    expect(second.answer).toMatchObject({ t: 'opened', meta: { received: CHUNK } });
    // A chunk whose bytes don't match its sha256 is refused and doesn't count.
    const chunk1 = file.subarray(CHUNK, CHUNK * 2);
    d.send({
      t: 'chunk',
      stream: second.stream,
      index: 1,
      offset: CHUNK,
      size: CHUNK,
      sha256: sha(file.subarray(0, CHUNK)),
    });
    d.write(second.stream, chunk1);
    expect(await d.readStream(second.stream)).toMatchObject({ reset: STREAM_RESET.integrity });

    const third = await d.open(spec);
    expect(third.answer).toMatchObject({ t: 'opened', meta: { received: CHUNK } });
    d.send({ t: 'chunk', stream: third.stream, index: 1, offset: CHUNK, size: CHUNK, sha256: sha(chunk1) });
    d.write(third.stream, chunk1);
    await d.waitFor((x) => x.t === 'chunk_ack' && x.stream === third.stream && x.index === 1);
    const last = file.subarray(CHUNK * 2);
    d.send({
      t: 'chunk',
      stream: third.stream,
      index: 2,
      offset: CHUNK * 2,
      size: last.length,
      sha256: sha(last),
    });
    d.write(third.stream, last);
    await d.waitFor((x) => x.t === 'chunk_ack' && x.stream === third.stream && x.index === 2);
    d.frame({ type: 'end', streamId: third.stream });
    const done = await d.waitFor((x) => x.t === 'stream_done' && x.stream === third.stream);
    expect(done).toMatchObject({
      size: file.length,
      sha256: sha(file),
      output: { attachment: { id: attachmentId } },
    });
    const sent = await d.request('messages.send', {
      params: { burrow: 'burrow-hq', conversationId: IDS.general },
      body: { text: 'with a file', attachmentIds: [attachmentId] },
    });
    expect(sent).toMatchObject({ t: 'result' });
  });

  it('does not exhaust stream capacity across sequential downloads', async () => {
    const c = await m.client(mara);
    try {
      for (let i = 0; i <= SESSION_MAX_OPEN_STREAMS; i++) {
        const download = await c.open({
          kind: 'download',
          resource: { type: 'attachment', burrow: 'burrow-hq', attachmentId, variant: 'original' },
          range: { start: 0, end: 1 },
        });
        expect(download.answer, `download ${i + 1}`).toMatchObject({ t: 'opened' });
        const got = await c.readStream(download.stream);
        // The shared client acknowledges the appliance's END with its own END.
        c.frame({ type: 'end', streamId: download.stream });
        expect(got.reset).toBeNull();
        expect(got.bytes).toEqual(file.subarray(0, 1));
      }
    } finally {
      c.close();
      await c.closed;
    }
  });

  it('downloads the whole file and a byte range', async () => {
    const c = await m.client(mara);
    const whole = await c.open({
      kind: 'download',
      resource: { type: 'attachment', burrow: 'burrow-hq', attachmentId, variant: 'original' },
    });
    expect(whole.answer).toMatchObject({
      t: 'opened',
      meta: { kind: 'download', size: file.length, sha256: sha(file) },
    });
    const got = await c.readStream(whole.stream);
    expect(got.reset).toBeNull();
    expect(sha(got.bytes)).toBe(sha(file));
    expect(await c.waitFor((x) => x.t === 'stream_done' && x.stream === whole.stream)).toMatchObject({
      size: file.length,
    });

    const part = await c.open({
      kind: 'download',
      resource: { type: 'attachment', burrow: 'burrow-hq', attachmentId, variant: 'original' },
      range: { start: 100, end: 200 },
    });
    expect(part.answer).toMatchObject({ meta: { range: { start: 100, end: 200 } } });
    expect(Buffer.from((await c.readStream(part.stream)).bytes)).toEqual(
      Buffer.from(file.subarray(100, 200)),
    );
    // A preview that doesn't exist is refused, never the original under another name.
    const preview = await c.open({
      kind: 'download',
      resource: { type: 'attachment', burrow: 'burrow-hq', attachmentId, variant: 'preview' },
    });
    expect(preview.answer).toMatchObject({
      t: 'error',
      code: 'stream_refused',
      details: { code: 'variant_unavailable' },
    });
  });

  it('refuses a download from a burrow that isn’t there', async () => {
    const c = await m.client(mara);
    const s = await c.open({
      kind: 'download',
      resource: { type: 'attachment', burrow: 'no-burrow', attachmentId, variant: 'original' },
    });
    expect(s.answer).toMatchObject({ t: 'error', code: 'stream_refused' });
  });
});

describe('pipelined uploads', () => {
  const SMALL = 65_536;
  /** Announces and sends chunks from `from` without waiting for acks (credit bounds what's in flight). */
  async function pipeline(
    c: Awaited<ReturnType<typeof m.client>>,
    stream: number,
    file: Uint8Array,
    from: number,
    until = file.length,
  ): Promise<number> {
    let maxInFlight = 0;
    for (let offset = from; offset < until; offset += SMALL) {
      const part = file.subarray(offset, Math.min(offset + SMALL, file.length));
      c.send({ t: 'chunk', stream, index: offset / SMALL, offset, size: part.length, sha256: sha(part) });
      await c.writeWithCredit(stream, part);
      const acked = c.received.filter((x) => x.t === 'chunk_ack' && x.stream === stream).length;
      maxInFlight = Math.max(maxInFlight, offset / SMALL + 1 - (from / SMALL + acked));
    }
    return maxInFlight;
  }

  it('accepts chunks announced before the previous is acknowledged (20 MiB, 64 KiB chunks)', {
    timeout: 120_000,
  }, async () => {
    const file = new Uint8Array(randomBytes(20 * 1024 * 1024));
    const c = await m.client(mara);
    const id = await reserve(c, 'big.bin', file.length);
    const target = { type: 'attachment' as const, burrow: 'burrow-hq', attachmentId: id };
    const up = await c.open({
      kind: 'upload',
      target,
      size: file.length,
      sha256: sha(file),
      chunkSize: SMALL,
    });
    expect(up.answer).toMatchObject({ t: 'opened', meta: { received: 0 } });
    const inFlight = await pipeline(c, up.stream, file, 0);
    expect(inFlight).toBeGreaterThan(1);
    c.frame({ type: 'end', streamId: up.stream });
    const done = await c.waitFor((x) => x.t === 'stream_done' && x.stream === up.stream, 60_000);
    expect(done).toMatchObject({ size: file.length, sha256: sha(file) });
    const acks = c.received.filter((x) => x.t === 'chunk_ack' && x.stream === up.stream) as {
      index: number;
    }[];
    expect(acks.map((a) => a.index)).toEqual(Array.from({ length: file.length / SMALL }, (_, i) => i));
    expect(c.streamReset.has(up.stream)).toBe(false);
  });

  it('resumes a pipelined upload cut off mid-flight, and refuses a non-contiguous announcement', {
    timeout: 120_000,
  }, async () => {
    const file = new Uint8Array(randomBytes(4 * 1024 * 1024 + 777));
    const c = await m.client(mara);
    const id = await reserve(c, 'resume.bin', file.length);
    const target = { type: 'attachment' as const, burrow: 'burrow-hq', attachmentId: id };
    const spec = { kind: 'upload' as const, target, size: file.length, sha256: sha(file), chunkSize: SMALL };
    const first = await c.open(spec);
    await pipeline(c, first.stream, file, 0, 2 * 1024 * 1024);
    // The connection drops while chunks are still in flight.
    c.close();
    await c.closed;
    const d = await m.client(mara);
    const again = await d.open(spec);
    const received = (again.answer as unknown as { meta: { received: number } }).meta.received;
    expect(received % SMALL).toBe(0);
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThanOrEqual(2 * 1024 * 1024);
    // Skipping ahead is a protocol error (the stream is reset and the upload freed for a new stream).
    d.send({
      t: 'chunk',
      stream: again.stream,
      index: received / SMALL + 1,
      offset: received + SMALL,
      size: SMALL,
      sha256: sha(file.subarray(0, SMALL)),
    });
    expect((await d.readStream(again.stream)).reset).toBe(STREAM_RESET.protocolError);
    const resumed = await d.open(spec);
    await pipeline(d, resumed.stream, file, received);
    d.frame({ type: 'end', streamId: resumed.stream });
    expect(
      await d.waitFor((x) => x.t === 'stream_done' && x.stream === resumed.stream, 60_000),
    ).toMatchObject({
      size: file.length,
      sha256: sha(file),
    });
  });
});

describe('previews', () => {
  it('derives a bounded thumbnail of a PNG, caches it by content, never sends the original', async () => {
    const png = new PNG({ width: 1200, height: 600 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = (i / 4) % 1200 < 600 ? 255 : 0;
      png.data[i + 1] = 40;
      png.data[i + 2] = 200;
      png.data[i + 3] = 255;
    }
    const bytes = new Uint8Array(PNG.sync.write(png));
    const c = await m.client(mara);
    const id = await reserve(c, 'wide.png', bytes.length);
    const target = { type: 'attachment' as const, burrow: 'burrow-hq', attachmentId: id };
    const up = await c.open({
      kind: 'upload',
      target,
      size: bytes.length,
      sha256: sha(bytes),
      chunkSize: 4 * 1024 * 1024,
    });
    c.send({ t: 'chunk', stream: up.stream, index: 0, offset: 0, size: bytes.length, sha256: sha(bytes) });
    c.write(up.stream, bytes);
    await c.waitFor((x) => x.t === 'chunk_ack' && x.stream === up.stream);
    c.frame({ type: 'end', streamId: up.stream });
    await c.waitFor((x) => x.t === 'stream_done' && x.stream === up.stream);

    const resource = {
      type: 'attachment' as const,
      burrow: 'burrow-hq',
      attachmentId: id,
      variant: 'preview' as const,
    };
    const first = await c.open({ kind: 'download', resource });
    expect(first.answer).toMatchObject({ t: 'opened', meta: { kind: 'download', contentType: 'image/png' } });
    const got = await c.readStream(first.stream);
    expect(sha(got.bytes)).not.toBe(sha(bytes));
    const thumb = PNG.sync.read(Buffer.from(got.bytes));
    expect([thumb.width, thumb.height]).toEqual([720, 360]);
    // The left half stays red-ish, the right blue-ish: a real downscale, not a crop.
    expect(thumb.data[0]).toBe(255);
    expect(thumb.data[(511 * 4) as number]).toBe(0);
    // Cached content-addressed; a second request serves the same bytes.
    const cached = previewPath(filesDir(m.t.services.config), sha(bytes), 'image/png');
    expect(existsSync(cached)).toBe(true);
    const second = await c.open({ kind: 'download', resource });
    expect(sha((await c.readStream(second.stream)).bytes)).toBe(sha(got.bytes));
  });
});

describe('exports', () => {
  it('streams the audit CSV as an export', async () => {
    const c = await m.client(mara);
    const refused = await c.request('audit.export', { params: { burrow: 'burrow-hq' } });
    // The code a client falls back on (MD-14), as for an answer too large for a message.
    expect(refused).toMatchObject({
      t: 'error',
      code: 'bad_request',
      details: { code: 'use_export_stream' },
    });
    const s = await c.open({
      kind: 'export',
      op: 'audit.export',
      input: { params: { burrow: 'burrow-hq' } },
    });
    expect(s.answer).toMatchObject({ t: 'opened', meta: { kind: 'export' } });
    const got = await c.readStream(s.stream);
    const csv = new TextDecoder().decode(got.bytes);
    expect(csv.split('\n')[0]).toMatch(/,/);
    expect(await c.waitFor((x) => x.t === 'stream_done' && x.stream === s.stream)).toMatchObject({
      size: got.bytes.length,
      sha256: sha(got.bytes),
    });
  });

  it('reads Settings → Skills through an export stream, during a drain too (CT-1418, review I-2)', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'wb-streams-skills-')), 'hermes');
    const fake = fakeHermesSkills({
      builtins: [
        {
          path: 'email/himalaya',
          files: { 'SKILL.md': '---\nname: himalaya\ndescription: Mail.\n---\nRead mail.\n' },
        },
      ],
    });
    const home = new HermesHomeService({ root, bin: '/bin/false', skillsSteps: fake });
    useHermesHome(m.t.services, home);
    await home.handle({ id: 'sync', method: 'skills.sync', params: {} });
    expect(EXPORT_READ_OPS).toContain('skills.library');
    const c = await m.client(mara);
    m.t.services.maintenance.drain('update', new Date());
    try {
      const s = await c.open({
        kind: 'export',
        op: 'skills.library',
        input: { params: { burrow: 'burrow-hq' } },
      });
      expect(s.answer).toMatchObject({ t: 'opened', meta: { kind: 'export' } });
      const got = await c.readStream(s.stream);
      const library = JSON.parse(new TextDecoder().decode(got.bytes)) as {
        items: { name: string; origin: string }[];
      };
      expect(library.items).toContainEqual(expect.objectContaining({ name: 'himalaya', origin: 'builtin' }));
    } finally {
      m.t.services.maintenance.resume();
    }
    // A refusal names its app code, which the app acts on (CT-21, CT-1419).
    const missing = await c.open({
      kind: 'export',
      op: 'skills.librarySkill',
      input: { params: { burrow: 'burrow-hq' }, query: { name: 'nothing-here', scope: 'everyone' } },
    });
    expect(missing.answer).toMatchObject({
      t: 'error',
      code: 'stream_refused',
      details: { code: 'not_found' },
    });
    fake.down.add('hub-search');
    const away = await c.open({
      kind: 'export',
      op: 'skills.hubSearch',
      input: { params: { burrow: 'burrow-hq' }, query: { q: 'pdf' } },
    });
    expect(away.answer).toMatchObject({
      t: 'error',
      code: 'stream_refused',
      details: { code: 'skill_hub_unavailable' },
    });
  });
});

describe('collaboration', () => {
  it('syncs a canvas through a session stream', async () => {
    const [canvas] = await m.t.services.db.select().from(canvases).limit(1);
    if (!canvas) throw new Error('the test world has no canvas');
    const c = await m.client(mara);
    const s = await c.open({ kind: 'collab', burrow: 'burrow-hq', canvasId: canvas.id });
    expect(s.answer).toMatchObject({ t: 'opened', meta: { kind: 'collab', readOnly: false } });
    const doc = new Y.Doc();
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, 0);
    syncProtocol.writeSyncStep1(step1, doc);
    c.write(s.stream, LengthFramer.encode(encoding.toUint8Array(step1)));
    // The appliance answers with its document state (sync step 2) and its own step 1.
    const framer = new LengthFramer();
    const deadline = Date.now() + 10_000;
    let synced = false;
    while (!synced && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const bytes = Buffer.concat(c.streamData.get(s.stream) ?? []);
      c.streamData.set(s.stream, []);
      for (const message of framer.push(new Uint8Array(bytes))) {
        const decoder = decoding.createDecoder(message);
        if (decoding.readVarUint(decoder) !== 0) continue;
        const reply = encoding.createEncoder();
        const kind = syncProtocol.readSyncMessage(decoder, reply, doc, 'server');
        if (kind === syncProtocol.messageYjsSyncStep2) synced = true;
      }
    }
    expect(synced).toBe(true);
    expect(doc.share.size + doc.store.clients.size).toBeGreaterThan(0);
    const [still] = await m.t.services.db.select().from(canvases).where(eq(canvases.id, canvas.id));
    expect(still).toBeTruthy();
  });
});
