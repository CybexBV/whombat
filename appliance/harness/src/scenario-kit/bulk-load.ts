/**
 * Bulk load generator for scenario (g), run as its own process so its CPU (pure-JS Noise at tens of MiB/s) does
 * not share an event loop with the interactive measurement: a probe appliance that echoes, and N bulk-class
 * client sessions through the real relay that keep 64 KiB messages flowing both ways for `seconds`.
 *
 *   node bulk-load.ts '<json {identityDir, sessions, seconds, token, org}>'   → prints {bytes, seconds} JSON
 */
import { randomBytes } from 'node:crypto';
import { generateIdentity, openInitiator } from '@whombat/secure-channel';
import { nodeWebSocketByteStream } from '@whombat/secure-channel/node';
import { clientTicket } from './cloud.ts';
import { dial, loadDeviceKeys } from './device.ts';
import { echoProbe } from './probe.ts';
import { env } from './world.ts';

const cfg = JSON.parse(process.argv[2] ?? '{}') as {
  identityDir: string;
  sessions: number;
  seconds: number;
  token: string;
  org: string;
};
const keys = loadDeviceKeys(cfg.identityDir);
const probe = echoProbe(keys);
await probe.agent.ready;
const e = env();
const conns = await Promise.all(
  Array.from({ length: cfg.sessions }, async () => {
    const t = await clientTicket(e.control?.url ?? '', cfg.token, cfg.org, keys.deviceId, 'app', 'bulk');
    const { ws } = await dial(t.relay.url, { ticket: t.ticket, class: 'bulk' }, { waitReady: true });
    const stream = nodeWebSocketByteStream(ws as unknown as Parameters<typeof nodeWebSocketByteStream>[0]);
    return openInitiator({
      stream,
      identity: await generateIdentity(),
      expectedAppliancePeerId: keys.peerId,
    });
  }),
);
let stop = false;
let bytes = 0;
const chunk = randomBytes(64 * 1024 - 64);
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
const t0 = Date.now();
setTimeout(() => {
  stop = true;
}, cfg.seconds * 1000);
await Promise.allSettled(
  conns.map(async (c) => {
    const reader = (async () => {
      while (!stop) {
        const m = await c.receive().catch(() => null);
        if (!m) break;
        bytes += m.byteLength;
      }
    })();
    while (!stop)
      await c.send(chunk).catch(() => {
        stop = true;
      });
    c.abort();
    await reader;
  }),
);
process.stdout.write(`${JSON.stringify({ bytes, seconds: (Date.now() - t0) / 1000 })}\n`);
probe.close();
process.exit(0);
