/**
 * Full Proxmox support against the real hosts service (proxmox.md PX-02, PX-03, PX-05): `whombat-hosts serve
 * --headless` with `rackoon-sim --allow-manage`, whose Proxmox node shale answers manage ops from memory. Owners'
 * routes read and change backup jobs in the contract's shape; Whombat's tools read the choices, create a container,
 * follow its task to the one message in the chat, and back it up. Skipped unless `WHOMBAT_HOSTS_BIN` and
 * `WHOMBAT_HOSTS_SIM` name the built binaries (`go build -o … ./cmd/whombat-hosts ./cmd/rackoon-sim` in whombat-hosts).
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostManageReadResult, HostManageResult } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent } from '../test/personal';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { startHosts } from './index';
import { ensureServersConnection } from './provision';

const BIN = process.env.WHOMBAT_HOSTS_BIN;
const SIM = process.env.WHOMBAT_HOSTS_SIM;
const present = Boolean(BIN && SIM && existsSync(BIN) && existsSync(SIM));
const dir = present ? mkdtempSync(join(tmpdir(), 'whombat-hosts-pve-')) : '';
const socket = join(dir, 'api.sock');
const tokenFile = join(dir, 'service-token');

const t = present
  ? useTestServer({
      seed: true,
      listen: true,
      env: { WHOMBAT_HOSTS_SOCKET: socket, WHOMBAT_HOSTS_TOKEN_FILE: tokenFile },
    })
  : null;

const procs: ChildProcess[] = [];
let personCookie = '';
let whombat = { agentId: '', dmId: '' };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      s.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
      );
    });
  });
}

async function waitFor<T>(fn: () => T | Promise<T>, ms = 20_000): Promise<NonNullable<T>> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function rest(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  const res = await t?.api.inject({
    method,
    url: `/api/v1/burrows/burrow-hq/hosts${path}`,
    headers: body ? { cookie: personCookie, 'content-type': 'application/json' } : { cookie: personCookie },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res?.statusCode ?? 0, body: res?.json() as Record<string, unknown> };
}

async function call(tool: string, args: Record<string, unknown>) {
  if (!t) throw new Error('no server');
  const d = await agentTokenFor(t.services, t.burrowId, whombat.agentId, whombat.dmId, {
    onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
  });
  const mcp = await mcpClient(t.baseUrl, d.token);
  const res = await mcp.client.callTool({
    name: 'connection_call',
    arguments: { connection: 'servers', tool, arguments: args },
  });
  await mcp.close();
  return (res.structuredContent ?? {}) as { status: string; content?: string; message?: string };
}

async function said(): Promise<string[]> {
  if (!t) return [];
  const rows = await t.services.db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, whombat.dmId), eq(messages.authorId, whombat.agentId)));
  return rows.map((m) => m.text);
}

describe.skipIf(!present)('Proxmox through the real hosts service', () => {
  beforeAll(async () => {
    if (!t) throw new Error('no server');
    const port = await freePort();
    const agentUrl = `wss://127.0.0.1:${port}`;
    procs.push(
      spawn(
        BIN as string,
        [
          'serve',
          '--headless',
          '--data',
          join(dir, 'data'),
          '--listen',
          `unix:${socket}`,
          '--agent-listen',
          `127.0.0.1:${port}`,
          '--agent-url',
          agentUrl,
          '--service-token-file',
          tokenFile,
        ],
        { stdio: 'ignore' },
      ),
    );
    await waitFor(() => existsSync(socket) && existsSync(tokenFile));
    personCookie = (await sessionFor(t.services, IDS.mara)).cookie;
    const made = await addPersonalAgent(t.services, t.burrowId, IDS.mara, {
      name: 'Dusty',
      services: null,
    });
    whombat = { agentId: made.agentId, dmId: made.dmId };
    await setConnectionKeys(t.services, whombat.agentId, { read: 'can', write: 'can' });
    startHosts(t.services);
    await waitFor(async () => (await rest('GET', '/status')).body.healthy);
    await ensureServersConnection(t.services);
    const ca = JSON.parse(
      execFileSync(
        'curl',
        [
          '-s',
          '--unix-socket',
          socket,
          '-H',
          `Authorization: Bearer ${readFileSync(tokenFile, 'utf8').trim()}`,
          'http://hosts/api/v1/hub',
        ],
        { encoding: 'utf8' },
      ),
    ).ca_sha256 as string;
    procs.push(
      spawn(
        SIM as string,
        [
          '--ui',
          `unix:${socket}`,
          '--service-token-file',
          tokenFile,
          '--agent-url',
          agentUrl,
          '--ca-sha256',
          ca,
          '--n',
          '5',
          '--interval',
          '2s',
          '--history',
          '30m',
          '--offline-after',
          '0',
          '--allow-manage',
          '--state',
          join(dir, 'sim'),
        ],
        { stdio: 'ignore' },
      ),
    );
    await waitFor(async () => {
      const s = await rest('GET', '/servers/shale');
      return s.status === 200;
    }, 60_000);
    const on = await rest('PATCH', '/servers/shale', { remoteControl: { manage: true, power: true } });
    expect(on.status).toBe(200);
  }, 120_000);

  afterAll(() => {
    for (const p of procs) p.kill('SIGTERM');
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads and pauses a backup job through the person’s routes', async () => {
    const list = await waitFor(async () => {
      const r = await rest('GET', '/servers/shale/manage?op=backupjob.list');
      return r.status === 200 ? r.body : null;
    });
    const parsed = HostManageReadResult.parse(list);
    if (parsed.op !== 'backupjob.list') throw new Error(parsed.op);
    expect(parsed.items.length).toBeGreaterThanOrEqual(2);
    const job = parsed.items[0];
    if (!job) throw new Error('no job');
    const paused = await rest('POST', '/servers/shale/manage', {
      op: 'backupjob.update',
      params: { jobId: job.id, enabled: false },
      digest: job.digest,
    });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(HostManageResult.parse(paused.body).ok).toBe(true);
    const again = HostManageReadResult.parse(
      (await rest('GET', '/servers/shale/manage?op=backupjob.list')).body,
    );
    if (again.op !== 'backupjob.list') throw new Error(again.op);
    expect(again.items.find((j) => j.id === job.id)?.enabled).toBe(false);
  }, 60_000);

  it('lets the assistant create a container, says when it is ready, and backs it up', async () => {
    const choices = await call('server_choices', { server: 'shale' });
    expect(choices.status, choices.message).toBe('ok');
    const c = JSON.parse(choices.content ?? '{}') as { containerTemplates?: string[] };
    const template = c.containerTemplates?.[0];
    expect(template).toBeTruthy();
    const made = await call('guest_create', { server: 'shale', kind: 'container', name: 'dns', template });
    expect(made.status, made.message).toBe('ok');
    const out = JSON.parse(made.content ?? '{}') as { guest?: string };
    expect(out.guest).toMatch(/^pve:\d+$/);
    await expect
      .poll(async () => (await said()).some((m) => /dns/.test(m) && /ready|done|made|created/i.test(m)), {
        timeout: 60_000,
        interval: 500,
      })
      .toBe(true);
    const backup = await call('guest_backup', { server: 'shale', guest: out.guest, action: 'create' });
    expect(backup.status, backup.message).toBe('ok');
  }, 120_000);
});
