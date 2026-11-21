/**
 * VT-80, the canary, for the keys of the agent's commands (hermes-engine.md HE-43; one-person.md OP-S60, OP-S109): one
 * unique secret value is set through the API as an API's bearer token, a basic-auth password and a query parameter, and
 * checked against fakes that echo it; an SSH private key is imported with its passphrase and its server checked and
 * trusted. Then the person's turn gets them for its commands (`runner.turnKeys`, the one door the value leaves by), the
 * agent posts them back and its activity shows them (scrubbed, AC-32), an outsiders' turn gets nothing, and the person
 * reads everything. Afterwards the value and the key — and every
 * encoded form of them — appear nowhere: no table (sealed columns hold ciphertext), event, approval, activity row,
 * dispatch context, prompt, turn input, MCP result, API response, realtime frame or captured log line.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, TurnKeys, vaultSecretForms, vaultSshKeyForms } from '@whombat/core';
import { buildTurnInput, hostFromEnv, type RunnerApi, soulMd, turnPrompt, whombatMd } from '@whombat/runner';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveDispatch, RUNNER, runnerCall } from '../agent-commands/testing';
import { dispatches } from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent } from '../test/personal';
import { sshKeyPair } from '../test/ssh-keys';
import { tokenForDispatch } from '../test/tokens';
import { useVaultNetForTests } from './net';
import { rawPrivateNumbers } from './ssh-keys';
import { entryById, vaultSecretAad } from './store';
import { type FakeSsh, fakeSsh } from './testing/ssh-fake';
import { HOSTS, useVaultWorld } from './testing/world';

const CANARY = 'cnry-Q9x7L2m4N8p6R3s5+/=';
/** The SSH key's passphrase (seen once, at import) and the key itself, pasted encrypted. */
const SSH_PASSPHRASE = 'cnry-ssh-passphrase-7Hk2';
const SSH_KEY = sshKeyPair('ed25519', {
  passphrase: SSH_PASSPHRASE,
  cipher: 'aes256-ctr',
  rounds: 4,
});
/** The forms of the stored key, read back from the seal at the end. */
let sshForms: string[] = [];
let ssh: FakeSsh | null = null;
/** What `runner.turnKeys` gave the person's turn: the one place the value is meant to be. */
let delivered = '';
const logs: string[] = [];
const t = useTestServer({
  seed: true,
  listen: true,
  app: true,
  logger: {
    level: 'trace',
    stream: {
      write: (line: string) => {
        logs.push(line);
      },
    },
  },
});
const w = useVaultWorld(t);
const seen: string[] = [];
const frames: string[] = [];

/** Everything the canary must not be found in, collected as the test goes. */
function keep(label: string, value: unknown) {
  seen.push(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

afterAll(async () => {
  await ssh?.close();
});

beforeAll(() => {
  t.services.bus.onFrame((frame) => frames.push(JSON.stringify(frame)));
});

async function keysFor(dispatchId: string): Promise<TurnKeys> {
  const res = await runnerCall(t, 'GET', '/dispatches/:dispatchId/turn-keys', { dispatchId }, undefined, {
    runnerId: RUNNER,
    attempt: 1,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return TurnKeys.parse(res.body);
}

describe('the canary (VT-80)', () => {
  let energy = '';
  let login = '';
  let query = '';

  it('is set through every door and used through every path', async () => {
    await addPersonalAgent(t.services, t.burrowId, IDS.mara, { name: 'Wren', services: null });
    // The fakes accept the canary, in every sign-in the Vault has.
    const basic = Buffer.from(`mara:${CANARY}`).toString('base64');
    w.api.accepts = (req, url) =>
      req.headers.authorization === `Bearer ${CANARY}` ||
      req.headers.authorization === `Basic ${basic}` ||
      url.searchParams.get('key') === CANARY;
    await w.listHomeNetwork();
    const create = async (body: Record<string, unknown>) => {
      const res = await w.call(api.vault.create, {}, body);
      keep('create', res.raw);
      expect(res.status, res.raw).toBe(201);
      return String((res.body.entry as { id: string }).id);
    };
    energy = await create({
      name: 'Energy',
      kind: 'http',
      url: w.apiUrl(),
      auth: { type: 'bearer' },
      secret: 'first',
    });
    keep('setSecret', (await w.call(api.vault.setSecret, { entryId: energy }, { value: CANARY })).raw);
    login = await create({
      name: 'Router',
      kind: 'http',
      url: w.apiUrl(),
      auth: { type: 'basic', username: 'mara' },
      secret: CANARY,
    });
    query = await create({
      name: 'Weather',
      kind: 'http',
      url: w.apiUrl(),
      auth: { type: 'query', name: 'key' },
      secret: CANARY,
    });
    for (const id of [energy, login, query]) {
      keep('check', (await w.call(api.vault.check, { entryId: id }, undefined)).raw);
      keep('give', (await w.call(api.vault.giveKey, { entryId: id, agent: 'dusty' }, {})).raw);
    }

    // An SSH key: imported with its passphrase, its server checked and trusted.
    ssh = await fakeSsh();
    HOSTS['ssh.home.test'] = ['192.168.79.20'];
    useVaultNetForTests(t.services, {
      resolve: async (host) => {
        const list = HOSTS[host];
        if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
        return list.map((address) => ({ address, family: 4 }));
      },
      dialAddress: (a) => (a.startsWith('192.168.77.') || a.startsWith('192.168.79.') ? '127.0.0.1' : a),
      deadlineMs: 3000,
    });
    await w.call(api.vaultNetworks.add, {}, { cidr: '192.168.79.0/24', ports: [ssh.port], note: '' }, 'mara');
    const sshCreated = await w.call(
      api.vault.create,
      {},
      {
        name: 'Deploy',
        kind: 'ssh',
        sshKey: { mode: 'import', privateKey: SSH_KEY.private, passphrase: SSH_PASSPHRASE },
      },
    );
    keep('ssh create', sshCreated.raw);
    expect(sshCreated.status, sshCreated.raw).toBe(201);
    const deploy = String((sshCreated.body.entry as { id: string }).id);
    ssh.authorized.add(SSH_KEY.public.split(' ').slice(0, 2).join(' '));
    const server = await w.call(
      api.vault.addSshServer,
      { entryId: deploy },
      { name: 'web-1', host: 'ssh.home.test', port: ssh.port, username: 'deploy' },
    );
    keep('ssh server', server.raw);
    const serverId = String(server.body.serverId);
    keep('ssh check', (await w.call(api.vault.checkSshServer, { entryId: deploy, serverId }, undefined)).raw);
    keep(
      'ssh trust',
      (
        await w.call(
          api.vault.trustSshHostKey,
          { entryId: deploy, serverId },
          { fingerprint: ssh.hostKey().fingerprint },
        )
      ).raw,
    );
    keep('give ssh', (await w.call(api.vault.giveKey, { entryId: deploy, agent: 'dusty' }, {})).raw);
    const stored = t.services.custody.open(
      vaultSecretAad(deploy),
      (await entryById(t.services.db, deploy))?.sealed ?? '',
    );
    sshForms = vaultSshKeyForms({
      privateKeys: [stored, SSH_KEY.private],
      raw: rawPrivateNumbers(stored),
      passphrase: SSH_PASSPHRASE,
    });

    // The person's turn: the keys go to its commands — the one door the value leaves by.
    const d = await liveDispatch(t, { person: IDS.mara });
    const keys = await keysFor(d.id);
    delivered = JSON.stringify(keys);
    expect(keys.env.map((e) => e.value)).toContain(CANARY);
    expect(
      keys.files.some((f) => Buffer.from(f.base64, 'base64').toString('utf8').includes(stored.trim())),
    ).toBe(true);
    // The agent posts what its commands hold, and its activity shows it: scrubbed before anything stores it.
    const mcp = await mcpClient(t.baseUrl, (await tokenForDispatch(t.services, d.id)).token);
    const posted = await mcp.client.callTool({
      name: 'post_message',
      arguments: {
        conversationId: IDS.billing,
        text: `It is ${CANARY}, Basic ${basic}, key=${encodeURIComponent(CANARY)} and ${stored.split('\n')[2] ?? ''}`,
      },
    });
    keep('mcp post_message', posted);
    await mcp.close();
    await t.services.runtime.progress(d.id, {
      state: 'running',
      runnerId: RUNNER,
      attempt: 1,
      activity: [
        {
          key: '1:t1',
          seq: 1,
          kind: 'command',
          tool: 'shell',
          status: 'done',
          object: `curl -H "Authorization: Bearer ${CANARY}"`,
          exitCode: 0,
          failure: null,
          keyNeeded: null,
          approvalId: null,
          evidence: { input: `echo ${CANARY}`, output: CANARY, truncated: false },
          at: t.services.clock().toISOString(),
        },
      ],
    } as never);

    // What the turn is given: the context, both prompts and the provider's turn input.
    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, d.id));
    if (!row) throw new Error('no dispatch');
    const ctx = await buildDispatchContext(t.services, row);
    keep('context', ctx);
    keep('SOUL.md and whombat.md', `${soulMd(ctx)}\n${whombatMd(ctx)}`);
    keep('prompt', turnPrompt(ctx));
    const workspaces = mkdtempSync(join(tmpdir(), 'wb-vault-canary-'));
    const { input } = await buildTurnInput(ctx, {
      api: {} as RunnerApi,
      serverUrl: 'http://127.0.0.1:1',
      workspacesRoot: workspaces,
      host: hostFromEnv(),
    });
    keep('turn input', input);

    // An outsiders' turn gets nothing (OP-17).
    const outsiders = await keysFor((await liveDispatch(t, { person: null })).id);
    expect(outsiders.entries).toEqual([]);
    keep('other keys', outsiders);

    // Every read the person makes.
    for (const who of ['mara'] as const) {
      keep(`list ${who}`, (await w.call(api.vault.list, {}, undefined, who)).raw);
      for (const id of [energy, login, query, deploy]) {
        keep(`get ${who}`, (await w.call(api.vault.get, { entryId: id }, undefined, who)).raw);
        keep(`uses ${who}`, (await w.call(api.vault.uses, { entryId: id }, undefined, who)).raw);
      }
      keep(`audit ${who}`, (await w.call(api.audit.list, {}, undefined, who, { limit: 100 })).raw);
      keep(`export ${who}`, (await w.call(api.audit.export, {}, undefined, who)).raw);
      keep(`approvals ${who}`, (await w.call(api.approvals.list, {}, undefined, who)).raw);
      keep(`activity ${who}`, (await w.call(api.work.overview, {}, undefined, who)).raw);
    }
  });

  it('is found nowhere, in no encoding', async () => {
    // Every row of every table, as JSON (sealed columns hold ciphertext, which never contains the value).
    const tables = await t.services.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const dump: string[] = [];
    for (const { table_name } of tables) {
      const rows = await t.services.db.execute(
        sql.raw(`select to_jsonb(t)::text as row from "${table_name}" t`),
      );
      for (const r of rows as unknown as { row: string }[]) dump.push(`${table_name}: ${r.row}`);
    }
    expect(dump.length).toBeGreaterThan(100);
    const forms = [...vaultSecretForms(CANARY, 'mara').filter((f) => f.length >= 8), ...sshForms];
    expect(forms.length).toBeGreaterThanOrEqual(5);
    // The SSH key's forms: its texts, private lines, raw seed and the passphrase.
    expect(sshForms.length).toBeGreaterThan(5);
    expect(sshForms).toContain(SSH_PASSPHRASE);
    const places: [string, string[]][] = [
      ['database', dump],
      ['collected', seen],
      ['realtime frames', frames],
      ['logs', logs],
    ];
    expect(logs.length).toBeGreaterThan(10);
    expect(frames.length).toBeGreaterThan(10);
    for (const [where, texts] of places)
      for (const text of texts)
        for (const form of forms)
          if (text.includes(form))
            throw new Error(`the canary (${form}) leaked into ${where}: ${text.slice(0, 400)}`);
    // The value did leave: towards the fakes the person checked, and to the person's turn's commands.
    expect(w.api.requests.some((q) => q.url.includes('key='))).toBe(true);
    expect(delivered).toContain(CANARY);
    expect(ssh?.users.length).toBeGreaterThan(0);
    // What the agent posted was scrubbed, not refused.
    expect(seen.some((s) => s.startsWith('mcp post_message') && s.includes('"ok"'))).toBe(true);
  });
});
