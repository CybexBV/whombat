/**
 * (g) Performance (assignment §14 performance, R-76), measured locally — loopback, no TLS, one host shared with
 * other workloads, not a regional deployment. Every number is recorded with its conditions:
 *
 * 1. encrypted echo through the local relay: a probe appliance (Noise responder that echoes) behind the real relay,
 *    a Noise initiator client with a control ticket; 1 KiB messages;
 * 2. full stack request latency: `me.get` over the real session (client → relay → runtime → Postgres → back);
 * 3. bulk interference: interactive echo latency while a bulk session saturates both directions with 64 KiB
 *    messages (separate relay connections, MA-05); and a full-stack upload on the session's bulk connection while
 *    measuring `me.get`;
 * 4. reconnect storm: N clients drop at once and each reconnects (fresh control ticket, relay dial, Noise XX).
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { generateIdentity, openInitiator, type SecureConnection } from '@whombat/secure-channel';
import { nodeWebSocketByteStream } from '@whombat/secure-channel/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_DIR } from '../src/lib/paths.ts';
import { type ApplianceSession, whenOpen } from '../src/scenario-kit/app-client.ts';
import { clientTicket } from '../src/scenario-kit/cloud.ts';
import { dial } from '../src/scenario-kit/device.ts';
import { type EchoProbe, echoProbe, linkedProbe } from '../src/scenario-kit/probe.ts';
import { measure, percentiles } from '../src/scenario-kit/report.ts';
import { ensureSlice, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import { api } from '../src/scenario-kit/work.ts';
import { env, type Persona, persona } from '../src/scenario-kit/world.ts';

const ms = (t: bigint) => Number(t) / 1e6;
const conditions = {
  where:
    'local loopback, single host (shared with other workloads), no TLS, relay + control + runtime on one machine',
  target: 'assignment §14: <100 ms p95 warm regional encrypted echo is a regional target; not measured here',
};

let probe: EchoProbe;
let probeDeviceId = '';
let probePeer = '';
let tester: Persona;
let slice: SliceState;

async function echoClient(cls: 'interactive' | 'bulk'): Promise<SecureConnection> {
  const e = env();
  const t = await clientTicket(
    e.control?.url ?? '',
    tester.session.token,
    tester.org,
    probeDeviceId,
    'app',
    cls,
  );
  const { ws } = await dial(t.relay.url, { ticket: t.ticket, class: cls }, { waitReady: true });
  const stream = nodeWebSocketByteStream(ws as unknown as Parameters<typeof nodeWebSocketByteStream>[0]);
  return openInitiator({ stream, identity: await generateIdentity(), expectedAppliancePeerId: probePeer });
}

async function pingPong(c: SecureConnection, size: number, n: number): Promise<number[]> {
  const payload = randomBytes(size);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    await c.send(payload);
    const back = await c.receive();
    out.push(ms(process.hrtime.bigint() - t0));
    if (!back || back.byteLength !== size) throw new Error('echo mismatch');
  }
  return out;
}

beforeAll(async () => {
  // A new tester each run: the probes are boxes in its Whombat Link, and the free month takes two an account.
  const run = Date.now().toString(36);
  tester = await persona(`perf-${run}`, 'Perf tester');
  const { prov, keys } = await linkedProbe(`perf-${run}`, tester);
  probeDeviceId = prov.record.deviceId;
  probePeer = keys.peerId;
  probe = echoProbe(keys);
  await probe.agent.ready;
  slice = await ensureSlice();
}, 120_000);
afterAll(() => probe?.close());

describe('g performance (local)', () => {
  it('encrypted echo through the local relay (1 KiB, sequential and 20 concurrent sessions)', async (ctx) => {
    const c = await echoClient('interactive');
    await pingPong(c, 1024, 200); // warm-up
    const seq = percentiles(await pingPong(c, 1024, 2000));
    await c.close();
    const clients = await Promise.all(Array.from({ length: 20 }, () => echoClient('interactive')));
    const all = (await Promise.all(clients.map((x) => pingPong(x, 1024, 200)))).flat();
    for (const x of clients) await x.close();
    const conc = percentiles(all);
    measure(ctx, 'encrypted echo, sequential, 1 KiB', { ...seq, unit: 'ms', ...conditions, failures: 0 });
    measure(ctx, 'encrypted echo, 20 concurrent sessions, 1 KiB', {
      ...conc,
      unit: 'ms',
      ...conditions,
      failures: 0,
    });
    expect(seq.n).toBe(2000);
    expect(seq.p95).toBeLessThan(100);
  });

  it('full stack request latency (me.get over the real session)', async (ctx) => {
    const { session } = await ownerSession(slice);
    const one = async () => {
      const t0 = process.hrtime.bigint();
      const r = await api(session, 'me.get', 'GET');
      if (!r) throw new Error('no body');
      return ms(process.hrtime.bigint() - t0);
    };
    for (let i = 0; i < 50; i++) await one();
    const samples: number[] = [];
    let failures = 0;
    for (let i = 0; i < 1000; i++) {
      try {
        samples.push(await one());
      } catch {
        failures++;
      }
    }
    const p = percentiles(samples);
    measure(ctx, 'full-stack me.get (client → relay → runtime → Postgres)', {
      ...p,
      unit: 'ms',
      failures,
      ...conditions,
    });
    expect(failures).toBe(0);
    session.close('closed');
  });

  it('bulk traffic does not stall interactive traffic (separate connections; load in another process)', async (ctx) => {
    const inter = await echoClient('interactive');
    await pingPong(inter, 1024, 100);
    const idle = percentiles(await pingPong(inter, 1024, 500));
    // A second probe appliance and 4 bulk sessions in a separate process keep 64 KiB messages flowing both ways.
    const bulkProbe = await linkedProbe(`perf-bulk-${Date.now().toString(36)}`, tester);
    const seconds = 20;
    const child = spawn(
      process.execPath,
      [
        join(HARNESS_DIR, 'src/scenario-kit/bulk-load.ts'),
        JSON.stringify({
          identityDir: bulkProbe.prov.identityDir,
          sessions: 4,
          seconds,
          token: tester.session.token,
          org: tester.org,
        }),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'], env: process.env },
    );
    const lines: string[] = [];
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d: Buffer) => {
        lines.push(...d.toString().trim().split('\n'));
        if (lines.some((l) => l.includes('"ready"'))) resolve();
      });
      child.on('exit', (code) => reject(new Error(`bulk load exited ${code}`)));
    });
    await ready;
    await new Promise((r) => setTimeout(r, 2000));
    const loaded = percentiles(await pingPong(inter, 1024, 500));
    await new Promise<void>((r) => child.on('exit', () => r()));
    const result = JSON.parse(
      lines.filter((l) => l.includes('"bytes"')).pop() ?? '{"bytes":0,"seconds":1}',
    ) as { bytes: number; seconds: number };
    await inter.close();
    measure(ctx, 'interactive echo idle', { ...idle, unit: 'ms', ...conditions });
    measure(ctx, 'interactive echo under bulk load (4 bulk sessions, other process)', {
      ...loaded,
      unit: 'ms',
      bulkMiBps: Math.round((result.bytes / 1024 / 1024 / result.seconds) * 10) / 10,
      ...conditions,
    });
    expect(result.bytes).toBeGreaterThan(0);
    expect(loaded.p95).toBeLessThan(Math.max(50, idle.p95 * 50));
  });

  it('reconnect storm: 40 clients drop at once and reconnect (ticket + relay + Noise XX)', async (ctx) => {
    const n = 40;
    const clients = await Promise.all(Array.from({ length: n }, () => echoClient('interactive')));
    for (const c of clients) c.abort();
    const t0 = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: n }, async () => {
        const s0 = Date.now();
        const c = await echoClient('interactive');
        await pingPong(c, 1024, 1);
        const d = Date.now() - s0;
        await c.close();
        return d;
      }),
    );
    const ok = results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
      .map((r) => r.value);
    const failures = results
      .filter((r) => r.status === 'rejected')
      .map((r) => String((r as PromiseRejectedResult).reason).slice(0, 120));
    measure(ctx, `reconnect storm (${n} clients)`, {
      ...percentiles(ok),
      unit: 'ms',
      failures: failures.length,
      failureReasons: [...new Set(failures)],
      allReconnectedMs: Date.now() - t0,
      bound:
        "control's client ticket rate limit (120/min per account and per device) bounds storms through control",
      ...conditions,
    });
    expect(failures.length).toBe(0);
  });
});

void whenOpen;
void (null as unknown as ApplianceSession);
