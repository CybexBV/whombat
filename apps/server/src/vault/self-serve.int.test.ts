/**
 * The assistant runs the Vault for its person (docs/decisions/vault-self-serve.md VS-01…VS-14), against Postgres and
 * real agent tokens through `/mcp`: keys that come with each save and once at start for older entries (except one its
 * person took back); `vault_save` from the person's own chat (refused in a room others read, outside their turn, for a
 * secret they didn't write, for an address the Vault refuses), blanking the message and scrubbing the assistant's next
 * post; `vault_add_server` against the install SSH fake (a new “Servers” key, already, the key signing in, a password
 * used once, a pinned key that doesn't match, several keys; a key at the old Ask as off); first contact when a key first
 * reaches the agent's commands (hermes-engine.md HE-43) and the person's Check.
 */
import { api, type RealtimeEvent, VAULT_BLANKED, VAULT_SCRUBBED, vaultSshFingerprint } from '@whombat/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { turnKeysFor } from '../agent-commands/keys';
import { sendMessage } from '../commands/messages';
import { approvals, dispatches, events, messages, vaultEntries, vaultSshServers } from '../db/schema/index';
import { type FakeInstallSsh, fakeInstallSsh } from '../hosts/testing/fake-install-ssh';
import { loadMessage } from '../read/messages';
import type { BusFrame } from '../realtime/bus';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { accountOf, agentTokenFor } from '../test/tokens';
import { useVaultNetForTests, type VaultNet } from './net';
import { entryById, vaultSecretAad } from './store';
import { HOSTS, useVaultWorld } from './testing/world';

// The local network closed: private addresses need the home network list (VT-12, LN-01).
const t = useTestServer({ seed: true, listen: true, env: { WHOMBAT_LOCAL_NETWORK: 'off' } });
const w = useVaultWorld(t);
const frames: BusFrame[] = [];
let ssh: FakeInstallSsh;
let account: Record<'mara' | 'outsiders', string | null>;
let me: PersonalSetup;

for (const n of [30, 31, 32, 33, 34, 35, 36]) HOSTS[`box${n}.home.test`] = [`192.168.79.${n}`];

const NET: VaultNet = {
  resolve: async (host) => {
    const list = HOSTS[host];
    if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
  // box36 answers nothing: nobody listens on 127.0.0.2.
  dialAddress: (a) =>
    a === '192.168.79.36'
      ? '127.0.0.2'
      : a.startsWith('192.168.77.') || a.startsWith('192.168.79.')
        ? '127.0.0.1'
        : a,
  deadlineMs: 3000,
};

beforeAll(async () => {
  t.services.bus.onFrame((f) => frames.push(f));
  ssh = await fakeInstallSsh();
  ssh.users.set('root', { password: 'r00t-Box-Password', uid: 0, sudo: 'nopasswd', authorized: [] });
  ssh.users.set('deploy', { password: 'Dep-l0y-Passw0rd', uid: 1000, sudo: 'password', authorized: [] });
  account = {
    mara: await accountOf(t.services, IDS.mara),
    // An outsiders' turn is queued for nobody (one-person.md OP-17).
    outsiders: null,
  };
  me = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { name: 'Dusty', services: null });
  await w.listHomeNetwork();
  useVaultNetForTests(t.services, NET);
  const res = await w.call(
    api.vaultNetworks.add,
    {},
    { cidr: '192.168.79.0/24', ports: [ssh.port], note: 'The SSH fake' },
    'mara',
  );
  expect(res.status, res.raw).toBe(201);
});

afterAll(async () => {
  await ssh?.close();
});

async function turn(agent: PersonalSetup | string, by: keyof typeof account, conversationId?: string) {
  const agentId = typeof agent === 'string' ? agent : agent.agentId;
  const where = conversationId ?? (typeof agent === 'string' ? IDS.billing : agent.dmId);
  const d = await agentTokenFor(t.services, t.burrowId, agentId, where, { onBehalfOfAccountId: account[by] });
  return { ...d, mcp: await mcpClient(t.baseUrl, d.token) };
}

async function call(mcp: TestMcp, name: string, args: Record<string, unknown>) {
  const res = await mcp.client.callTool({ name, arguments: args });
  return {
    isError: res.isError === true,
    body: (res.structuredContent ?? {}) as Record<string, unknown>,
    raw: JSON.stringify(res),
  };
}

async function say(by: string, conversationId: string, text: string): Promise<string> {
  const res = await t.commit(by, sendMessage, { conversationId, text });
  if (res.status !== 'ok') throw new Error('not sent');
  return (res.result as { id: string }).id;
}

async function dispatchRow(id: string) {
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  if (!row) throw new Error('no dispatch');
  return row;
}

/** The entry's switch for the agent (vault-simplify.md VLT-10), as a list: one while it is on, none while it is off. */
async function keysOf(entryId: string) {
  const [e] = await t.services.db.select().from(vaultEntries).where(eq(vaultEntries.id, entryId));
  return e?.agentOnAt ? [{ agentId: me.agentId, servers: e.agentServers, envName: e.envName }] : [];
}

async function lastEvent(type: string) {
  const [e] = await t.services.db
    .select()
    .from(events)
    .where(eq(events.type, type))
    .orderBy(desc(events.seq))
    .limit(1);
  return e;
}

async function create(who: 'mara', body: Record<string, unknown>) {
  const res = await w.call(api.vault.create, {}, body, who);
  expect(res.status, res.raw).toBe(201);
  return (res.body.entry as { id: string }).id;
}

const http = (name: string, secret = 'api-token-0123456789') => ({
  kind: 'http',
  name,
  url: w.apiUrl(),
  auth: { type: 'bearer' },
  secret,
});

describe('keys come by themselves (VS-01, VS-02)', () => {
  it('gives the person’s agent a key with every save', async () => {
    const api1 = await create('mara', http('Registry'));
    expect(await keysOf(api1)).toEqual([
      expect.objectContaining({ agentId: me.agentId, servers: null, envName: 'REGISTRY' }),
    ]);
    const given = await lastEvent('vault.key.given');
    expect(given).toMatchObject({ actorId: IDS.mara, aboutId: me.agentId });
    expect(given?.text).toContain('Dusty');
    // A `secret` entry isn't made any more (skill-store.md SST-09, contracts CT-820).
    const refused = await w.call(
      api.vault.create,
      {},
      { kind: 'secret', name: 'Pack token', secret: 'pack-secret-value' },
      'mara',
    );
    expect(refused.status).toBe(400);
    const key = await create('mara', { kind: 'ssh', name: 'Deploy', sshKey: { mode: 'generate' } });
    expect((await keysOf(key)).map((k) => k.agentId)).toEqual([me.agentId]);
    // The SSH key goes again: vault_add_server below starts with none (VS-09).
    await w.call(api.vault.remove, { entryId: key }, undefined);
    const hers = await create('mara', http('Mail'));
    expect((await keysOf(hers)).map((k) => k.agentId)).toEqual([me.agentId]);
  });
});

describe('vault_save (VS-04…VS-08)', () => {
  const password = 'pl3x-Secret-pass!';
  let plex = '';
  let sent = '';

  it('saves a login sent in the person’s own chat, gives the key and blanks the message', async () => {
    sent = await say(IDS.mara, me.dmId, `Plex login: mara@example.com / ${password}`);
    const before = frames.length;
    const own = await turn(me, 'mara');
    const res = await call(own.mcp, 'vault_save', {
      kind: 'login',
      name: 'Plex',
      address: w.haUrl('/login'),
      username: 'mara@example.com',
      secret: password,
    });
    expect(res.body, res.raw).toMatchObject({ status: 'ok', name: 'Plex', created: true, blanked: 1 });
    plex = String(res.body.entryId);
    const row = await entryById(t.services.db, plex);
    expect(row).toMatchObject({ ownerId: IDS.mara, kind: 'login', savedById: me.agentId });
    expect(t.services.custody.open(vaultSecretAad(plex), row?.sealed ?? '')).toBe(password);
    expect((await keysOf(plex)).map((k) => k.agentId)).toEqual([me.agentId]);
    const saved = await lastEvent('vault.entry.saved');
    expect(saved).toMatchObject({ actorId: me.agentId, kind: 'Vault' });
    expect(saved?.payload).toMatchObject({ entryId: plex, messageIds: [sent] });
    expect(JSON.stringify(saved)).not.toContain(password);
    // The message: blanked, the line under it, not marked edited, and sent to the room.
    const message = await loadMessage(t.services.db, sent, IDS.mara);
    expect(message?.text).toContain(VAULT_BLANKED);
    expect(message?.text).not.toContain(password);
    expect(message?.editedAt).toBeNull();
    expect(message?.vaultSaved).toEqual([
      expect.objectContaining({ entryId: plex, name: 'Plex', kind: 'login', how: 'saved', server: null }),
    ]);
    const updated = frames
      .slice(before)
      .map((f) => f.event as RealtimeEvent)
      .find((e) => e.type === 'message.updated' && e.message.id === sent);
    expect(updated).toBeDefined();
    await own.mcp.close();
  });

  it('scrubs what it saved from everything the assistant writes', async () => {
    const res = await t.commit(me.agentId, sendMessage, {
      conversationId: me.dmId,
      text: `Your Plex password is ${password}`,
    });
    expect(res.status).toBe('ok');
    const [last] = await t.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, me.dmId), eq(messages.authorId, me.agentId)))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    expect(last?.text).toContain(VAULT_SCRUBBED);
    expect(last?.text).not.toContain(password);
  });

  it('refuses a secret the person didn’t write there, and replaces a saved one without moving it', async () => {
    const own = await turn(me, 'mara');
    const notWritten = await call(own.mcp, 'vault_save', {
      kind: 'token',
      name: 'Planted',
      address: w.apiUrl(),
      secret: 'never-written-by-joris',
    });
    expect(notWritten.body).toMatchObject({ status: 'failed', reason: 'invalid_request' });
    expect(String(notWritten.body.message)).toContain('Mara');
    // A new password for Plex goes to that entry; an address with it is refused by the contract.
    const moved = await call(own.mcp, 'vault_save', {
      kind: 'login',
      entry: plex,
      address: 'https://elsewhere.example',
      secret: 'N3w-Plex-pass!',
    });
    expect(moved.isError).toBe(true);
    const next = await say(IDS.mara, me.dmId, 'New Plex password: N3w-Plex-pass!');
    const replaced = await call(own.mcp, 'vault_save', {
      kind: 'login',
      entry: plex,
      secret: 'N3w-Plex-pass!',
    });
    expect(replaced.body).toMatchObject({ status: 'ok', entryId: plex, created: false, blanked: 1 });
    const row = await entryById(t.services.db, plex);
    expect(t.services.custody.open(vaultSecretAad(plex), row?.sealed ?? '')).toBe('N3w-Plex-pass!');
    expect(row?.url).toBe(w.haUrl('/login'));
    expect(await lastEvent('vault.entry.secret_replaced')).toMatchObject({ actorId: me.agentId });
    expect((await loadMessage(t.services.db, next, IDS.mara))?.text).toBe(
      `New Plex password: ${VAULT_BLANKED}`,
    );
    // An entry of another kind isn't one to replace.
    expect(
      (await call(own.mcp, 'vault_save', { kind: 'token', entry: plex, secret: 'N3w-Plex-pass!' })).body,
    ).toMatchObject({ status: 'failed', reason: 'invalid_request' });
    await own.mcp.close();
  });

  it('blanks only the messages of the anchor’s 7 days, never an older one with the same text', async () => {
    const old = await say(IDS.mara, me.dmId, 'my old locker code was sh0rt-9');
    await t.services.db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(messages.id, old));
    const fresh = await say(IDS.mara, me.dmId, 'the NAS token is sh0rt-9');
    const own = await turn(me, 'mara');
    const res = await call(own.mcp, 'vault_save', {
      kind: 'token',
      name: 'NAS',
      address: w.apiUrl(),
      secret: 'sh0rt-9',
    });
    expect(res.body, res.raw).toMatchObject({ status: 'ok', blanked: 1 });
    expect((await loadMessage(t.services.db, fresh, IDS.mara))?.text).toBe(
      `the NAS token is ${VAULT_BLANKED}`,
    );
    expect((await loadMessage(t.services.db, old, IDS.mara))?.text).toBe('my old locker code was sh0rt-9');
    await own.mcp.close();
  });

  it('saves a password it made itself without looking for it in chat', async () => {
    const own = await turn(me, 'mara');
    const made = await call(own.mcp, 'vault_save', {
      kind: 'basic',
      name: 'Database',
      address: w.apiUrl(),
      username: 'app',
      secret: 'Made-By-Wren-0042',
      made: true,
    });
    expect(made.body).toMatchObject({ status: 'ok', created: true, blanked: 0 });
    await own.mcp.close();
  });

  it('refuses an outsiders’ turn and an address the Vault refuses (OP-17)', async () => {
    const others = await turn(me, 'outsiders');
    expect(
      (
        await call(others.mcp, 'vault_save', {
          kind: 'token',
          name: 'X',
          address: w.apiUrl(),
          secret: password,
        })
      ).body,
    ).toMatchObject({ error: { code: 'forbidden' } });
    await others.mcp.close();
    await say(IDS.mara, me.dmId, 'printer token: printer-Token-777');
    const own = await turn(me, 'mara');
    const printer = await call(own.mcp, 'vault_save', {
      kind: 'token',
      name: 'Printer',
      address: 'http://printer.home.test:631',
      secret: 'printer-Token-777',
    });
    expect(printer.body).toMatchObject({ status: 'failed', reason: 'not_allowed' });
    expect(await t.services.db.select().from(vaultEntries).where(eq(vaultEntries.name, 'Printer'))).toEqual(
      [],
    );
    await own.mcp.close();
  });
});

describe('vault_add_server (VS-09…VS-11)', () => {
  let servers = '';
  let line = '';
  const addr = (n: number) => `box${n}.home.test:${ssh.port}`;

  it('makes a “Servers” key when the person has none, trusts the server and gives the line to add', async () => {
    const own = await turn(me, 'mara');
    const res = await call(own.mcp, 'vault_add_server', { address: addr(30) });
    expect(res.body, res.raw).toMatchObject({
      status: 'ok',
      entryName: 'Servers',
      server: 'box30-home-test',
      target: `root@box30.home.test:${ssh.port}`,
      outcome: 'key_refused',
    });
    servers = String(res.body.entryId);
    line = String(res.body.publicKey);
    expect(line).toMatch(/^restrict ssh-ed25519 AAAA/);
    const row = await entryById(t.services.db, servers);
    expect(row).toMatchObject({ ownerId: IDS.mara, kind: 'ssh', savedById: null });
    expect((await keysOf(servers)).map((k) => k.agentId)).toEqual([me.agentId]);
    const [server] = await t.services.db
      .select()
      .from(vaultSshServers)
      .where(eq(vaultSshServers.entryId, servers));
    expect(server).toMatchObject({ hostKeyFingerprint: ssh.hostKey().fingerprint, checkOutcome: 'rejected' });
    expect(await lastEvent('vault.entry.changed')).toMatchObject({ actorId: me.agentId });
    // Asked again: already there, nothing dialled.
    const tries = ssh.tries.length;
    const again = await call(own.mcp, 'vault_add_server', { address: addr(30) });
    expect(again.body).toMatchObject({ status: 'ok', outcome: 'already', server: 'box30-home-test' });
    expect(ssh.tries.length).toBe(tries);
    await own.mcp.close();
  });

  it('signs in with the key once it is on the server, named by the server’s own host name', async () => {
    ssh.users.get('root')?.authorized.push(line);
    ssh.hostname = 'Box-Two';
    const own = await turn(me, 'mara');
    const res = await call(own.mcp, 'vault_add_server', { address: addr(31) });
    expect(res.body, res.raw).toMatchObject({
      status: 'ok',
      entryId: servers,
      server: 'box-two',
      outcome: 'signed_in',
      publicKey: null,
    });
    // For the commands from the next turn's keys (HE-43): its block names the server by its own host name.
    const keys = await turnKeysFor(t.services, await dispatchRow(own.dispatchId));
    const config = keys.files.find((f) => f.path === 'ssh_config');
    expect(Buffer.from(config?.base64 ?? '', 'base64').toString('utf8')).toContain('Host box-two');
    await own.mcp.close();
  });

  it('ignores a password: never used or kept, blanked where the person wrote it (VLT-43)', async () => {
    const secret = 'Dep-l0y-Passw0rd';
    const sent = await say(IDS.mara, me.dmId, `deploy's password is ${secret}`);
    const own = await turn(me, 'mara');
    const res = await call(own.mcp, 'vault_add_server', {
      address: addr(30),
      username: 'deploy',
      password: secret,
    });
    // The key isn't on the server: added and trusted, the agent told to ask with a server card.
    expect(res.body, res.raw).toMatchObject({
      status: 'ok',
      entryId: servers,
      target: `deploy@box30.home.test:${ssh.port}`,
      outcome: 'key_refused',
      publicKey: line,
    });
    expect(ssh.users.get('deploy')?.authorized).toEqual([]);
    const message = await loadMessage(t.services.db, sent, IDS.mara);
    expect(message?.text).toBe(`deploy's password is ${VAULT_BLANKED}`);
    expect(message?.vaultSaved).toBeUndefined();
    // Never signed; scrubbed from what the assistant writes for the rest of the turn.
    const signed = await t.services.db
      .select({ id: events.id })
      .from(events)
      .where(
        sql`strpos(${events.payload}::text, ${secret}) > 0 or strpos(coalesce(${events.text}, ''), ${secret}) > 0`,
      );
    expect(signed).toEqual([]);
    const posted = await t.commit(me.agentId, sendMessage, {
      conversationId: me.dmId,
      text: `I used ${secret}`,
    });
    expect(posted.status).toBe('ok');
    const [last] = await t.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, me.dmId), eq(messages.authorId, me.agentId)))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    expect(last?.text).toBe(`I used ${VAULT_SCRUBBED}`);
    await own.mcp.close();
  });

  it('refuses a key that isn’t the one the person’s Vault pins for that address', async () => {
    await t.services.db.insert(vaultSshServers).values({
      id: 'vss_pinnedother1',
      burrowId: t.burrowId,
      entryId: servers,
      name: 'old-box',
      host: 'box32.home.test',
      port: ssh.port,
      username: 'root',
      production: false,
      hostKeyAlgorithm: 'ssh-ed25519',
      hostKeyFingerprint: vaultSshFingerprint(line.split(' ').slice(1, 3).join(' ')),
      hostKeyTrustedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const own = await turn(me, 'mara');
    const res = await call(own.mcp, 'vault_add_server', { address: addr(32), username: 'deploy' });
    expect(res.body).toMatchObject({ status: 'failed', reason: 'host_key_changed' });
    const rows = await t.services.db
      .select()
      .from(vaultSshServers)
      .where(and(eq(vaultSshServers.host, 'box32.home.test'), eq(vaultSshServers.username, 'deploy')));
    expect(rows).toEqual([]);
    await own.mcp.close();
  });

  it('asks which key when the person has several', async () => {
    await create('mara', { kind: 'ssh', name: 'Second', sshKey: { mode: 'generate' } });
    const own = await turn(me, 'mara');
    const res = await call(own.mcp, 'vault_add_server', { address: addr(33) });
    expect(res.body).toMatchObject({ status: 'blocked' });
    expect(String(res.body.message)).toContain('“Second”');
    expect(String(res.body.message)).toContain('“Servers”');
    await own.mcp.close();
  });

  it('blanks a password passed anyway whatever happens next: a server that doesn’t answer', async () => {
    const own = await turn(me, 'mara');
    const away = await say(IDS.mara, me.dmId, 'box36 root password: Unreach-Pass-36');
    const unreachable = await call(own.mcp, 'vault_add_server', {
      entry: servers,
      address: `box36.home.test:${ssh.port}`,
      password: 'Unreach-Pass-36',
    });
    expect(unreachable.body, unreachable.raw).toMatchObject({ status: 'failed', reason: 'unreachable' });
    expect((await loadMessage(t.services.db, away, IDS.mara))?.text).toBe(
      `box36 root password: ${VAULT_BLANKED}`,
    );
    // Nothing added for either.
    const added = await t.services.db
      .select()
      .from(vaultSshServers)
      .where(eq(vaultSshServers.entryId, servers));
    expect(added.map((r) => r.host)).not.toContain('box35.home.test');
    expect(added.map((r) => r.host)).not.toContain('box36.home.test');
    await own.mcp.close();
  });

  it('a key switched off asks nobody and says how to switch it back on (HE-43, VLT-10)', async () => {
    await t.services.db.update(vaultEntries).set({ agentOnAt: null }).where(eq(vaultEntries.id, servers));
    const own = await turn(me, 'mara');
    const tries = ssh.tries.length;
    const before = (await t.services.db.select({ id: approvals.id }).from(approvals)).length;
    const asked = await call(own.mcp, 'vault_add_server', { entry: servers, address: addr(33) });
    expect(asked.body, asked.raw).toMatchObject({ status: 'blocked' });
    expect(ssh.tries.length).toBe(tries);
    expect((await t.services.db.select({ id: approvals.id }).from(approvals)).length).toBe(before);
    expect(String(asked.body.message)).toContain('Dusty can use this');
    await own.mcp.close();
    await w.call(api.vault.giveKey, { entryId: servers, agent: me.handle }, {}, 'mara');
  });
});

describe('first contact (VS-10)', () => {
  it('trusts a new server’s key when the key first reaches the agent’s commands, signed by the agent', async () => {
    const keys = await w.call(api.vault.list, {}, undefined, 'mara');
    const servers = (keys.body.entries as { id: string; name: string }[]).find((e) => e.name === 'Servers');
    const added = await w.call(
      api.vault.addSshServer,
      { entryId: servers?.id ?? '' },
      { name: 'fresh', host: 'box34.home.test', port: ssh.port, username: 'root' },
      'mara',
    );
    expect(added.status, added.raw).toBe(201);
    const own = await turn(me, 'mara');
    const delivered = await turnKeysFor(t.services, await dispatchRow(own.dispatchId));
    const [row] = await t.services.db.select().from(vaultSshServers).where(eq(vaultSshServers.name, 'fresh'));
    expect(row?.hostKeyFingerprint).toBe(ssh.hostKey().fingerprint);
    expect(await lastEvent('vault.entry.changed')).toMatchObject({ actorId: me.agentId });
    const config = delivered.files.find((f) => f.path === 'ssh_config');
    expect(Buffer.from(config?.base64 ?? '', 'base64').toString('utf8')).toContain('Host fresh');
    await own.mcp.close();
  });

  it('meets nobody new when another server of the person’s pins another key there, nor does a Check', async () => {
    const keys = await w.call(api.vault.list, {}, undefined, 'mara');
    const second = (keys.body.entries as { id: string; name: string }[]).find((e) => e.name === 'Second');
    const added = await w.call(
      api.vault.addSshServer,
      { entryId: second?.id ?? '' },
      { name: 'other', host: 'box32.home.test', port: ssh.port, username: 'root' },
      'mara',
    );
    expect(added.status, added.raw).toBe(201);
    const serverId = String(added.body.serverId);
    const own = await turn(me, 'mara');
    const delivered = await turnKeysFor(t.services, await dispatchRow(own.dispatchId));
    const config = delivered.files.find((f) => f.path === 'ssh_config');
    expect(Buffer.from(config?.base64 ?? '', 'base64').toString('utf8')).not.toContain('Host other');
    await own.mcp.close();
    const checked = await w.call(
      api.vault.checkSshServer,
      { entryId: second?.id ?? '', serverId },
      undefined,
      'mara',
    );
    expect(checked.body.result).toMatchObject({ outcome: 'host_key_changed', hostKey: ssh.hostKey() });
    const [row] = await t.services.db.select().from(vaultSshServers).where(eq(vaultSshServers.id, serverId));
    expect(row?.hostKeyFingerprint).toBeNull();
  });
});
