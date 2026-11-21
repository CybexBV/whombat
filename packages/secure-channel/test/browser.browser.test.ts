import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { type Browser, type BrowserType, chromium, firefox, webkit } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptResponder,
  generateIdentity,
  type Identity,
  openInitiator,
  webSocketByteStream,
} from '../src/index.js';
import { openWs, startSpliceRelay } from './support.js';

/**
 * Browser <-> Node interop: the package bundled for the browser runs in real Playwright browsers and
 * connects through the splice relay to a Node responder. Browsers that cannot launch on this host are
 * reported as skipped, never as passed.
 */

const entry = fileURLToPath(new URL('./browser/entry.ts', import.meta.url));

async function bundle(minify: boolean): Promise<string> {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify,
    write: false,
    legalComments: 'none',
  });
  return out.outputFiles[0]?.text ?? '';
}

async function canLaunch(type: BrowserType): Promise<string | undefined> {
  try {
    const b = await type.launch();
    await b.close();
    return undefined;
  } catch (err) {
    const lines = (err as Error).message.split('\n').map((l) => l.replace(/[║╔╗╚╝═]/g, '').trim());
    return (
      lines
        .filter((l) => l && !l.startsWith('browserType.launch'))
        .slice(0, 2)
        .join(' ') || 'cannot launch'
    );
  }
}

const engines = { chromium, firefox, webkit } as const;
const availability: Record<string, string | undefined> = {};
for (const [name, type] of Object.entries(engines)) availability[name] = await canLaunch(type);

let relay: Awaited<ReturnType<typeof startSpliceRelay>>;
let http: Server;
let pageUrl: string;
let appliance: Identity;
const received = new Map<string, number>();
const clientsSeen = new Map<string, string>();
let sid = 0;

/** Appliance side: accept one session on `sid`, echo every message, record what arrived. */
async function serveOne(session: string, mode: 'echo' | 'push-close' = 'echo'): Promise<void> {
  const ws = await openWs(`${relay.url}/a/${session}`);
  try {
    const conn = await acceptResponder({ stream: webSocketByteStream(ws as never), identity: appliance });
    clientsSeen.set(session, conn.remotePeerId);
    if (mode === 'push-close') {
      // One message and an immediate close, right after the handshake: the message, the CLOSE record and the
      // WebSocket close reach the browser while its handshake call may still be returning.
      void conn.send(new TextEncoder().encode('pushed'));
      await conn.close();
      return;
    }
    for await (const m of conn) {
      received.set(session, (received.get(session) ?? 0) + m.byteLength);
      await conn.send(m);
    }
  } catch {
    // mismatch tests end the session from the client side
  }
}

beforeAll(async () => {
  appliance = await generateIdentity();
  relay = await startSpliceRelay({ maxPayload: 262_144 });
  const js = await bundle(true);
  http = createServer((req, res) => {
    if (req.url === '/harness.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(js);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><meta charset="utf-8"><script src="/harness.js"></script>');
    }
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  pageUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await relay?.close();
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
});

describe('bundle', () => {
  it('bundles for the browser without Node built-ins and records the size', async () => {
    const min = await bundle(true);
    const gz = gzipSync(min).byteLength;
    console.info(
      `browser bundle (harness incl. package): ${(min.length / 1024).toFixed(1)} KiB min, ${(gz / 1024).toFixed(1)} KiB min+gzip`,
    );
    expect(min).not.toMatch(/require\("node:|from"node:/);
    expect(gz).toBeLessThan(200 * 1024);
  });
});

for (const [name, type] of Object.entries(engines)) {
  const reason = availability[name];
  describe.skipIf(reason !== undefined)(`${name}${reason ? ` (skipped: ${reason})` : ''}`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await type.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    const runInPage = async (
      opts: Record<string, unknown>,
      page?: import('playwright').Page,
      mode: 'echo' | 'push-close' = 'echo',
    ) => {
      const p = page ?? (await (await browser.newContext()).newPage());
      if (!page) await p.goto(pageUrl);
      const session = `${name}-${++sid}`;
      const serving = serveOne(session, mode);
      const result = (await p.evaluate(
        (o) =>
          (
            globalThis as never as { secureChannelHarness: { run: (x: unknown) => Promise<unknown> } }
          ).secureChannelHarness.run(o),
        { ...opts, url: `${relay.url}/c/${session}` },
      )) as Record<string, unknown>;
      await Promise.race([serving, new Promise((r) => setTimeout(r, 2000))]);
      return { result, session, page: p };
    };

    it('software identity: handshake, pinning and echo incl. max-size messages and 8 MiB bulk', async () => {
      const { result, session } = await runInPage({
        identity: 'software',
        expectedPeerId: appliance.peerId,
        messages: [1, 100, 16_384, 65_514],
        bulkBytes: 8 * 1024 * 1024,
      });
      expect(result.ok).toBe(true);
      expect(result.remotePeerId).toBe(appliance.peerId);
      expect(clientsSeen.get(session)).toBe(result.myPeerId);
      console.info(
        `${name}: handshake ${(result.handshakeMs as number).toFixed(1)} ms, 8 MiB echo ${(result.bulkMs as number).toFixed(0)} ms`,
      );
    });

    it('non-extractable WebCrypto identity persists in IndexedDB across a reload', async () => {
      const first = await runInPage({
        identity: 'webcrypto-new',
        expectedPeerId: appliance.peerId,
        messages: [42],
      });
      expect(first.result.ok).toBe(true);
      expect(first.result.extractable).toBe(false);
      expect(clientsSeen.get(first.session)).toBe(first.result.myPeerId);
      await first.page.reload();
      const second = await runInPage(
        { identity: 'webcrypto-stored', expectedPeerId: appliance.peerId, messages: [7] },
        first.page,
      );
      expect(second.result.ok).toBe(true);
      expect(second.result.myPeerId).toBe(first.result.myPeerId);
      expect(clientsSeen.get(second.session)).toBe(first.result.myPeerId);
    });

    it('appliance sends one message and closes right after the handshake: delivered, then a clean end (N-4)', async () => {
      const page = await (await browser.newContext()).newPage();
      await page.goto(pageUrl);
      for (let i = 0; i < 10; i++) {
        const { result } = await runInPage(
          { identity: 'webcrypto-new', expectedPeerId: appliance.peerId, messages: [], readPushed: true },
          page,
          'push-close',
        );
        expect(result).toEqual({ ok: true, pushed: ['pushed'], end: 'clean', closed: 'clean' });
      }
    });

    it('browser appliance: a client that sends and closes in one burst loses nothing (EOF hold, N-4)', async () => {
      const page = await (await browser.newContext()).newPage();
      await page.goto(pageUrl);
      type H = {
        secureChannelHarness: { prepareResponder(): Promise<string>; respond(o: unknown): Promise<unknown> };
      };
      for (let i = 0; i < 10; i++) {
        const peerId = await page.evaluate(() =>
          (globalThis as never as H).secureChannelHarness.prepareResponder(),
        );
        const session = `${name}-resp-${++sid}`;
        const client = await generateIdentity();
        const fast = (async () => {
          const ws = await openWs(`${relay.url}/c/${session}`);
          const c = await openInitiator({
            stream: webSocketByteStream(ws as never),
            identity: client,
            expectedAppliancePeerId: peerId,
          });
          for (const m of ['one', 'two', 'three']) void c.send(new TextEncoder().encode(m));
          await c.close();
        })();
        const result = await page.evaluate(
          (o) => (globalThis as never as H).secureChannelHarness.respond(o),
          { url: `${relay.url}/a/${session}` },
        );
        await fast;
        expect(result).toEqual({ ok: true, got: ['one', 'two', 'three'], closed: 'clean' });
      }
    });

    it('claim-card fingerprint pin works', async () => {
      const { fingerprint } = await import('../src/index.js');
      const { result } = await runInPage({
        identity: 'software',
        expectedFingerprint: fingerprint(appliance.peerId),
        messages: [5],
      });
      expect(result.ok).toBe(true);
    });

    it('wrong appliance PeerId -> PEER_MISMATCH, appliance receives no application byte', async () => {
      const other = await generateIdentity();
      const { result, session } = await runInPage({
        identity: 'software',
        expectedPeerId: other.peerId,
        messages: [10],
      });
      expect(result).toMatchObject({ ok: false, code: 'PEER_MISMATCH' });
      expect(received.get(session) ?? 0).toBe(0);
      expect(clientsSeen.has(session)).toBe(false);
    });
  });
}
