/**
 * The manager's client status as the server keeps it for the runner (SUB-25, SUB-46): concurrent pushes never leave
 * a torn, mixed or older file than the newest status (review CLI-4); the channel keys are worked out again at every
 * check (SUB-47, review CLI-2); the file is 0640 whatever the umask (SUB-54).
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Services } from '../services';
import { durableIO } from '../test/durable-io';
import { CLIENT_CATCH_UP_MS, ManagerClients, writeClientsFile } from './service';

const status = (path: string, n: number) => ({
  clients: [
    {
      provider: 'claude' as const,
      state: 'installed' as const,
      installed: {
        version: `1.0.${n}`,
        installedAt: '2026-09-26T00:00:00Z',
        executable: { path, sha256: 'a'.repeat(64) },
        fixturesDigest: `sha256:${'a'.repeat(64)}`,
      },
      latest: null,
      progress: null,
      error: null,
    },
  ],
  channel: null,
});

const services = { log: { warn: () => {} } } as unknown as Services;

describe('ManagerClients.apply (review CLI-4)', () => {
  it(
    'writes only whole files, the newest status last, under overlapping pushes (repro apply.mts, apply2.mts)',
    (context) =>
      durableIO(context, async (signal) => {
        const dir = mkdtempSync(join(tmpdir(), 'wb-clients-file-'));
        const file = join(dir, 'clients.json');
        const m = new ManagerClients(services, undefined, file);
        let rejected = 0;
        // 120 durable writes under shared CI storage: 250 ms per round, not a latency contract.
        for (let i = 0; i < 120; i++) {
          signal.throwIfAborted();
          const pushes = await Promise.allSettled([
            m.apply(status(`/persist/whombat/clients/claude/old/claude${'x'.repeat(i % 50)}`, 1)),
            m.apply(status('/persist/whombat/clients/claude/new/claude', 2)),
          ]);
          signal.throwIfAborted();
          rejected += pushes.filter((p) => p.status === 'rejected').length;
          // Whole JSON every time, and the version the server holds (the one pushed last).
          const disk = JSON.parse(readFileSync(file, 'utf8'));
          expect(disk.clients[0].installed.version).toBe('1.0.2');
          expect((await m.list()).clients[0]?.installed?.version).toBe('1.0.2');
        }
        expect(rejected).toBe(0);
        // No temp file is left behind.
        expect(readdirSync(dir)).toEqual(['clients.json']);
      }),
    30_000,
  );
});

describe('the clients file (SUB-54)', () => {
  it(
    'is 0640 under the appliance server’s UMask 0077, so the runner can read it through the directory’s group',
    (context) =>
      durableIO(context, async (signal) => {
        const dir = mkdtempSync(join(tmpdir(), 'wb-clients-mode-'));
        const file = join(dir, 'clients.json');
        const before = process.umask(0o077);
        try {
          signal.throwIfAborted();
          await writeClientsFile(file, { v: 1, ...status('/persist/whombat/clients/claude/1/claude', 1) });
        } finally {
          process.umask(before);
        }
        signal.throwIfAborted();
        expect(statSync(file).mode & 0o777).toBe(0o640);
        expect(JSON.parse(readFileSync(file, 'utf8')).clients[0].installed.version).toBe('1.0.1');
      }),
    10_000,
  );
});

describe('an install the manager refuses (SUB-55)', () => {
  it('lists as failed with its reason until the manager reports the client installing, or another request', async () => {
    const { createServer } = await import('node:http');
    const dir = mkdtempSync(join(tmpdir(), 'wb-clients-refused-'));
    const sock = join(dir, 'manager.sock');
    let unavailable = true;
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/clients') {
          res.end(JSON.stringify({ v: 1, clients: [], channel: null }));
        } else if (unavailable) {
          res.statusCode = 404;
          res.end(JSON.stringify({ v: 1, error: { code: 'unavailable', message: 'no channel' } }));
        } else {
          res.statusCode = 202;
          res.end(
            JSON.stringify({
              provider: 'claude',
              state: 'installing',
              installed: null,
              latest: null,
              progress: 0,
              error: null,
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => server.listen(sock, () => r()));
    try {
      const m = new ManagerClients(services, sock, undefined);
      const refused = await m.install('claude');
      expect(refused).toMatchObject({ state: 'failed', error: { code: 'client.unavailable' } });
      // Listed the same way afterwards (before, the list said `not_installed` and the click did nothing).
      const listed = (await m.list()).clients;
      expect(listed[0]).toMatchObject({
        provider: 'claude',
        state: 'failed',
        error: { code: 'client.unavailable' },
      });
      // Claude Code alone: ChatGPT needs nothing installed (hermes-native.md HN-A01).
      expect(listed).toHaveLength(1);
      // The manager starts installing: its push wins.
      await m.apply({
        clients: [{ ...status('/x', 1).clients[0], installed: null, state: 'installing', progress: 12 }],
        channel: null,
      } as never);
      expect((await m.list()).clients[0]).toMatchObject({ state: 'installing', progress: 12, error: null });
      await m.apply({ clients: [], channel: null });
      expect((await m.list()).clients[0]).toMatchObject({ state: 'not_installed', error: null });
      // Refused again, then a retry the manager accepts clears it.
      await m.install('claude');
      expect((await m.list()).clients[0]).toMatchObject({ state: 'failed' });
      unavailable = false;
      expect(await m.install('claude')).toMatchObject({ state: 'installing', progress: 0, error: null });
      expect((await m.list()).clients[0]).toMatchObject({ state: 'installing', error: null });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('ManagerClients.installedAt', () => {
  it('records when the manager first said a client is installed, and forgets it once it is not', async () => {
    const m = new ManagerClients(services, undefined, undefined);
    const before = Date.now();
    await m.apply(status('/persist/whombat/clients/claude/1/claude', 1));
    const at = m.installedAt.get('claude');
    expect(at).toBeGreaterThanOrEqual(before);
    // An update keeps the first time: the runner has known the provider since then.
    await m.apply(status('/persist/whombat/clients/claude/2/claude', 2));
    expect(m.installedAt.get('claude')).toBe(at);
    await m.apply({ clients: [], channel: null });
    expect(m.installedAt.has('claude')).toBe(false);
    expect(CLIENT_CATCH_UP_MS).toBeGreaterThan(10_000);
  });
});
