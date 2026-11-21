/**
 * Runtime gaps between Hermes and what `@whombat/core` / `@whombat/client` expect.
 *
 * - `crypto.getRandomValues`: Hermes has no Web Crypto. `@noble/hashes` (ids, client ids in the fixture
 *   world) reads `globalThis.crypto` at call time, so installing it before the first id is enough.
 * - `AbortSignal.prototype.throwIfAborted`, `AbortSignal.abort/timeout`: React Native's AbortSignal predates
 *   them; libp2p's Noise handshake (`p-event`) calls `signal.throwIfAborted()` (secure-channel ADR SC-05 names the
 *   same patch; found by the on-device harness, AP-25).
 * - zod's compiled parsers off (`jitless`), set before any schema is made (each reads it when it is made): on Hermes,
 *   which has no JIT, compiling a schema's parser with `new Function` cost ~2 ms the first time each object schema
 *   parsed, against ~0.08 ms interpreted, and the compiled one is barely faster after that (5 against 7 µs)
 *   (docs/app/decisions/ios-crypto-speed.md).
 * - `Intl` time zones: Hermes on Android implements `Intl.DateTimeFormat` with IANA zones and
 *   `formatToParts` through the platform ICU; `supportsTimeZones()` checks it once and the app falls back
 *   to the device zone when it is missing (see `src/lib/time.ts`).
 */
import { getRandomValues } from 'expo-crypto';
import { z } from 'zod';

z.config({ jitless: true });

type CryptoLike = { getRandomValues?: (array: ArrayBufferView) => ArrayBufferView };
const g = globalThis as unknown as { crypto?: CryptoLike };

if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = getRandomValues as unknown as CryptoLike['getRandomValues'];
}

type SignalLike = { aborted: boolean; reason?: unknown };
const AS = (globalThis as { AbortSignal?: { prototype: SignalLike & { throwIfAborted?: () => void } } })
  .AbortSignal;
if (AS && typeof AS.prototype.throwIfAborted !== 'function') {
  AS.prototype.throwIfAborted = function throwIfAborted(this: SignalLike) {
    if (!this.aborted) return;
    if (this.reason !== undefined) throw this.reason;
    const e = new Error('This operation was aborted');
    e.name = 'AbortError';
    throw e;
  };
}
type AbortSignalStatic = {
  abort?: (reason?: unknown) => unknown;
  timeout?: (ms: number) => unknown;
};
const ASS = AS as unknown as AbortSignalStatic | undefined;
if (ASS && typeof ASS.abort !== 'function') {
  ASS.abort = (reason?: unknown) => {
    const c = new AbortController();
    c.abort(reason);
    return c.signal;
  };
}
if (ASS && typeof ASS.timeout !== 'function') {
  ASS.timeout = (ms: number) => {
    const c = new AbortController();
    setTimeout(() => {
      const e = new Error('The operation timed out.');
      e.name = 'TimeoutError';
      c.abort(e);
    }, ms);
    return c.signal;
  };
}
