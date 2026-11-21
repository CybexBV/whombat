import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptedHermesLauncher } from '@whombat/agent-runtime/testing/hermes';
import { hermesHomeEndpoints } from '@whombat/core';
import { HermesHomeService, HermesHomeWorker } from '@whombat/runner';
import { afterEach, describe, expect, it } from 'vitest';
import { HermesHomeBridge, HermesHomeCallError } from './bridge';
import { exportHome, importHome } from './service';

/** The runner's worker, its requests answered by the bridge in this process instead of over HTTP. */
function fetchInto(bridge: HermesHomeBridge): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (path.endsWith(hermesHomeEndpoints.poll.path)) {
      const requests = await bridge.poll(body.waitMs ?? 0, init?.signal ?? undefined);
      return new Response(JSON.stringify({ requests }));
    }
    return new Response(JSON.stringify({ ok: bridge.answer(hermesHomeEndpoints.answer.body.parse(body)) }));
  }) as typeof fetch;
}

const workers: HermesHomeWorker[] = [];
afterEach(async () => {
  for (const w of workers.splice(0)) await w.stop();
});

async function runnerFor(bridge: HermesHomeBridge) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-hermes-bridge-'));
  const service = new HermesHomeService({ root: join(dir, 'root'), bin: await scriptedHermesLauncher(dir) });
  const worker = new HermesHomeWorker(service, {
    serverUrl: 'http://runner.test',
    token: 't',
    fetchImpl: fetchInto(bridge),
  });
  worker.start();
  workers.push(worker);
  return service;
}

describe('the Hermes-home bridge (HE-38)', () => {
  it('hands steps to the runner’s worker and checks what comes back', async () => {
    const bridge = new HermesHomeBridge(5_000);
    await runnerFor(bridge);
    const written = await bridge.call('memory.write', { file: 'user', entries: ['Mara'] });
    expect(written.entries).toEqual(['Mara']);
    expect((await bridge.call('memory.read', {})).user.entries).toEqual(['Mara']);
    const refused = await bridge
      .call('memory.write', { file: 'user', entries: ['x'], ifVersion: 'old' })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HermesHomeCallError);
    expect((refused as HermesHomeCallError).code).toBe('conflict');
    expect(bridge.runnerSeen).toBe(true);
    bridge.close();
  });

  it('moves a home’s archive in chunks both ways', async () => {
    const bridge = new HermesHomeBridge(5_000);
    await runnerFor(bridge);
    await bridge.call('memory.write', { file: 'memory', entries: ['Deploys from main'] });
    const out = await exportHome(bridge, { kind: 'profile', home: 'person' });
    const bytes: Buffer[] = [];
    for await (const chunk of out.read()) bytes.push(chunk);
    const archive = Buffer.concat(bytes);
    expect(archive.length).toBe(out.bytes);

    const other = new HermesHomeBridge(5_000);
    await runnerFor(other);
    const put = await importHome(
      other,
      { kind: 'profile', home: 'person' },
      {
        bytes: out.bytes,
        sha256: out.sha256,
        async *read() {
          yield archive;
        },
      },
      'replace',
    );
    expect(put.files).toBe(1);
    expect((await other.call('memory.read', {})).memory.entries).toEqual(['Deploys from main']);
    bridge.close();
    other.close();
  });

  it('says nothing was done when no runner took a step', async () => {
    const bridge = new HermesHomeBridge(30);
    const err = await bridge.call('memory.clear', {}).catch((e: unknown) => e);
    expect((err as HermesHomeCallError).code).toBe('unavailable');
    expect(bridge.runnerSeen).toBe(false);
    expect(bridge.waiting).toBe(0);
  });
});
