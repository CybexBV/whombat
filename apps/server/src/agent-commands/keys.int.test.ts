/**
 * Vault keys for the agent's commands against a real Postgres (docs/decisions/one-person.md OP-07, OP-S60, OP-S109;
 * agent-computer.md AC-32, AC-34): a key's variable (the person's, signed), Production servers, the rotate notice when
 * a key goes, `runner.turnKeys` (the person's turn gets their keys, an outsiders' turn none, a key at the old Ask none, an
 * untrusted server no block; one-person.md OP-17, hermes-engine.md HE-43),
 * `DispatchContext.commands` and the scrubbing of what an agent posts.
 */
import { randomBytes } from 'node:crypto';
import {
  newId,
  TurnKeys,
  topics,
  VAULT_SCRUBBED,
  type VaultUseOutcome,
  vaultAuditText,
  vaultSshFingerprintOfBlob,
} from '@whombat/core';
import { desc, eq, isNotNull } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { sendMessage } from '../commands/messages';
import type { CommandDef } from '../commit/types';
import { events, messages, vaultEntries, vaultSshServers, vaultTools, vaultUses } from '../db/schema/index';
import type { BusFrame } from '../realtime/bus';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent } from '../test/personal';
import { sessionFor } from '../test/tokens';
import {
  createVaultEntry,
  detailHash,
  giveVaultKey,
  removeVaultEntry,
  takeVaultKey,
} from '../vault/commands';
import { useVaultNetForTests } from '../vault/net';
import {
  addVaultSshServer,
  createVaultSshEntry,
  sshHostKeyChanged,
  updateVaultSshServer,
} from '../vault/ssh-commands';
import { generateSshKey } from '../vault/ssh-keys';
import { entryById } from '../vault/store';
import { decideVaultUseCommand, recordVaultUse, whereOf } from '../vault/uses';
import { commandsContextFor } from './context';
import { liveDispatch, RUNNER, runnerCall } from './testing';

const t = useTestServer({ seed: true, app: true });

const CF_TOKEN = 'cf-token-9f8e7d6c5b4a3921';
const BASIC_PASSWORD = 'basic-pass-Zq8Wm3Rt5Yv7';
let mara = { agentId: '', dmId: '' };
let cfId = '';
let basicId = '';
let sshId = '';
let sshKey = '';
let web1 = '';
let web2 = '';
let blob: Buffer = Buffer.alloc(0);

/** An ed25519 host key's wire blob (algorithm + 32 bytes). */
function hostKeyBlob(): Buffer {
  const name = Buffer.from('ssh-ed25519');
  const key = randomBytes(32);
  const out = Buffer.alloc(4 + name.length + 4 + key.length);
  out.writeUInt32BE(name.length, 0);
  name.copy(out, 4);
  out.writeUInt32BE(key.length, 4 + name.length);
  key.copy(out, 8 + name.length);
  return out;
}

async function ok<R>(res: { status: string; result?: R }): Promise<R> {
  expect(res.status).toBe('ok');
  return res.result as R;
}

/** The entry's switch for the agent (vault-simplify.md VLT-10): undefined while it is off. */
const keyRow = async (entryId: string) => {
  const [e] = await t.services.db.select().from(vaultEntries).where(eq(vaultEntries.id, entryId));
  return e?.agentOnAt ? { envName: e.envName, servers: e.agentServers } : undefined;
};

const dmLines = async (dmId: string) =>
  (await t.services.db.select().from(messages).where(eq(messages.conversationId, dmId))).map((m) => m.text);

async function keysFor(dispatchId: string): Promise<TurnKeys> {
  const res = await runnerCall(t, 'GET', '/dispatches/:dispatchId/turn-keys', { dispatchId }, undefined, {
    runnerId: RUNNER,
    attempt: 1,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return TurnKeys.parse(res.body);
}

const fileOf = (keys: TurnKeys, path: string) => {
  const f = keys.files.find((x) => x.path === path);
  return f ? Buffer.from(f.base64, 'base64').toString('utf8') : null;
};

beforeAll(async () => {
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      if (host === 'web-1.example.com') return [{ address: '93.184.216.34', family: 4 }];
      if (host === 'web-2.example.com') return [{ address: '93.184.216.35', family: 4 }];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
  });
  mara = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: null });
  cfId = (
    await ok(
      await t.commit(IDS.mara, createVaultEntry, {
        kind: 'http',
        name: 'Cloudflare API token',
        url: 'https://api.cloudflare.com/client/v4',
        auth: { type: 'bearer' },
        secret: CF_TOKEN,
      }),
    )
  ).entryId;
  basicId = (
    await ok(
      await t.commit(IDS.mara, createVaultEntry, {
        kind: 'http',
        name: 'Registry',
        url: 'https://registry.example.com',
        auth: { type: 'basic', username: 'deployer' },
        secret: BASIC_PASSWORD,
      }),
    )
  ).entryId;
  sshId = newId('vaultEntry');
  const made = generateSshKey(sshId);
  sshKey = made.privateKey;
  await ok(
    await t.commit(IDS.mara, createVaultSshEntry, {
      entryId: sshId,
      name: 'Deploy key',
      privateKey: made.privateKey,
      auth: made.auth,
    }),
  );
  web1 = (
    await ok(
      await t.commit(IDS.mara, addVaultSshServer, {
        entryId: sshId,
        name: 'web-1',
        host: 'web-1.example.com',
        port: 22,
        username: 'deploy',
        production: true,
      }),
    )
  ).serverId;
  web2 = (
    await ok(
      await t.commit(IDS.mara, addVaultSshServer, {
        entryId: sshId,
        name: 'web-2',
        host: 'web-2.example.com',
        port: 2222,
        username: 'deploy',
      }),
    )
  ).serverId;
  // web-1's host key is trusted (and its blob kept); web-2's was never confirmed.
  blob = hostKeyBlob();
  await t.services.db
    .update(vaultSshServers)
    .set({
      hostKeyAlgorithm: 'ssh-ed25519',
      hostKeyFingerprint: vaultSshFingerprintOfBlob(blob),
      hostKeyTrustedAt: t.services.clock(),
      hostKeyBlob: blob.toString('base64'),
    })
    .where(eq(vaultSshServers.id, web1));
});

describe('a key switched on, and its variable (AC-30, AC-31, CT-1240)', () => {
  it('every new key reaches the commands in the entry name’s default variable (HE-43, HE-S154)', async () => {
    // The key that came with the entry (vault-self-serve.md VS-01) is on already: giving it again is no news.
    expect(await keyRow(cfId)).toMatchObject({ envName: 'CLOUDFLARE_API_TOKEN' });
    const given = await ok(await t.commit(IDS.mara, giveVaultKey, { entryId: cfId }));
    expect(given.eventId).toBeNull();
    // The person's view says so.
    const cookie = (await sessionFor(t.services, IDS.mara)).cookie;
    const res = await t.api.inject({
      method: 'GET',
      url: `/api/v1/burrows/burrow-hq/vault/${cfId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entry).toMatchObject({ agentOn: true, key: { envName: 'CLOUDFLARE_API_TOKEN' } });
  });

  it('changes an API’s variable over REST (the person), checks it, and refuses other kinds', async () => {
    await ok(await t.commit(IDS.mara, giveVaultKey, { entryId: basicId }));
    expect(await keyRow(basicId)).toMatchObject({ envName: 'REGISTRY' });
    const cookie = (await sessionFor(t.services, IDS.mara)).cookie;
    const put = (entryId: string, body: object, who = cookie) =>
      t.api.inject({
        method: 'PUT',
        url: `/api/v1/burrows/burrow-hq/vault/${entryId}/key/env-name`,
        headers: { cookie: who },
        payload: body,
      });
    const changed = await put(basicId, { envName: 'REGISTRY_LOGIN' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().eventId).toBeTruthy();
    expect(await keyRow(basicId)).toMatchObject({ envName: 'REGISTRY_LOGIN' });
    for (const reserved of ['PATH', 'LD_PRELOAD'])
      expect((await put(basicId, { envName: reserved })).statusCode).toBe(400);
    // An SSH key's key is a file: no variable.
    await ok(await t.commit(IDS.mara, giveVaultKey, { entryId: sshId }));
    expect((await put(sshId, { envName: 'DEPLOY_KEY' })).statusCode).toBe(409);
    expect(await keyRow(sshId)).toMatchObject({ envName: null });
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'vault.key.changed'))
      .orderBy(desc(events.createdAt))
      .limit(1);
    expect(event?.text).toContain('Dusty');
    expect((await put(basicId, { envName: 'REGISTRY' })).statusCode).toBe(200);
  });

  it('marks an SSH server Production on add and update, and the person sees it', async () => {
    await ok(
      await t.commit(IDS.mara, updateVaultSshServer, {
        entryId: sshId,
        serverId: web2,
        changes: { production: true },
      }),
    );
    const [row] = await t.services.db.select().from(vaultSshServers).where(eq(vaultSshServers.id, web2));
    expect(row?.production).toBe(true);
    await ok(
      await t.commit(IDS.mara, updateVaultSshServer, {
        entryId: sshId,
        serverId: web2,
        changes: { production: false },
      }),
    );
    const cookie = (await sessionFor(t.services, IDS.mara)).cookie;
    const res = await t.api.inject({
      method: 'GET',
      url: `/api/v1/burrows/burrow-hq/vault/${sshId}`,
      headers: { cookie },
    });
    const servers = res.json().entry.servers as { name: string; production: boolean }[];
    expect(servers.map((s) => [s.name, s.production])).toEqual([
      ['web-1', true],
      ['web-2', false],
    ]);
  });
});

describe('runner.turnKeys (AC-30, AC-31, AC-33)', () => {
  it('the person’s turn gets their keys: variables, the SSH key and a block for each trusted server', async () => {
    const d = await liveDispatch(t, { person: IDS.mara });
    const keys = await keysFor(d.id);
    expect(keys.env).toEqual([
      { name: 'CLOUDFLARE_API_TOKEN', value: CF_TOKEN },
      { name: 'REGISTRY_USERNAME', value: 'deployer' },
      { name: 'REGISTRY_PASSWORD', value: BASIC_PASSWORD },
    ]);
    const entryKey = (
      await t.services.db.select().from(vaultSshServers).where(eq(vaultSshServers.id, web1))
    )[0];
    expect(entryKey).toBeTruthy();
    const sshFile = keys.files.find((f) => f.path.startsWith('ssh/'));
    expect(sshFile?.mode).toBe('600');
    expect(
      Buffer.from(sshFile?.base64 ?? '', 'base64')
        .toString('utf8')
        .trim(),
    ).toBe(sshKey.trim());
    const config = fileOf(keys, 'ssh_config') ?? '';
    expect(config).toContain('Host web-1 web-1.example.com');
    expect(config).toContain('  User deploy');
    expect(config).toContain(`  IdentityFile /run/whombat/keys/${sshFile?.path}`);
    expect(config).toContain('  IdentitiesOnly yes');
    expect(config).toContain('  StrictHostKeyChecking yes');
    expect(config).toContain('  UserKnownHostsFile /run/whombat/keys/known_hosts');
    // web-2's host key was never trusted: no block.
    expect(config).not.toContain('web-2');
    expect(fileOf(keys, 'known_hosts')).toBe(`web-1.example.com ssh-ed25519 ${blob.toString('base64')}\n`);
    expect(keys.entries.map((e) => e.name)).toEqual(['Cloudflare API token', 'Deploy key', 'Registry']);
    // Each delivery is a use in the person's RECENT USE, once per turn.
    await keysFor(d.id);
    const uses = await t.services.db.select().from(vaultUses).where(eq(vaultUses.dispatchId, d.id));
    expect(uses).toHaveLength(3);
    expect(new Set(uses.map((u) => u.what)).size).toBe(1);
  });

  it('a name with capitals answers to its lowercase form too (VT-D61)', async () => {
    const rename = (name: string) =>
      t.services.db.update(vaultSshServers).set({ name }).where(eq(vaultSshServers.id, web1));
    await rename('Web-1');
    try {
      const d = await liveDispatch(t, { person: IDS.mara });
      expect(fileOf(await keysFor(d.id), 'ssh_config')).toContain('Host Web-1 web-1 web-1.example.com');
    } finally {
      await rename('web-1');
    }
  });

  it('an outsiders’ turn gets none of them (one-person.md OP-17, HE-43)', async () => {
    const none = { files: [], env: [], mcpServers: [], entries: [] };
    expect(await keysFor((await liveDispatch(t, { person: null })).id)).toEqual(none);
  });

  it('an entry switched off isn’t in the person’s turn; switching it on again keeps its variable (VLT-10)', async () => {
    const before = await keyRow(basicId);
    expect(before?.envName).toBeTruthy();
    const taken = await ok(await t.commit(IDS.mara, takeVaultKey, { entryId: basicId }));
    expect(taken.eventId).toBeTruthy();
    expect(await keyRow(basicId)).toBeUndefined();
    const d = await liveDispatch(t, { person: IDS.mara });
    expect((await keysFor(d.id)).env.map((e) => e.name)).toEqual(['CLOUDFLARE_API_TOKEN']);
    const given = await ok(await t.commit(IDS.mara, giveVaultKey, { entryId: basicId }));
    expect(given.eventId).toBeTruthy();
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.id, String(given.eventId)));
    expect(event?.type).toBe('vault.key.given');
    expect(await keyRow(basicId)).toEqual(before);
  });

  it('an MCP entry is Hermes’s server in the person’s turns only, with the tools left on (CT-1241)', async () => {
    const entryId = (
      await ok(
        await t.commit(IDS.mara, createVaultEntry, {
          kind: 'mcp',
          name: 'Home Assistant',
          url: 'https://ha.example.com/api/mcp',
          auth: { type: 'bearer' },
          secret: 'ha-llat-0123456789abcdef',
        }),
      )
    ).entryId;
    await t.services.db.insert(vaultTools).values([
      {
        entryId,
        name: 'HassTurnOn',
        description: '',
        inputSchema: null,
        hash: 'a',
        enabled: true,
        isNew: false,
        position: 0,
      },
      {
        entryId,
        name: 'HassWipe',
        description: '',
        inputSchema: null,
        hash: 'b',
        enabled: false,
        isNew: false,
        position: 1,
      },
    ] as never);
    const keys = await keysFor((await liveDispatch(t, { person: IDS.mara })).id);
    const [server] = keys.mcpServers;
    expect(server?.name).toMatch(/^vault_[a-z]{8}$/);
    expect(server).toMatchObject({
      url: 'https://ha.example.com/api/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer ha-llat-0123456789abcdef' }],
      tools: ['HassTurnOn'],
    });
    expect((await keysFor((await liveDispatch(t, { person: null })).id)).mcpServers).toEqual([]);
    await ok(await t.commit(IDS.mara, removeVaultEntry, { entryId }));
  });

  it('refuses a runner that doesn’t hold the dispatch, and a search answer gets nothing', async () => {
    const d = await liveDispatch(t, { person: IDS.mara });
    const res = await runnerCall(
      t,
      'GET',
      '/dispatches/:dispatchId/turn-keys',
      { dispatchId: d.id },
      undefined,
      { runnerId: 'rnr_someone_else', attempt: 1 },
    );
    expect(res.status).toBe(409);
    const search = await liveDispatch(t, { person: IDS.mara, trigger: 'search' });
    expect((await keysFor(search.id)).entries).toEqual([]);
  });
});

describe('DispatchContext.commands (OP-07, OP-S114)', () => {
  it('lists every production server with its public addresses, and the home networks', async () => {
    const d = await liveDispatch(t, { person: IDS.mara });
    const context = await commandsContextFor(t.services, { system: null }, d);
    expect(context).toEqual({
      productionServers: [
        { entryId: sshId, name: 'web-1', host: 'web-1.example.com', port: 22, addresses: ['93.184.216.34'] },
      ],
      homeNetworks: [],
      // “Agents may reach your local network”, on by default (resourceful-agents.md RA-41).
      lan: true,
    });
    // The whole context carries it (and the Vault entries name their variables).
    const built = await buildDispatchContext(t.services, d);
    expect(built.commands?.productionServers.map((s) => s.name)).toEqual(['web-1']);
    expect(built.outside).toBe(false);
    const cf = built.vault?.entries.find((e) => e.id === cfId);
    expect(cf).toMatchObject({ kind: 'http', envNames: ['CLOUDFLARE_API_TOKEN'] });
    // Not for a search answer.
    const search = await liveDispatch(t, { person: IDS.mara, trigger: 'search' });
    expect(await commandsContextFor(t.services, { system: null }, search)).toBeNull();
    // Nor for an outsiders' turn (OP-17).
    const outside = await liveDispatch(t, { person: null });
    expect(await commandsContextFor(t.services, { system: null }, outside)).toBeNull();
  });
});

describe('a turn gets exactly the entries switched on (VLT-10)', () => {
  it('lists the switched-on entries, the rest as unheld, and follows give and take', async () => {
    const on = async () =>
      (
        await t.services.db
          .select({ id: vaultEntries.id })
          .from(vaultEntries)
          .where(isNotNull(vaultEntries.agentOnAt))
      )
        .map((r) => r.id)
        .sort();
    await ok(await t.commit(IDS.mara, takeVaultKey, { entryId: basicId }));
    const built = await buildDispatchContext(t.services, await liveDispatch(t, { person: IDS.mara }));
    const held = (built.vault?.entries ?? []).map((e) => e.id).sort();
    expect(held).toEqual(await on());
    expect(held).toEqual(expect.arrayContaining([cfId, sshId]));
    expect(held).not.toContain(basicId);
    expect(built.vault?.unheld.map((e) => e.id)).toContain(basicId);
    await ok(await t.commit(IDS.mara, giveVaultKey, { entryId: basicId }));
    const again = await buildDispatchContext(t.services, await liveDispatch(t, { person: IDS.mara }));
    expect(again.vault?.entries.map((e) => e.id)).toContain(basicId);
    expect(again.vault?.unheld.map((e) => e.id)).not.toContain(basicId);
    // An outsiders' turn gets none of them (OP-17).
    const outside = await buildDispatchContext(t.services, await liveDispatch(t, { person: null }));
    expect(outside.vault).toBeNull();
  });
});

describe('what an agent posts is scrubbed of the values it holds (AC-32)', () => {
  it('replaces every form of a key’s value in its messages and activity', async () => {
    const posted = await ok(
      await t.commit(IDS.dusty, sendMessage, {
        conversationId: IDS.billing,
        text: `Used ${CF_TOKEN} and Basic ${Buffer.from(`deployer:${BASIC_PASSWORD}`).toString('base64')}`,
      }),
    );
    const [row] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, (posted as { id: string }).id));
    expect(row?.text).toBe(`Used ${VAULT_SCRUBBED} and Basic ${VAULT_SCRUBBED}`);
    // Activity the runner reports for Dusty's turn.
    const d = await liveDispatch(t, { person: IDS.mara });
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
          object: `curl -H "Authorization: Bearer ${CF_TOKEN}"`,
          exitCode: 0,
          failure: null,
          keyNeeded: null,
          approvalId: null,
          evidence: { input: `echo ${CF_TOKEN}`, output: CF_TOKEN, truncated: false },
          at: t.services.clock().toISOString(),
        },
      ],
    } as never);
    const [activity] = await t.services.db.execute<{ object: string; evidence: unknown }>(
      `select object, evidence from activities where dispatch_id = '${d.id}'` as never,
    );
    expect(JSON.stringify(activity)).not.toContain(CF_TOKEN);
    expect(activity?.object).toContain(VAULT_SCRUBBED);
  });
});

describe('taking a key back tells the person to rotate it (AC-34)', () => {
  it('on a take-back and removing the entry (an SSH key lists its servers)', async () => {
    const before = (await dmLines(mara.dmId)).length;
    await ok(await t.commit(IDS.mara, takeVaultKey, { entryId: basicId }));
    let lines = await dmLines(mara.dmId);
    // Facts, not the sentence: the entry, and that a copy may be kept.
    expect(lines.at(-1)).toContain('“Registry”');
    expect(lines.at(-1)).toContain('kept a copy');
    await ok(await t.commit(IDS.mara, takeVaultKey, { entryId: sshId }));
    lines = await dmLines(mara.dmId);
    expect(lines.at(-1)).toContain('“Deploy key”');
    expect(lines.at(-1)).toContain(
      '- web-1 · deploy@web-1.example.com:22\n- web-2 · deploy@web-2.example.com:2222',
    );
    // A key already taken back says nothing again.
    await ok(await t.commit(IDS.mara, takeVaultKey, { entryId: basicId }));
    expect((await dmLines(mara.dmId)).length).toBe(lines.length);
    await ok(await t.commit(IDS.mara, removeVaultEntry, { entryId: cfId }));
    lines = await dmLines(mara.dmId);
    expect(lines.at(-1)).toContain('“Cloudflare API token”');
    expect(lines.length).toBe(before + 3);
  });
});

describe('a use’s signed line and the person’s record (VT-50…VT-52, VT-D22, VT-D46)', () => {
  // Longer than the 300 characters a record keeps: the row and the signed detail keep the same cut.
  const what = `sign in ${'x'.repeat(400)}`;
  const kept = what.slice(0, 300);

  /** Commits as the agent; also returns the `vault.updated` frames the commit published. */
  async function asAgent<R>(command: CommandDef<z.ZodType, R>, input: unknown) {
    const frames: BusFrame[] = [];
    const off = t.services.bus.onFrame((f) => {
      if (f.event.type === 'vault.updated') frames.push(f);
    });
    try {
      return { result: await ok(await t.commit(IDS.dusty, command, input)), frames };
    } finally {
      off();
    }
  }

  const updated = (entryId: string) => [
    expect.objectContaining({ topic: topics.me(IDS.mara), event: { type: 'vault.updated', entryId } }),
  ];

  /** The signed line and the person's row behind one use, both whole. */
  async function expectUse(
    eventId: string | null,
    entryId: string,
    want: {
      outcome: VaultUseOutcome;
      dispatchId: string | null;
      requesterId: string | null;
      where: string | null;
      status: number | null;
      server: string | null;
      ms: number;
      bytes: number | null;
    },
  ) {
    const entry = await entryById(t.services.db, entryId);
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.id, eventId ?? ''));
    const [use] = await t.services.db
      .select()
      .from(vaultUses)
      .where(eq(vaultUses.eventId, eventId ?? ''));
    if (!entry || !event || !use) throw new Error('no use');
    const refused = want.outcome === 'refused';
    expect(event).toMatchObject({
      actorId: IDS.dusty,
      type: refused ? 'vault.refused' : 'vault.used',
      kind: refused ? 'Blocked' : 'Vault',
      text: vaultAuditText(refused ? 'refused' : 'used'),
      where: want.where,
    });
    expect(event.payload).toEqual({
      entryId,
      useId: use.id,
      dispatchId: want.dispatchId,
      detail: detailHash(entry, { entryId, entryName: entry.name, what: kept, outcome: want.outcome }),
    });
    expect(use).toEqual({
      id: expect.stringMatching(/^vlu_/),
      burrowId: t.burrowId,
      entryId,
      agentId: IDS.dusty,
      requesterId: want.requesterId,
      dispatchId: want.dispatchId,
      what: kept,
      outcome: want.outcome,
      status: want.status,
      server: want.server,
      exitCode: null,
      ms: want.ms,
      bytes: want.bytes,
      eventId,
      at: event.createdAt,
    });
  }

  it('a refused sign-in: with the entry a row for the person, without one only the neutral line', async () => {
    const entryId = (
      await ok(
        await t.commit(IDS.mara, createVaultEntry, {
          kind: 'login',
          name: 'Bank',
          url: 'https://bank.example.com/signin',
          auth: { type: 'form', username: 'mara' },
          secret: 'bank-pass-7c6b5a49',
        }),
      )
    ).entryId;
    await ok(await t.commit(IDS.mara, takeVaultKey, { entryId }));
    const d = await liveDispatch(t, { person: IDS.mara });
    const where = await whereOf(t.services.db, d.conversationId);
    const refused = await asAgent(decideVaultUseCommand, {
      dispatchId: d.id,
      entryId,
      kind: 'sign_in',
      what,
    });
    expect(refused.result).toMatchObject({ kind: 'blocked' });
    const { eventId } = refused.result as { eventId: string };
    await expectUse(eventId, entryId, {
      outcome: 'refused',
      dispatchId: d.id,
      requesterId: IDS.mara,
      where,
      status: null,
      server: null,
      ms: 0,
      bytes: null,
    });
    expect(refused.frames).toEqual(updated(entryId));
    const unknown = await asAgent(decideVaultUseCommand, {
      dispatchId: d.id,
      entryId: newId('vaultEntry'),
      kind: 'sign_in',
      what,
    });
    const unknownId = (unknown.result as { eventId: string }).eventId;
    const [line] = await t.services.db.select().from(events).where(eq(events.id, unknownId));
    expect(line).toMatchObject({ type: 'vault.refused', kind: 'Blocked', where });
    expect(line?.payload).toEqual({ dispatchId: d.id });
    expect(await t.services.db.select().from(vaultUses).where(eq(vaultUses.eventId, unknownId))).toEqual([]);
    expect(unknown.frames).toEqual([]);
  });

  it('a recorded use, done or refused, and with no turn', async () => {
    const entryId = (
      await ok(
        await t.commit(IDS.mara, createVaultEntry, {
          kind: 'http',
          name: 'Status page',
          url: 'https://status.example.com',
          auth: { type: 'bearer' },
          secret: 'status-token-4b3c2d1e',
        }),
      )
    ).entryId;
    const d = await liveDispatch(t, { person: IDS.mara });
    const done = await asAgent(recordVaultUse, {
      entryId,
      dispatchId: d.id,
      what,
      outcome: 'done',
      status: 200,
      ms: 12,
      bytes: 345,
    });
    await expectUse(done.result.eventId, entryId, {
      outcome: 'done',
      dispatchId: d.id,
      requesterId: IDS.mara,
      where: await whereOf(t.services.db, d.conversationId),
      status: 200,
      server: null,
      ms: 12,
      bytes: 345,
    });
    expect(done.frames).toEqual(updated(entryId));
    expect((await entryById(t.services.db, entryId))?.lastUsedAt).toBeTruthy();
    const refused = await asAgent(recordVaultUse, {
      entryId,
      dispatchId: null,
      what,
      outcome: 'refused',
      status: null,
      ms: 3,
      bytes: null,
    });
    await expectUse(refused.result.eventId, entryId, {
      outcome: 'refused',
      dispatchId: null,
      requesterId: null,
      where: null,
      status: null,
      server: null,
      ms: 3,
      bytes: null,
    });
    expect(refused.frames).toEqual(updated(entryId));
  });

  it('a changed host key met by the agent: refused, naming the server', async () => {
    const d = await liveDispatch(t, { person: IDS.mara });
    const met = await asAgent(sshHostKeyChanged, {
      entryId: sshId,
      serverId: web2,
      hostKey: { algorithm: 'ssh-ed25519', fingerprint: vaultSshFingerprintOfBlob(hostKeyBlob()) },
      dispatchId: d.id,
      what,
      requesterId: IDS.mara,
      where: 'Somewhere else',
      ms: 9,
    });
    await expectUse(met.result.eventId, sshId, {
      outcome: 'refused',
      dispatchId: d.id,
      requesterId: IDS.mara,
      where: 'Somewhere else',
      status: null,
      server: 'web-2',
      ms: 9,
      bytes: null,
    });
    expect(met.frames).toEqual(updated(sshId));
  });
});
