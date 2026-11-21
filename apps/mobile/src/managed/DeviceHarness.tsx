/**
 * On-device secure-session harness, app side (AP-25; secure-channel ADR SC-05 runbook). Built into debug
 * builds only when `EXPO_PUBLIC_WHOMBAT_HARNESS_URL` is set: runs the real client stack on this device — the
 * endpoint key in expo-secure-store, the relay dial over React Native's WebSocket, the Noise initiator pinned to
 * the harness appliance, session protocol v1 — and reports each check to the harness (`POST /report`).
 */

import type { ICryptoInterface } from '@libp2p/noise';
import { secureChannelPort } from '@whombat/client/secure-channel';
import {
  type ApplianceSession,
  createManagedConnector,
  createSecureSession,
  dialRelay,
} from '@whombat/client/session';
import { sha256Hex } from '@whombat/core/audit';
import { api } from '@whombat/core/contracts';
import type { Identity } from '@whombat/secure-channel';
import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { nativeChaCha20Poly1305 } from '../../modules/whombat-crypto';
import { Text } from '../theme/Text';
import { expoFileApi } from './expoFiles';
import { fileChunkSource, resourceToCacheFile } from './files';
import { loadOrCreateEndpointIdentity } from './keys';
import { nativeNoiseCrypto, selfTest } from './nativeCrypto';
import { secureStore } from './secureStore';

type Line = { name: string; ok: boolean; detail: string };

function sessionFor(
  base: string,
  identity: Identity,
  peerId: string,
  crypto?: ICryptoInterface,
): ApplianceSession {
  const relayUrl = `${base.replace(/^http/, 'ws')}/v1/connect`;
  return createSecureSession({
    connector: createManagedConnector({
      tickets: async () => ({ ticket: 'harness.ticket.value', relayUrl }),
      secure: secureChannelPort(crypto ? { crypto } : {}),
      identity: async () => identity,
      appliance: { peerId },
      channel: 'app',
    }),
    client: { build: 'harness', platform: 'android' },
    backoff: { initialMs: 200, maxMs: 1000 },
  });
}

function opened(session: ApplianceSession, ms = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    const check = () => {
      const s = session.state();
      if (s.status === 'open') {
        clearTimeout(timer);
        off();
        resolve();
      } else if (s.status === 'closed') {
        clearTimeout(timer);
        off();
        reject(new Error(s.reason));
      }
    };
    const off = session.onState(check);
    session.connect();
    check();
  });
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function run(base: string, report: (l: Line) => Promise<void>): Promise<void> {
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      await report({ name, ok: true, detail: await fn() });
    } catch (error) {
      await report({ name, ok: false, detail: String((error as Error)?.message ?? error) });
    }
  };
  const peer = (await (await fetch(`${base}/peer`)).json()) as {
    peerId: string;
    wrongPeerId: string;
    resourceSha256: string;
  };
  let identity: Identity | null = null;
  await check('random source', async () => {
    const a = new Uint8Array(32);
    crypto.getRandomValues(a);
    if (a.every((b) => b === 0)) throw new Error('all zero');
    return 'crypto.getRandomValues from expo-crypto';
  });
  await check('endpoint key in expo-secure-store', async () => {
    identity = await loadOrCreateEndpointIdentity(secureStore);
    const again = await loadOrCreateEndpointIdentity(secureStore);
    if (again.peerId !== identity.peerId) throw new Error('reloaded key differs');
    return identity.peerId;
  });
  if (!identity) return;
  const id: Identity = identity;
  await check('runtime globals', async () => {
    const g = globalThis as Record<string, unknown>;
    const names = [
      'EventTarget',
      'Event',
      'CustomEvent',
      'TextDecoder',
      'TextEncoder',
      'queueMicrotask',
      'structuredClone',
      'DOMException',
    ];
    const have = names.map((n) => `${n}:${typeof g[n]}`);
    const P = Promise as unknown as Record<string, unknown>;
    const A = AbortSignal as unknown as Record<string, unknown>;
    have.push(
      `Promise.withResolvers:${typeof P.withResolvers}`,
      `AbortSignal.any:${typeof A.any}`,
      `AbortSignal.timeout:${typeof A.timeout}`,
    );
    return have.join(' ');
  });
  await check('Noise XX in-process over memory streams', async () => {
    const { acceptResponder, generateIdentity, memoryByteStreamPair } = await import(
      '@whombat/secure-channel'
    );
    const other = await generateIdentity();
    const [a, b] = memoryByteStreamPair();
    const t0 = Date.now();
    const [client, server] = await Promise.all([
      secureChannelPort().openInitiator({ stream: a, identity: id, expectedAppliancePeerId: other.peerId }),
      acceptResponder({ stream: b, identity: other }),
    ]);
    const ms = Date.now() - t0;
    await Promise.all([client.close(), server.close()]);
    return `${ms} ms`;
  });
  await check('secure channel directly (relay dial + openInitiator)', async () => {
    const port = secureChannelPort();
    const t0 = Date.now();
    const seen: string[] = [];
    const stream = await dialRelay(
      (u, p) => {
        const ws = new WebSocket(u, p);
        ws.addEventListener('message', (ev: { data: unknown }) => {
          seen.push(
            typeof ev.data === 'string'
              ? `text:${ev.data.length}`
              : `${Object.prototype.toString.call(ev.data)}:${(ev.data as ArrayBuffer).byteLength}`,
          );
        });
        (globalThis as { __harnessSeen?: string[] }).__harnessSeen = seen;
        return ws as never;
      },
      {
        url: `${base.replace(/^http/, 'ws')}/v1/connect`,
        ticket: 'harness.ticket.value',
        class: 'interactive',
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      },
      (socket, welcome) => port.byteStream(socket, { maxMessageBytes: welcome.maxMessage }),
    );
    try {
      const conn = await port.openInitiator({ stream, identity: id, expectedAppliancePeerId: peer.peerId });
      await conn.close();
      return `${Date.now() - t0} ms, remote ${conn.remotePeerId.slice(0, 16)}…`;
    } catch (error) {
      const chain: string[] = [];
      let e: unknown = error;
      for (let i = 0; e && i < 6; i++) {
        const x = e as { name?: string; code?: string; message?: string; stack?: string; cause?: unknown };
        chain.push(
          `${typeof e}/${(e as object)?.constructor?.name}/${x.name}/${x.code}: ${x.message} ${JSON.stringify(e)?.slice(0, 200)} @ ${x.stack?.split('\n').slice(1, 3).join(' | ')}`,
        );
        e = x.cause;
      }
      throw new Error(`${chain.join(' <- ')} · received ${seen.join(',')}`);
    }
  });
  const handshakes: number[] = [];
  await check('handshakes (relay dial + Noise XX pinned + hello/welcome)', async () => {
    for (let i = 0; i < 8; i++) {
      const s = sessionFor(base, id, peer.peerId);
      const t0 = Date.now();
      await opened(s);
      handshakes.push(Date.now() - t0);
      s.close();
    }
    const p95 = percentile(handshakes, 95);
    if (p95 >= 1000) throw new Error(`p95 ${p95} ms`);
    return `p50 ${percentile(handshakes, 50)} ms, p95 ${p95} ms (n=${handshakes.length})`;
  });
  const transfers = async (label: string, crypto?: ICryptoInterface) => {
    const session = sessionFor(base, id, peer.peerId, crypto);
    await check(`request (health.get) ${label}`, async () => {
      const r = await session.call(api.health.get, { params: {}, query: {}, body: undefined });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      return JSON.stringify(r.body);
    });
    await check(`download 2 MiB into a cache file (credit flow, sha256) ${label}`, async () => {
      const t0 = Date.now();
      const uri = await resourceToCacheFile(
        expoFileApi,
        session,
        { kind: 'attachment', burrow: 'b', attachmentId: 'att_harness' },
        {
          scope: 'harness',
          name: `big-${Date.now()}.bin`,
        },
      );
      const ms = Date.now() - t0;
      const handle = expoFileApi.open(uri, 'r');
      const bytes = handle.readBytes(2 * 1024 * 1024);
      handle.close();
      if (sha256Hex(bytes) !== peer.resourceSha256) throw new Error('hash mismatch');
      const rate = 2 / (ms / 1000);
      if (rate < 1) throw new Error(`${rate.toFixed(2)} MiB/s`);
      return `${ms} ms, ${rate.toFixed(2)} MiB/s`;
    });
    await check(`upload 1 MiB from a file by offset (chunk/chunk_ack, sha256) ${label}`, async () => {
      const uri = `${expoFileApi.cacheDir()}harness-upload.bin`;
      const out = expoFileApi.open(uri, 'w');
      const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 17 + 5) % 256);
      out.writeBytes(bytes);
      out.close();
      const source = fileChunkSource(expoFileApi, {
        uri,
        name: 'harness-upload.bin',
        type: '',
        size: bytes.byteLength,
      });
      const t0 = Date.now();
      const result = (await session.upload({ burrow: 'b', attachmentId: `att_up${Date.now()}` }, source)) as {
        sha256: string;
      };
      source.close();
      const ms = Date.now() - t0;
      if (result.sha256 !== sha256Hex(bytes)) throw new Error('hash mismatch at the appliance');
      const rate = 1 / (ms / 1000);
      if (rate < 1) throw new Error(`${rate.toFixed(2)} MiB/s`);
      return `${ms} ms, ${rate.toFixed(2)} MiB/s`;
    });
    session.close();
  };
  await transfers('· pure-JS Noise');
  const aead = nativeChaCha20Poly1305();
  const native = aead ? nativeNoiseCrypto(aead) : null;
  let nativeOk = false;
  await check('native ChaCha20-Poly1305 matches pure JS (Android javax.crypto)', async () => {
    if (!native) throw new Error('no native ChaCha20-Poly1305 on this device');
    const problem = selfTest(native);
    if (problem) throw new Error(problem);
    nativeOk = true;
    return 'interop both ways, tamper rejected';
  });
  if (nativeOk && native) await transfers('· native AEAD', native);
  await check('wrong appliance identity is refused before anything is sent', async () => {
    const s = sessionFor(base, id, peer.wrongPeerId);
    try {
      await opened(s, 15_000);
      throw new Error('connected to the wrong appliance');
    } catch (error) {
      const reason = (error as Error).message;
      if (reason !== 'identity_mismatch') throw new Error(`ended as ${reason}`);
      return 'identity_mismatch';
    } finally {
      s.close();
    }
  });
}

export function DeviceHarness({ url }: { url: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  useEffect(() => {
    const report = async (l: Line) => {
      setLines((all) => [...all, l]);
      await fetch(`${url}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(l),
      }).catch(() => {});
    };
    void run(url, report)
      .catch((error: unknown) => report({ name: 'harness', ok: false, detail: String(error) }))
      .finally(() =>
        fetch(`${url}/report`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'done', ok: true, detail: '', done: true }),
        }).catch(() => {}),
      );
  }, [url]);
  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 64 }}>
      <Text style={{ fontSize: 20, fontWeight: '700' }}>Secure session harness</Text>
      {lines.map((l) => (
        <Text key={l.name} style={{ marginTop: 8 }}>
          {l.ok ? 'ok' : 'FAIL'} · {l.name}: {l.detail}
        </Text>
      ))}
    </ScrollView>
  );
}
