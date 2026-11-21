/**
 * (h) Resumable uploads over the session's bulk connection (MA-08 streams, AP-13; assignment §14.4): a 20 MiB
 * upload with several chunks in flight (the client announces chunk N+1 before N's `chunk_ack`, bounded by credit),
 * and an upload whose bulk connection is killed halfway and resumes from the appliance's `received` offset. The
 * stored file is read back through a download stream and compared by sha256.
 */

import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ApplianceSession, RelaySocket } from '../src/scenario-kit/app-client.ts';
import { gap, measure, note } from '../src/scenario-kit/report.ts';
import { ensureSlice, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import { api, ensureWorkspace, type Workspace } from '../src/scenario-kit/work.ts';

let slice: SliceState;
let w: Workspace;

const MiB = 1024 * 1024;

function source(size: number, seed: Buffer) {
  return {
    name: 'harness.bin',
    type: 'application/octet-stream',
    size,
    read: async (offset: number, length: number) => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; ) {
        const at = (offset + i) % seed.length;
        const n = Math.min(length - i, seed.length - at);
        out.set(seed.subarray(at, at + n), i);
        i += n;
      }
      return out;
    },
  };
}

async function sha256Of(src: ReturnType<typeof source>): Promise<string> {
  const h = createHash('sha256');
  for (let o = 0; o < src.size; o += MiB) h.update(await src.read(o, Math.min(MiB, src.size - o)));
  return h.digest('hex');
}

interface Uploadable {
  upload(
    target: unknown,
    source: unknown,
    options?: { onProgress?: (p: { sent: number; total: number }) => void },
  ): Promise<unknown>;
  openResource(
    ref: unknown,
  ): Promise<{ meta: { size: number | null; sha256: string | null }; chunks: AsyncIterable<Uint8Array> }>;
}

async function reserve(s: ApplianceSession, size: number): Promise<string> {
  const r = await api<{ attachment: { id: string } }>(s, 'uploads.create', 'POST', {
    params: { burrow: w.slug },
    body: {
      conversationId: w.conversationId,
      name: 'harness.bin',
      contentType: 'application/octet-stream',
      size,
    },
  });
  return r.attachment.id;
}

async function download(
  s: ApplianceSession,
  attachmentId: string,
): Promise<{ sha256: string; size: number }> {
  const res = await (s as unknown as Uploadable).openResource({
    kind: 'attachment',
    burrow: w.slug,
    attachmentId,
    download: true,
  });
  const h = createHash('sha256');
  let size = 0;
  for await (const c of res.chunks) {
    h.update(c);
    size += c.byteLength;
  }
  return { sha256: h.digest('hex'), size };
}

beforeAll(async () => {
  slice = await ensureSlice();
  const { session } = await ownerSession(slice);
  w = await ensureWorkspace(session, `Uploads ${randomBytes(3).toString('hex')}`);
  session.close('closed');
});

describe('h resumable uploads', () => {
  it('20 MiB with chunks in flight (pipelined within credit), read back by sha256', async (ctx) => {
    const { session } = await ownerSession(slice);
    const src = source(20 * MiB, randomBytes(MiB));
    const whole = await sha256Of(src);
    const id = await reserve(session, src.size);
    const t0 = Date.now();
    const out = await (session as unknown as Uploadable)
      .upload({ burrow: w.slug, attachmentId: id }, src)
      .catch((err: Error & { code?: string }) => {
        gap(ctx, 'Whombat/managed-runtime', `pipelined upload refused: ${err.code ?? ''} ${err.message}`);
        throw err;
      });
    const secs = (Date.now() - t0) / 1000;
    const back = await download(session, id);
    measure(ctx, '20 MiB session upload (bulk connection)', {
      seconds: secs,
      MiBps: Math.round((20 / secs) * 10) / 10,
    });
    note(ctx, 'upload', { output: out, download: back });
    expect(back.size).toBe(src.size);
    expect(back.sha256).toBe(whole);
    session.close('closed');
  });

  it('an upload interrupted halfway (bulk connection killed) resumes from the stored offset', async (ctx) => {
    const sockets: RelaySocket[] = [];
    const { session } = await ownerSession(slice, {
      onSocket: (x) => sockets.push(x),
      backoff: { baseMs: 100, maxMs: 1000 },
    });
    const src = source(16 * MiB, randomBytes(MiB));
    const whole = await sha256Of(src);
    const id = await reserve(session, src.size);
    let killedAt = -1;
    const acked: number[] = [];
    const interactive = sockets.length;
    const out = await (session as unknown as Uploadable)
      .upload({ burrow: w.slug, attachmentId: id }, src, {
        onProgress: (p) => {
          acked.push(p.sent);
          if (killedAt < 0 && p.sent >= src.size / 2) {
            killedAt = p.sent;
            // The bulk connection is the one opened after the interactive one.
            for (const x of sockets.slice(interactive))
              if (x.readyState === 1) x.close(4000, 'harness: kill bulk mid-upload');
          }
        },
      })
      .catch((err: Error & { code?: string }) => {
        gap(
          ctx,
          'Whombat/managed-runtime + whombat-app/client',
          `interrupted upload did not resume: ${err.code ?? ''} ${err.message}`,
        );
        throw err;
      });
    const back = await download(session, id);
    const restartedFrom = acked.find((v, i) => i > 0 && v < (acked[i - 1] ?? 0)) ?? null;
    note(ctx, 'interrupted upload', {
      killedAt,
      acks: acked.length,
      restartedFrom,
      output: out,
      download: back,
    });
    expect(killedAt).toBeGreaterThan(0);
    // One progress report per acknowledged chunk plus one per (re)open: more than chunks + 1 means it reopened and
    // resumed; never going backwards means it resumed from the stored offset, not from zero.
    const chunks = Math.ceil(src.size / (256 * 1024));
    expect(acked.length).toBeGreaterThan(chunks + 1);
    expect(restartedFrom).toBeNull();
    expect(back.size).toBe(src.size);
    expect(back.sha256).toBe(whole);
    session.close('closed');
  });
});
