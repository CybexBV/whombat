/**
 * On-device secure-session harness, host side (docs/decisions/app-managed.md AP-25; secure-channel ADR SC-05
 * runbook). One port, two roles:
 *
 * - `GET /peer` → the appliance PeerId to pin (and a wrong one, for the mismatch check);
 *   `POST /report` ← the app's result lines (printed; the process exits 0 when every line is ok, 1 otherwise);
 * - `wss…/v1/connect` → relay protocol v1 (hello → welcome → ready), then a real Noise XX responder
 *   (`@whombat/secure-channel` acceptResponder over `nodeWebSocketByteStream`) serving the fake appliance
 *   (`@whombat/client/fake`, session protocol v1) through `secureByteStream`.
 *
 *   pnpm --filter @whombat/mobile exec tsx scripts/device-harness/server.mts   (HARNESS_PORT, default 4799)
 *   adb reverse tcp:4799 tcp:4799
 */
import { createServer } from 'node:http';
import { createFakeAppliance } from '@whombat/client/fake';
import { sha256Hex } from '@whombat/core/audit';
import { RELAY_MAX_MESSAGE_BYTES } from '@whombat/protocol';
import { acceptResponder, generateIdentity, secureByteStream } from '@whombat/secure-channel';
import { nodeWebSocketByteStream } from '@whombat/secure-channel/node';
import { WebSocketServer } from 'ws';

const port = Number(process.env.HARNESS_PORT || 4799);
const RESOURCE_BYTES = 2 * 1024 * 1024;
const resource = Uint8Array.from({ length: RESOURCE_BYTES }, (_, i) => (i * 131 + 7) % 256);

const applianceKey = await generateIdentity();
const wrongKey = await generateIdentity();
const uploads: { bytes: number; sha256: string }[] = [];

const fake = createFakeAppliance({
  applianceId: applianceKey.peerId,
  maxDataBytes: 65536,
  handle: async (op) =>
    op === 'health.get'
      ? { status: 200, body: { ok: true, service: 'whombat-server', db: 'up' } }
      : { status: 404, body: { error: { code: 'not_found', message: op } } },
  resources: async () => ({
    meta: { contentType: 'application/octet-stream', size: RESOURCE_BYTES, name: 'big.bin', sha256: null },
    bytes: resource,
  }),
  completeUpload: async ({ bytes }) => {
    uploads.push({ bytes: bytes.byteLength, sha256: sha256Hex(bytes) });
    return { received: bytes.byteLength, sha256: sha256Hex(bytes) };
  },
});

const lines: { name: string; ok: boolean; detail: string }[] = [];

const http = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/peer') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        peerId: applianceKey.peerId,
        wrongPeerId: wrongKey.peerId,
        resourceSha256: sha256Hex(resource),
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/report') {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const line = JSON.parse(body) as { name: string; ok: boolean; detail: string; done?: boolean };
      res.writeHead(204).end();
      if (line.done) {
        const failed = lines.filter((l) => !l.ok);
        console.log(
          `HARNESS ${failed.length ? 'FAILED' : 'PASSED'} (${lines.length} checks, uploads ${JSON.stringify(uploads)})`,
        );
        setTimeout(() => process.exit(failed.length ? 1 : 0), 200);
        return;
      }
      lines.push(line);
      console.log(`${line.ok ? 'ok  ' : 'FAIL'} ${line.name}: ${line.detail}`);
    });
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http, path: '/v1/connect', maxPayload: RELAY_MAX_MESSAGE_BYTES });
wss.on('connection', (ws, req) => {
  if (ws.protocol !== 'whombat-relay.v1') {
    ws.close(4400, 'bad subprotocol');
    return;
  }
  ws.once('message', (data, isBinary) => {
    const hello = !isBinary ? (JSON.parse(String(data)) as { t?: string; ticket?: string }) : null;
    if (hello?.t !== 'hello' || !hello.ticket) {
      ws.close(4400, 'bad hello');
      return;
    }
    if (String(req.url).includes('ticket')) {
      ws.close(4400, 'ticket in the URL');
      return;
    }
    ws.send(
      JSON.stringify({
        t: 'welcome',
        v: 1,
        conn: `conn_${Date.now()}`,
        heartbeatMs: 20000,
        maxMessage: RELAY_MAX_MESSAGE_BYTES,
      }),
    );
    ws.send(JSON.stringify({ t: 'ready' }));
    const stream = nodeWebSocketByteStream(ws as never);
    acceptResponder({ stream, identity: applianceKey })
      .then((conn) => fake.serve(secureByteStream(conn), { endpointId: conn.remotePeerId, channel: 'app' }))
      .catch((error: unknown) => console.log(`(handshake refused: ${(error as Error).message})`));
  });
});

http.listen(port, '127.0.0.1', () =>
  console.log(`device harness on :${port}, appliance ${applianceKey.peerId}`),
);
