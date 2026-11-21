/**
 * The hub's own calls over the socket (backup-file.md BF-13, BF-14; BF-S30…BF-S33) against the fake hosts service:
 * `GET /hub` mapped, `GET /hub/backup` streamed to its end, `POST /hub/restore` with its body streamed — refused while
 * the hub watches servers or for its own backup, taken by an empty one — then nothing answers while it restarts and
 * the wait sees the new certificate authority.
 */
import type { IncomingMessage } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostsError } from './client';
import { HostsService } from './service';
import { FakeHostsService } from './testing/fake';

const full = new FakeHostsService();
const empty = new FakeHostsService();

const log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never;
const serviceOf = (fake: FakeHostsService) =>
  new HostsService({
    config: { WHOMBAT_HOSTS_SOCKET: fake.socket, WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile },
    db: null as never,
    log: () => log,
    clock: () => new Date(),
  });

async function bytesOf(res: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function* pieces(bytes: Buffer, size = 7_000): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

const ACTOR = { id: 'prn_mara', name: 'Mara' };

beforeAll(async () => {
  await full.start();
  await empty.start();
  empty.clearServers();
  empty.hubMeta.agents_url = 'wss://10.100.1.158:8443';
});

afterAll(async () => {
  await full.stop();
  await empty.stop();
});

describe('the hub over the socket', () => {
  it('reads /hub and streams its backup as admin', async () => {
    const hosts = serviceOf(full);
    const hub = await hosts.hub();
    expect(hub.caSha256).toBe(full.hubMeta.ca_sha256);
    expect(hub.agentUrl).toBe('wss://10.100.0.2:8443');
    expect(hub.servers).toBe((full.fleet.servers as unknown[]).length);
    const bytes = await bytesOf(await hosts.hubBackup());
    expect(bytes.length).toBeGreaterThan(64 * 1024);
    expect(full.calls('GET', '/api/v1/hub/backup').at(-1)?.role).toBe('admin');
  });

  it('refuses a restore while the hub watches servers, and its own backup', async () => {
    const backup = (await bytesOf(await serviceOf(full).hubBackup())) as Buffer;
    const same = await serviceOf(full)
      .restoreHub(pieces(backup), backup.length, ACTOR)
      .catch((e: unknown) => e);
    expect(same).toBeInstanceOf(HostsError);
    expect((same as HostsError).code).toBe('same_hub');
    const other = new FakeHostsService();
    await other.start();
    try {
      const theirs = other.hubBackupBytes();
      const refused = await serviceOf(full)
        .restoreHub(pieces(theirs), theirs.length, ACTOR)
        .catch((e: unknown) => e);
      expect((refused as HostsError).code).toBe('hub_not_empty');
      const junk = Buffer.from('not a backup');
      const bad = await serviceOf(empty)
        .restoreHub(pieces(junk), junk.length, ACTOR)
        .catch((e: unknown) => e);
      expect((bad as HostsError).code).toBe('bad_backup');
    } finally {
      await other.stop();
    }
  });

  it('hands an empty hub the backup, byte for byte, and waits for it to come back with the new authority', async () => {
    const backup = full.hubBackupBytes();
    const hosts = serviceOf(empty);
    empty.restartMs = 300;
    const answer = await hosts.restoreHub(pieces(backup), backup.length, ACTOR);
    expect(answer).toMatchObject({ caSha256: full.hubMeta.ca_sha256, servers: 10 });
    expect(empty.restored.at(-1)?.equals(backup)).toBe(true);
    expect(empty.calls('POST', '/api/v1/hub/restore').at(-1)?.role).toBe('admin');
    // Restarting: nothing answers for a moment.
    await expect(hosts.hub()).rejects.toThrow();
    const back = await hosts.waitForHub(
      (h) => (h.caSha256 === full.hubMeta.ca_sha256 ? 'ready' : h.restoreError ? 'failed' : 'wait'),
      { deadlineMs: 5_000, pollMs: 50 },
    );
    expect(back?.outcome).toBe('ready');
    expect(back?.hub).toMatchObject({
      servers: 10,
      agentUrl: 'wss://10.100.1.158:8443',
      agentUrlPrevious: 'wss://10.100.0.2:8443',
    });
    expect(back?.hub.restoredAt).not.toBeNull();
  });

  it('gives up waiting when the hub never shows the authority', async () => {
    const hosts = serviceOf(full);
    const waited = await hosts.waitForHub(() => 'wait', { deadlineMs: 120, pollMs: 40 });
    expect(waited).toBeNull();
  });
});
