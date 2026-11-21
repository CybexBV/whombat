import { createFakeAppliance } from '@whombat/client/fake';
import {
  type ApplianceSession,
  createSecureSession,
  type ResourceRef,
  type ResourceStream,
} from '@whombat/client/session';
import { sha256Hex } from '@whombat/core/audit';
import { describe, expect, it } from 'vitest';
import {
  clearResourceFiles,
  type FileApi,
  type FileHandleLike,
  fileChunkSource,
  rangeToFile,
  resourceToCacheFile,
} from './files';
import { deleteEndpointIdentity, loadOrCreateEndpointIdentity, type SecretStore } from './keys';

/** An in-memory file system with the expo-file-system handle semantics used here. */
function memoryFs() {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  let biggestRead = 0;
  const api: FileApi = {
    open(uri, mode) {
      if (mode === 'w') files.set(uri, new Uint8Array(0));
      const handle: FileHandleLike = {
        offset: 0,
        readBytes(length) {
          biggestRead = Math.max(biggestRead, length);
          const data = files.get(uri) ?? new Uint8Array(0);
          const at = handle.offset ?? 0;
          handle.offset = at + length;
          return data.slice(at, at + length);
        },
        writeBytes(bytes) {
          const data = files.get(uri) ?? new Uint8Array(0);
          const next = new Uint8Array(data.byteLength + bytes.byteLength);
          next.set(data);
          next.set(bytes, data.byteLength);
          files.set(uri, next);
        },
        close() {},
      };
      return handle;
    },
    exists: (uri) => files.has(uri),
    mkdir: (uri) => void dirs.add(uri),
    remove(uri) {
      files.delete(uri);
      for (const k of [...files.keys()]) if (k.startsWith(uri)) files.delete(k);
    },
    async move(from, to) {
      files.set(to, files.get(from) as Uint8Array);
      files.delete(from);
    },
    cacheDir: () => 'file:///cache/',
  };
  return { api, files, biggestRead: () => biggestRead };
}

const data = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 251);

describe('mobile files through the session', () => {
  it('uploads a local file in chunks read by offset, never the whole file', async () => {
    const fs = memoryFs();
    const bytes = data(700_000);
    fs.files.set('file:///picked/big.bin', bytes);
    let received: Uint8Array | null = null;
    const appliance = createFakeAppliance({
      handle: async () => ({ status: 200, body: {} }),
      completeUpload: async ({ bytes: b }) => {
        received = b;
        return { attachment: { id: 'att_x' } };
      },
    });
    const session = createSecureSession({ connector: appliance.connector, uploadChunkBytes: 128 * 1024 });
    const source = fileChunkSource(fs.api, {
      uri: 'file:///picked/big.bin',
      name: 'big.bin',
      type: '',
      size: bytes.byteLength,
    });
    const out = await session.upload({ burrow: 'b', attachmentId: 'att_x' }, source);
    source.close();
    session.close();
    expect(out).toEqual({ attachment: { id: 'att_x' } });
    expect(received && sha256Hex(received)).toBe(sha256Hex(bytes));
    expect(fs.biggestRead()).toBeLessThanOrEqual(128 * 1024);
  });

  it('streams a resource into a scoped cache file, reuses it, and clears every scope', async () => {
    const fs = memoryFs();
    const bytes = data(90_000);
    const appliance = createFakeAppliance({
      handle: async () => ({ status: 200, body: {} }),
      resources: async () => ({
        meta: { contentType: 'image/png', size: bytes.byteLength, name: 'a.png', sha256: null },
        bytes,
      }),
    });
    const session = createSecureSession({ connector: appliance.connector });
    const ref = { kind: 'attachment' as const, burrow: 'b', attachmentId: 'att_1' };
    const uri = await resourceToCacheFile(fs.api, session, ref, { scope: 'org/apl/acc/1', name: 'a.png' });
    expect(uri).toMatch(/^file:\/\/\/cache\/whombat-resources\/org_apl_acc_1\/.*a\.png$/);
    expect(sha256Hex(fs.files.get(uri) as Uint8Array)).toBe(sha256Hex(bytes));
    expect([...fs.files.keys()].some((k) => k.endsWith('.part'))).toBe(false);
    session.close();
    // Cached: no session needed the second time.
    expect(await resourceToCacheFile(fs.api, session, ref, { scope: 'org/apl/acc/1', name: 'a.png' })).toBe(
      uri,
    );
    clearResourceFiles(fs.api);
    expect(fs.files.size).toBe(0);
  });
});

describe('one range of a file into a file of its own', () => {
  /** A session serving `bytes` by range, sending `skew` bytes more (or fewer) than asked. */
  function ranged(bytes: Uint8Array, skew = 0) {
    return {
      async openResource(_ref: ResourceRef, o: { range?: { start: number; end?: number } } = {}) {
        const start = o.range?.start ?? 0;
        const end = Math.min(bytes.byteLength, (o.range?.end ?? bytes.byteLength) + skew);
        async function* chunks() {
          for (let at = start; at < end; at += 1000) yield bytes.slice(at, Math.min(at + 1000, end));
        }
        return {
          meta: { contentType: 'application/pdf', size: end - start, name: null, sha256: null },
          chunks: chunks(),
          cancel: () => {},
          summary: () => null,
        } satisfies ResourceStream;
      },
    } as unknown as ApplianceSession;
  }
  const ref = { kind: 'attachment' as const, burrow: 'b', attachmentId: 'att_pages1' };
  const where = { dir: 'file:///cache/shared/att_pages1/', target: 'file:///cache/shared/att_pages1/r.pdf' };

  it('writes exactly the range, through a part file', async () => {
    const fs = memoryFs();
    const bytes = data(9000);
    const uri = await rangeToFile(fs.api, ranged(bytes), ref, { start: 1234, end: 5678 }, where);
    expect(uri).toBe(where.target);
    expect(fs.files.get(uri)).toEqual(bytes.slice(1234, 5678));
    expect([...fs.files.keys()]).toEqual([where.target]);
  });

  it('refuses and removes a copy that came back short or longer', async () => {
    for (const skew of [-10, 10]) {
      const fs = memoryFs();
      await expect(
        rangeToFile(fs.api, ranged(data(9000), skew), ref, { start: 100, end: 2100 }, where),
      ).rejects.toThrow();
      expect(fs.files.size).toBe(0);
    }
  });
});

describe('endpoint key in the secure store', () => {
  it('is generated once, survives reloads, and can be forgotten', async () => {
    const saved = new Map<string, string>();
    const store: SecretStore = {
      get: async (k) => saved.get(k) ?? null,
      set: async (k, v) => void saved.set(k, v),
      remove: async (k) => void saved.delete(k),
    };
    const a = await loadOrCreateEndpointIdentity(store);
    const b = await loadOrCreateEndpointIdentity(store);
    expect(b.peerId).toBe(a.peerId);
    expect(a.peerId).toMatch(/^12D3KooW/);
    await deleteEndpointIdentity(store);
    const c = await loadOrCreateEndpointIdentity(store);
    expect(c.peerId).not.toBe(a.peerId);
  });
});
