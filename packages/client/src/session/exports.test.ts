import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { createClient } from '../http/client';
import { createFakeAppliance } from './fake';
import { readExportFile } from './resources';
import { createSecureSession } from './secure';
import { type ResourceStream, StreamError } from './types';

const sha = (b: Uint8Array) => bytesToHex(sha256(b));

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65_536) crypto.getRandomValues(out.subarray(at, at + 65_536));
  return out;
}

function streamOf(bytes: Uint8Array, done: { size: number; sha256: string } | null): ResourceStream {
  let ended = false;
  return {
    meta: { contentType: 'application/gzip', size: bytes.byteLength, name: 'a.tar.gz', sha256: null },
    chunks: (async function* () {
      yield bytes.subarray(0, 1000);
      yield bytes.subarray(1000);
      ended = true;
    })(),
    cancel: () => {},
    summary: () => (ended ? done : null),
  };
}

describe('exports and large answers over the session (parity G-03)', () => {
  it('a file output goes through an export stream; the fake refuses it as a request, like the runtime', async () => {
    const seen: string[] = [];
    const appliance = createFakeAppliance({
      handle: async (op) => {
        seen.push(op);
        return op === 'audit.export'
          ? { status: 200, body: 'at,actor,kind\\n2026-09-26T10:00:00Z,Mara,Asks\\n' }
          : { status: 200, body: {} };
      },
    });
    const session = createSecureSession({ connector: appliance.connector });
    try {
      const client = createClient({ session, validateResponses: false });
      const csv = await client.audit.export({ params: { burrow: 'b' }, query: {} });
      expect(csv).toContain('at,actor,kind');
      const asRequest = await session.invoke(
        'audit.export',
        { params: { burrow: 'b' }, query: {} },
        { mutating: false },
      );
      expect(asRequest.status).toBe(400);
    } finally {
      session.close();
    }
  });

  it('a read too large for one message goes through a stream, and straight there the next time', async () => {
    const seen: string[] = [];
    const big = { notes: 'x'.repeat(70_000) };
    const appliance = createFakeAppliance({
      handle: async (op) => {
        seen.push(op);
        return { status: 200, body: op === 'me.get' ? big : {} };
      },
    });
    const session = createSecureSession({ connector: appliance.connector });
    try {
      const client = createClient({ session, validateResponses: false });
      expect(await client.me.get()).toEqual(big);
      // Asked as a request (refused as too large), then read through the stream.
      expect(seen.filter((op) => op === 'me.get')).toHaveLength(2);
      expect(await client.me.get()).toEqual(big);
      expect(seen.filter((op) => op === 'me.get')).toHaveLength(3);
    } finally {
      session.close();
    }
  });

  it('hashes streams with the hash it was given, and offers it to callers', async () => {
    let made = 0;
    const counted = () => {
      made++;
      return sha256.create();
    };
    const appliance = createFakeAppliance({
      handle: async () => ({ status: 200, body: 'at,actor,kind\n' }),
    });
    const session = createSecureSession({ connector: appliance.connector, sha256: counted });
    try {
      const client = createClient({ session, validateResponses: false });
      expect(await client.audit.export({ params: { burrow: 'b' }, query: {} })).toContain('at,actor');
      expect(made).toBe(1);
      expect(session.sha256).toBeDefined();
      session.sha256?.();
      expect(made).toBe(2);
    } finally {
      session.close();
    }
  });

  it('a file result needs stream_done and the size it announced; the stream checked the hash', async () => {
    const bytes = randomBytes(5000);
    const ok = await readExportFile(streamOf(bytes, { size: 5000, sha256: sha(bytes) }), 10_000);
    expect(ok.sha256).toBe(sha(bytes));
    expect(ok.name).toBe('a.tar.gz');
    await expect(
      readExportFile(streamOf(bytes, { size: 4999, sha256: sha(bytes) }), 10_000),
    ).rejects.toMatchObject({ code: 'integrity' });
    // A stream whose bytes didn't hash to `stream_done` has no summary (it failed with `integrity` itself).
    await expect(readExportFile(streamOf(bytes, null), 10_000)).rejects.toBeInstanceOf(StreamError);
    await expect(
      readExportFile(streamOf(bytes, { size: 5000, sha256: sha(bytes) }), 4000),
    ).rejects.toMatchObject({ code: 'too_large' });
  });
});
