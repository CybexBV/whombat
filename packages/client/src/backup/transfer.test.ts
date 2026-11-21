import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { BACKUP_HEADER_BYTES, encodeBackupHeader } from '@whombat/core/backup';
import type { BackupUploadView } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { createClient } from '../http/client';
import { createFakeAppliance } from '../session/fake';
import { createSecureSession } from '../session/secure';
import {
  type ApplianceSession,
  type ChunkSource,
  type ResourceRef,
  type ResourceStream,
  StreamError,
} from '../session/types';
import { checkBackupFile, downloadBackupFile, uploadBackupFile } from './transfer';

/** A file that starts like a backup file: a real header, then filler. */
function backupBytes(size: number): Uint8Array {
  const header = encodeBackupHeader({
    kdf: { memoryKiB: 64, passes: 1, parallelism: 1 },
    salt: new Uint8Array(16).fill(1),
    chunkBytes: 65_536,
    noncePrefix: new Uint8Array(16).fill(2),
    keyCheck: new Uint8Array(16).fill(3),
  });
  const bytes = new Uint8Array(size).map((_, i) => (i * 7) % 251);
  bytes.set(header, 0);
  return bytes;
}

function sourceOf(bytes: Uint8Array, name = 'lumio-bv-2026-10-11.wbk'): ChunkSource {
  return {
    name,
    type: 'application/vnd.whombat.backup',
    size: bytes.byteLength,
    read: async (o, l) => bytes.slice(o, o + l),
  };
}

function memorySink() {
  const parts: Uint8Array[] = [];
  const sink = {
    closed: false,
    aborted: false,
    write: (c: Uint8Array) => {
      parts.push(c.slice());
    },
    close: () => {
      sink.closed = true;
    },
    abort: () => {
      sink.aborted = true;
    },
    bytes: () => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.byteLength;
      }
      return out;
    },
  };
  return sink;
}

/** A session whose `openResource` serves `bytes`, dropping the connection after `dropAfter` bytes of the first open. */
function streamingSession(bytes: Uint8Array, dropAfter: number | null) {
  const opens: { ref: ResourceRef; start: number }[] = [];
  const session = {
    transport: 'secure',
    async openResource(ref: ResourceRef, o: { range?: { start: number } } = {}): Promise<ResourceStream> {
      const start = o.range?.start ?? 0;
      opens.push({ ref, start });
      const drop = opens.length === 1 ? dropAfter : null;
      async function* chunks() {
        for (let at = start; at < bytes.byteLength; at += 1000) {
          if (drop !== null && at >= drop) throw new StreamError('lost', 'The connection dropped.');
          yield bytes.slice(at, Math.min(bytes.byteLength, at + 1000));
        }
      }
      return {
        meta: {
          contentType: 'application/vnd.whombat.backup',
          size: bytes.byteLength - start,
          name: null,
          sha256: null,
        },
        chunks: chunks(),
        cancel() {},
        summary: () => null,
      };
    },
  } as unknown as ApplianceSession;
  return { session, opens };
}

describe('downloading a backup file', () => {
  it('goes on from the bytes already written when the connection drops, and checks the whole file', async () => {
    const bytes = backupBytes(10_500);
    const { session, opens } = streamingSession(bytes, 4_000);
    const sink = memorySink();
    const seen: number[] = [];
    const done = await downloadBackupFile(
      session,
      {
        burrow: 'lumio',
        file: { id: 'bkf_aaaaaaaaaaaa', size: bytes.byteLength, sha256: bytesToHex(sha256(bytes)) },
      },
      sink,
      { retryMs: 1, onProgress: (p) => seen.push(p.done) },
    );
    expect(done).toEqual({ size: 10_500, sha256: bytesToHex(sha256(bytes)) });
    expect(opens.map((o) => o.start)).toEqual([0, 4_000]);
    expect(opens[0]?.ref).toEqual({ kind: 'backup-file', burrow: 'lumio', backupFileId: 'bkf_aaaaaaaaaaaa' });
    expect(sink.bytes()).toEqual(bytes);
    expect(sink.closed).toBe(true);
    expect(seen.at(-1)).toBe(10_500);
  });

  it('throws damaged and aborts the sink when the bytes aren’t the file’s', async () => {
    const bytes = backupBytes(3_000);
    const { session } = streamingSession(bytes, null);
    const sink = memorySink();
    const err = await downloadBackupFile(
      session,
      { burrow: 'lumio', file: { id: 'bkf_aaaaaaaaaaaa', size: 3_000, sha256: 'f'.repeat(64) } },
      sink,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'BackupFileError', code: 'damaged' });
    expect(sink.aborted).toBe(true);
    expect(sink.closed).toBe(false);
  });
});

describe('checking a chosen file', () => {
  it('refuses what isn’t a backup file before uploading a byte', async () => {
    await expect(checkBackupFile(sourceOf(backupBytes(1_000)))).resolves.toBeUndefined();
    await expect(
      checkBackupFile(sourceOf(new TextEncoder().encode('%PDF-1.7 not a backup'))),
    ).rejects.toMatchObject({
      code: 'not_backup_file',
    });
    await expect(checkBackupFile(sourceOf(backupBytes(1_000).slice(0, 40)))).rejects.toMatchObject({
      code: 'damaged',
    });
    const newer = backupBytes(1_000);
    newer[9] = 2; // container version 2
    await expect(checkBackupFile(sourceOf(newer))).rejects.toMatchObject({ code: 'newer_format' });
    expect(BACKUP_HEADER_BYTES).toBe(110);
  });
});

const view = (over: Partial<BackupUploadView>): BackupUploadView => ({
  id: 'bku_aaaaaaaaaaaa',
  fileName: 'lumio-bv-2026-10-11.wbk',
  size: 0,
  received: 0,
  status: 'uploading',
  sha256: null,
  createdAt: '2026-10-11T11:30:00.000Z',
  expiresAt: '2026-10-12T11:30:00.000Z',
  uploadUrl: '/api/v1/burrows/lumio/backup-uploads/bku_aaaaaaaaaaaa/content',
  chunkBytes: 4_000,
  maxChunkBytes: 16 * 1024 * 1024,
  ...over,
});

/** A `fetch` that answers each chunk PUT through `answer` (`network`: no answer at all). */
function _chunkFetch(
  answer: (put: {
    range: string;
    sha: string;
    bytes: Uint8Array;
  }) => { status: number; body: unknown } | 'network',
) {
  const puts: { url: string; range: string }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const range = headers.get('content-range') as string;
    const bytes = new Uint8Array(init.body as Uint8Array);
    puts.push({ url, range });
    expect(init.method).toBe('PUT');
    const a = answer({ range, sha: headers.get('x-whombat-sha256') as string, bytes });
    if (a === 'network') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body), { status: a.status });
  };
  return { fetch, puts };
}

describe('uploading a file to restore', () => {
  it('stages it and sends it through the resumable backup-file upload stream', async () => {
    const bytes = backupBytes(300_000);
    const ops: string[] = [];
    let stored: Uint8Array | null = null;
    const appliance = createFakeAppliance({
      handle: async (op) => {
        ops.push(op);
        if (op === 'backups.stage')
          return { status: 201, body: { upload: view({ size: bytes.byteLength }) } };
        if (op === 'backups.getUpload')
          return {
            status: 200,
            body: {
              upload: view({
                size: bytes.byteLength,
                received: stored?.byteLength ?? 0,
                status: stored ? 'uploaded' : 'uploading',
              }),
            },
          };
        return { status: 404, body: { error: { code: 'not_found', message: 'No.' } } };
      },
      completeUpload: async ({ bytes: arrived, target }) => {
        expect(target).toEqual({ type: 'backup-file', burrow: 'lumio', stagedBackupId: 'bku_aaaaaaaaaaaa' });
        stored = arrived;
        return {
          stagedBackupId: 'bku_aaaaaaaaaaaa',
          size: arrived.byteLength,
          sha256: bytesToHex(sha256(arrived)),
        };
      },
    });
    appliance.faults.dropUploadAfter(120_000);
    const session = createSecureSession({ connector: appliance.connector, uploadChunkBytes: 64 * 1024 });
    try {
      const client = createClient({ session, validateResponses: false });
      const done = await uploadBackupFile(client, 'lumio', sourceOf(bytes));
      expect(done.status).toBe('uploaded');
      expect(stored).toEqual(bytes);
      expect(ops).toEqual(['backups.stage', 'backups.getUpload']);
    } finally {
      session.close();
    }
  });

  it('downloads a ready file through the backup-file download stream', async () => {
    const bytes = backupBytes(70_000);
    const appliance = createFakeAppliance({
      handle: async () => ({ status: 404, body: { error: { code: 'not_found', message: 'No.' } } }),
      resources: async (ref) =>
        ref.kind === 'backup-file' && ref.backupFileId === 'bkf_aaaaaaaaaaaa'
          ? {
              meta: {
                contentType: 'application/vnd.whombat.backup',
                size: bytes.byteLength,
                name: 'x.wbk',
                sha256: null,
              },
              bytes,
            }
          : null,
    });
    const session = createSecureSession({ connector: appliance.connector });
    try {
      const sink = memorySink();
      await downloadBackupFile(
        session,
        {
          burrow: 'lumio',
          file: { id: 'bkf_aaaaaaaaaaaa', size: bytes.byteLength, sha256: bytesToHex(sha256(bytes)) },
        },
        sink,
      );
      expect(sink.bytes()).toEqual(bytes);
      const gone = await downloadBackupFile(
        session,
        { burrow: 'lumio', file: { id: 'bkf_bbbbbbbbbbbb', size: 1, sha256: null } },
        memorySink(),
      ).catch((e: unknown) => e);
      expect(gone).toMatchObject({ name: 'StreamError', code: 'not_found' });
    } finally {
      session.close();
    }
  });
});
