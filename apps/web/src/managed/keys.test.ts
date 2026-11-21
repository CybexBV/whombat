// @vitest-environment node
// Node's own WebCrypto and typed arrays: under jsdom a software key's bytes cross realms and fail to read back.
import 'fake-indexeddb/auto';
import { generateIdentity, serializeIdentity } from '@whombat/secure-channel';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EndpointKeyUnavailableError,
  endpointKeyStore,
  loadEndpointKey,
  loadOrCreateEndpointKey,
} from './keys';

/** The hosted app, the box's own address or Tailscale page, `localhost`. */
const SECURE_PAGE = { subtle: true };
/** A browser without WebCrypto (not a real secure page, but the rule's edge). */
const NO_WEBCRYPTO = { subtle: false };

beforeEach(() => {
  // Every test starts with a browser that has no key yet.
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** What a page refuses with, or null when it gives a key. */
async function refusal(run: Promise<unknown>) {
  try {
    await run;
    return null;
  } catch (e) {
    return e instanceof EndpointKeyUnavailableError ? e.reason : e;
  }
}

/** A software key as an older box's plain-HTTP page left it in this browser. */
async function plantSoftwareKey(slot = 'default'): Promise<void> {
  const software = serializeIdentity(await generateIdentity());
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('whombat-keys', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('endpoint');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction('endpoint', 'readwrite');
      t.objectStore('endpoint').put({ software, createdAt: new Date().toISOString() }, slot);
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => reject(t.error);
    };
  });
}

describe('where a page keeps its endpoint key', () => {
  it('uses non-extractable WebCrypto wherever the page has it, and nothing weaker without it', () => {
    expect(endpointKeyStore(SECURE_PAGE)).toBe('webcrypto');
    expect(endpointKeyStore(NO_WEBCRYPTO)).toBe('unavailable');
  });
});

describe('loadOrCreateEndpointKey', () => {
  it('makes a key script can’t read and gives the same one back', async () => {
    const key = await loadOrCreateEndpointKey({ page: SECURE_PAGE });
    expect(key.software).toBeUndefined();
    expect(key.identity.extractable).toBe(false);
    expect(() => serializeIdentity(key.identity)).toThrow();
    const again = await loadEndpointKey();
    expect(again?.peerId).toBe(key.peerId);
    expect(again?.identity.extractable).toBe(false);
    expect((await loadOrCreateEndpointKey({ page: SECURE_PAGE })).peerId).toBe(key.peerId);
  });

  it('refuses a page without WebCrypto and makes no key', async () => {
    expect(await refusal(loadOrCreateEndpointKey({ page: NO_WEBCRYPTO }))).toBe('unsupported');
    expect(await loadEndpointKey()).toBeNull();
  });

  it('refuses a software key an older page left, and keeps it until the person forgets this browser', async () => {
    await plantSoftwareKey();
    const weak = await loadEndpointKey();
    expect(weak?.software).toBe(true);
    expect(await refusal(loadOrCreateEndpointKey({ page: SECURE_PAGE }))).toBe('weakKey');
    expect(await refusal(loadOrCreateEndpointKey({ page: NO_WEBCRYPTO }))).toBe('weakKey');
    expect((await loadEndpointKey())?.peerId).toBe(weak?.peerId);
  });

  it('says a browser without WebCrypto Ed25519 is unsupported instead of failing', async () => {
    vi.spyOn(crypto.subtle, 'generateKey').mockRejectedValue(
      new DOMException('no Ed25519', 'NotSupportedError'),
    );
    expect(await refusal(loadOrCreateEndpointKey({ page: SECURE_PAGE }))).toBe('unsupported');
    expect(await loadEndpointKey()).toBeNull();
  });

  it('says a stored WebCrypto key is unsupported on a page that lost WebCrypto', async () => {
    await loadOrCreateEndpointKey({ page: SECURE_PAGE });
    expect(await refusal(loadOrCreateEndpointKey({ page: NO_WEBCRYPTO }))).toBe('unsupported');
  });

  it('keeps the screen’s key apart from the person’s', async () => {
    const own = await loadOrCreateEndpointKey({ page: SECURE_PAGE });
    const screen = await loadOrCreateEndpointKey({ slot: 'screen', page: SECURE_PAGE });
    expect(screen.peerId).not.toBe(own.peerId);
  });
});
