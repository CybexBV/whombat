/**
 * AI clients on a managed appliance (contracts 0.9.0 CT-72, CT-73): `clients.*` over the session go to the manager's
 * socket (a fake here), the manager's push on the admin socket updates the runtime and the runner's clients file, and
 * the runtime tells the manager its adapter levels (`RuntimeFacts.clientAdapters`). Claude Code is the only client:
 * ChatGPT needs nothing installed, and a Codex the manager still has is removed (hermes-native.md HN-A01…HN-A03).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalClientsStatus, RuntimeFacts } from '@whombat/control-contracts/local';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AdminSocket } from '../managed/admin-socket';
import type { RequestAnswer } from '../managed/dispatcher';
import { RequestControl } from '../managed/dispatcher';
import type { SessionPrincipal } from '../managed/trust';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { aiClients, ManagerClients } from './service';

const dir = mkdtempSync(join(tmpdir(), 'wb-clients-'));
const managerPath = join(dir, 'manager.sock');
const adminPath = join(dir, 'admin.sock');
const clientsFile = join(dir, 'state', 'clients.json');
const m = useManagedRuntime({
  seed: true,
  env: { WHOMBAT_MANAGER_SOCKET: managerPath, WHOMBAT_CLIENTS_FILE: clientsFile },
});

const SHA = 'a'.repeat(64);
const installed = (provider: 'claude' | 'codex', version: string) => ({
  provider,
  state: 'installed' as const,
  installed: {
    version,
    installedAt: '2026-09-26T10:00:00Z',
    executable: { path: `/persist/whombat/clients/${provider}/${version}/${provider}`, sha256: SHA },
    fixturesDigest: `sha256:${'b'.repeat(64)}`,
  },
  latest: { version, publishedAt: '2026-09-25T10:00:00Z' },
  progress: null,
  error: null,
});
/** What the fake manager holds, and what it was asked. */
const manager = {
  clients: [installed('codex', '0.157.0')] as unknown[],
  asked: [] as string[],
  unavailable: new Set<string>(),
};
let fake: Server;
let admin: AdminSocket;
let owner: SessionPrincipal;

beforeAll(async () => {
  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      manager.asked.push(`${req.method} ${req.url}${body ? ` ${body.provider}` : ''}`);
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'GET' && req.url === '/v1/clients')
        return send(200, {
          v: 1,
          clients: manager.clients,
          channel: { sequence: 7, checkedAt: '2026-09-26T09:00:00Z' },
        });
      if (req.url === '/v1/clients/install') {
        if (manager.unavailable.has(body.provider))
          return send(404, { v: 1, error: { code: 'unavailable', message: 'no bundle fits' } });
        return send(202, {
          ...installed(body.provider, '2.1.283'),
          state: 'installing',
          installed: null,
          progress: 0,
        });
      }
      if (req.url === '/v1/clients/remove')
        return send(200, {
          provider: body.provider,
          state: 'not_installed',
          installed: null,
          latest: null,
          progress: null,
          error: null,
        });
      send(404, { v: 1, error: { code: 'not_found', message: 'no' } });
    });
  });
  await new Promise<void>((r) => fake.listen(managerPath, () => r()));
  admin = new AdminSocket({ runtime: m.runtime, endpoint: null, releaseId: 'rel-test-1' });
  await admin.listen(adminPath);
  const a = await m.enroll(IDS.mara);
  owner = await m.runtime.trust.identify(a.peerId, a.publicKey);
});

afterAll(async () => {
  await admin.close();
  await new Promise<void>((r) => fake.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function run(
  principal: SessionPrincipal,
  id: string,
  op: string,
  input: unknown,
): Promise<RequestAnswer> {
  let answer: RequestAnswer | null = null;
  await m.runtime.dispatcher.handle(
    principal,
    { id, op, input },
    { accepted: () => {}, result: (a) => (answer = a) },
    new RequestControl(null),
  );
  return answer as unknown as RequestAnswer;
}

function adminCall(path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: adminPath,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? '' : JSON.stringify(body));
  });
}

describe('AI clients on a managed appliance', () => {
  it('lists Claude Code alone, writes the manager’s status for the runner and removes a Codex it still has', async () => {
    const out = await run(owner, 'c-list-1', 'clients.list', { params: {}, query: {} });
    expect(out).toMatchObject({
      type: 'result',
      output: {
        canManage: true,
        checkedAt: '2026-09-26T09:00:00Z',
        clients: [{ provider: 'claude', state: 'not_installed', installed: null }],
      },
    });
    expect((out as { output: { clients: unknown[] } }).output.clients).toHaveLength(1);
    const file = LocalClientsStatus.parse(JSON.parse(readFileSync(clientsFile, 'utf8')));
    expect(file.clients.map((c) => c.provider)).toEqual(['codex']);
    // The installed Codex nothing runs any more is removed through the manager, once (HN-A03).
    const backend = await aiClients(m.runtime.services);
    expect(backend).toBeInstanceOf(ManagerClients);
    await (backend as ManagerClients).codexRemoved();
    expect(manager.asked).toContain('POST /v1/clients/remove codex');
    await run(owner, 'c-list-again', 'clients.list', { params: {}, query: {} });
    expect(manager.asked.filter((a) => a === 'POST /v1/clients/remove codex')).toHaveLength(1);
    manager.clients = [];
  });

  it('installs and removes Claude Code for the person, and nothing for ChatGPT', async () => {
    manager.unavailable.add('claude');
    expect(
      await run(owner, 'c-inst-0', 'clients.install', { params: { provider: 'claude' }, query: {} }),
    ).toMatchObject({
      type: 'result',
      output: { provider: 'claude', error: { code: 'client.unavailable' } },
    });
    // The refusal stays in the list (SUB-55): the app shows it rather than a button that seems to do nothing.
    expect(await run(owner, 'c-list-refused', 'clients.list', { params: {}, query: {} })).toMatchObject({
      output: { clients: [{ provider: 'claude', error: { code: 'client.unavailable' } }] },
    });
    manager.unavailable.delete('claude');
    expect(
      await run(owner, 'c-inst-1', 'clients.install', { params: { provider: 'claude' }, query: {} }),
    ).toMatchObject({ type: 'result', output: { provider: 'claude', state: 'installing', progress: 0 } });
    expect(manager.asked).toContain('POST /v1/clients/install claude');
    // ChatGPT needs nothing installed: the manager is never asked (HN-A01).
    for (const op of ['clients.install', 'clients.remove'])
      expect(
        await run(owner, `c-${op}-codex`, op, { params: { provider: 'codex' }, query: {} }),
      ).toMatchObject({
        type: 'error',
        code: 'validation_failed',
      });
    expect(manager.asked).not.toContain('POST /v1/clients/install codex');
    expect(
      await run(owner, 'c-rm-1', 'clients.remove', { params: { provider: 'claude' }, query: {} }),
    ).toMatchObject({ type: 'result', output: { provider: 'claude', state: 'not_installed' } });
  });

  it('onboarding’s “Set up your AI” installs Claude Code when picked, and nothing for ChatGPT', async () => {
    manager.asked.length = 0;
    expect(
      await run(owner, 'c-onboarding', 'onboarding.update', {
        params: { burrow: 'burrow-hq' },
        query: {},
        body: { clients: ['codex', 'claude'] },
      }),
    ).toMatchObject({ type: 'result', output: { clients: ['codex', 'claude'] } });
    // The installs run on in the background, in the order picked: ChatGPT's would have been asked first.
    await vi.waitFor(() => expect(manager.asked).toContain('POST /v1/clients/install claude'));
    expect(manager.asked.filter((a) => a.includes('codex'))).toEqual([]);
  });

  it('takes the manager’s push on the admin socket and tells it the adapter levels', async () => {
    const push = {
      v: 1,
      clients: [installed('claude', '2.1.283')],
      channel: { sequence: 8, checkedAt: '2026-09-26T11:00:00Z' },
    };
    expect(await adminCall('/clients', push)).toMatchObject({ status: 200, body: { ok: true } });
    const file = LocalClientsStatus.parse(JSON.parse(readFileSync(clientsFile, 'utf8')));
    expect(file.clients[0]?.installed?.executable.path).toBe(
      '/persist/whombat/clients/claude/2.1.283/claude',
    );
    expect(await run(owner, 'c-list-2', 'clients.list', { params: {}, query: {} })).toMatchObject({
      output: {
        checkedAt: '2026-09-26T11:00:00Z',
        clients: [{ provider: 'claude', state: 'installed' }],
      },
    });
    // A push that isn't the contract's (strict at the top) is refused.
    expect((await adminCall('/clients', { ...push, extra: true })).status).toBe(400);
    const facts = RuntimeFacts.parse((await adminCall('/facts')).body);
    // Codex: a level no Codex bundle was tested with, so the manager offers none (HN-A02).
    expect(facts.clientAdapters).toEqual({ claude: 1 });
  });
});
