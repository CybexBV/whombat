// Browser-side harness, bundled by esbuild (platform browser) and loaded into Playwright pages.
import {
  acceptResponder,
  fingerprint,
  generateIdentity,
  generateWebCryptoIdentity,
  type Identity,
  identityFromCryptoKeyPair,
  openInitiator,
  type SecureChannelError,
  webSocketByteStream,
} from '../../src/index.js';

async function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws error'));
  });
  return ws;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whombat-secure-channel-test', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('keys').objectStore('keys').get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function identityFor(kind: string): Promise<Identity> {
  if (kind === 'software') return generateIdentity();
  if (kind === 'webcrypto-new') {
    const { identity, keyPair } = await generateWebCryptoIdentity();
    await idbPut('endpoint', keyPair);
    return identity;
  }
  if (kind === 'webcrypto-stored') {
    const keyPair = await idbGet<CryptoKeyPair>('endpoint');
    if (!keyPair) throw new Error('no stored key');
    return identityFromCryptoKeyPair(keyPair);
  }
  throw new Error(`unknown identity kind ${kind}`);
}

export async function run(opts: {
  url: string;
  expectedPeerId?: string;
  expectedFingerprint?: string;
  identity: string;
  messages: number[];
  bulkBytes?: number;
  /** Read what the appliance pushes right after the handshake, until its close (review N-4). */
  readPushed?: boolean;
}): Promise<unknown> {
  const identity = await identityFor(opts.identity);
  const ws = await openSocket(opts.url);
  const t0 = performance.now();
  try {
    const conn = await openInitiator({
      stream: webSocketByteStream(ws),
      identity,
      ...(opts.expectedPeerId ? { expectedAppliancePeerId: opts.expectedPeerId } : {}),
      ...(opts.expectedFingerprint ? { expectedApplianceFingerprint: opts.expectedFingerprint } : {}),
    });
    const handshakeMs = performance.now() - t0;
    if (opts.readPushed) {
      const pushed: string[] = [];
      let end = 'clean';
      for (;;) {
        try {
          const m = await conn.receive();
          if (m === null) break;
          pushed.push(new TextDecoder().decode(m));
        } catch (err) {
          end = (err as SecureChannelError).code;
          break;
        }
      }
      return { ok: true, pushed, end, closed: (await conn.closed)?.code ?? 'clean' };
    }
    const echoes: number[] = [];
    for (const size of opts.messages) {
      const msg = new Uint8Array(size).map((_, i) => (i * 7 + size) & 0xff);
      await conn.send(msg);
      const back = await conn.receive();
      if (!back || back.byteLength !== size || back.some((b, i) => b !== msg[i]))
        throw new Error(`bad echo ${size}`);
      echoes.push(back.byteLength);
    }
    let bulkMs: number | undefined;
    const bulk = opts.bulkBytes ?? 0;
    if (bulk > 0) {
      const chunk = new Uint8Array(60_000);
      const b0 = performance.now();
      const sending = (async () => {
        for (let sent = 0; sent < bulk; sent += chunk.byteLength) await conn.send(chunk);
      })();
      let got = 0;
      while (got < bulk) got += (await conn.receive())?.byteLength ?? Number.NaN;
      await sending;
      bulkMs = performance.now() - b0;
    }
    await conn.close();
    return {
      ok: true,
      myPeerId: identity.peerId,
      extractable: identity.extractable,
      remotePeerId: conn.remotePeerId,
      remoteFingerprint: fingerprint(conn.remotePeerId),
      handshakeMs,
      echoes,
      bulkMs,
      subtleEd25519: identity.extractable === false,
    };
  } catch (err) {
    return { ok: false, code: (err as SecureChannelError).code, message: (err as Error).message };
  }
}

/**
 * The browser as responder (review N-4): a fast client sends its last handshake message, messages and its close
 * in one burst. Here the library verifies the client's signature with WebCrypto (`subtle.verify`, truly
 * asynchronous), so the transport's end arrives while the handshake is still running.
 */
let responderIdentity: Identity | undefined;

export async function prepareResponder(): Promise<string> {
  responderIdentity = await generateIdentity();
  return responderIdentity.peerId;
}

export async function respond(opts: { url: string }): Promise<unknown> {
  if (!responderIdentity) throw new Error('prepareResponder first');
  const ws = await openSocket(opts.url);
  try {
    const conn = await acceptResponder({ stream: webSocketByteStream(ws), identity: responderIdentity });
    const got: string[] = [];
    for await (const m of conn) got.push(new TextDecoder().decode(m));
    return { ok: true, got, closed: (await conn.closed)?.code ?? 'clean' };
  } catch (err) {
    return { ok: false, code: (err as SecureChannelError).code, message: (err as Error).message };
  }
}

(globalThis as { secureChannelHarness?: unknown }).secureChannelHarness = { run, prepareResponder, respond };
