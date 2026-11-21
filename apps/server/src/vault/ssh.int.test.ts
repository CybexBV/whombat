/**
 * SSH keys in the Vault against an in-process ssh2 server (docs/decisions/vault.md VT-S01…VT-S12, VT-D42…): generate →
 * add a server → check (first contact trusts its key, vault-self-serve.md VS-10) → trust again → sign in; refused
 * destinations; imports with a passphrase and refused key types. The agent's commands reach servers with the key they
 * get in the person's turns (hermes-engine.md HE-43; `agent-commands/keys.int.test.ts`): nothing is relayed.
 */
import { generateKeyPairSync } from 'node:crypto';
import { api, type DispatchContext, vaultEntryKey, vaultSshFingerprint } from '@whombat/core';
import { desc, eq } from 'drizzle-orm';
import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatches, events, vaultSshServers } from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { addPersonalAgent } from '../test/personal';
import { sshKeyPair } from '../test/ssh-keys';
import { agentTokenFor, type TestDispatchOptions } from '../test/tokens';
import { useVaultNetForTests, type VaultNet } from './net';
import { entryById, vaultSecretAad } from './store';
import { type FakeSsh, fakeSsh } from './testing/ssh-fake';
import { HOSTS, useVaultWorld } from './testing/world';

const { utils } = ssh2;
// The local network closed: private addresses need the home network list (VT-12, LN-01).
const t = useTestServer({ seed: true, listen: true, env: { WHOMBAT_LOCAL_NETWORK: 'off' } });
const w = useVaultWorld(t);
let fake: FakeSsh;

HOSTS['ssh.home.test'] = ['192.168.79.20'];
HOSTS['nas.home.test'] = ['192.168.79.21'];
HOSTS['other.home.test'] = ['192.168.80.5'];
HOSTS['ssh.example.com'] = ['93.184.216.34'];

/** The wait for a channel that never closes after its timeout: 5 s in production, a moment here (TS-S03). */
const CLOSE_GRACE_MS = 300;
const NET: VaultNet = {
  resolve: async (host) => {
    const list = HOSTS[host];
    if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
  dialAddress: (a) => (a.startsWith('192.168.77.') || a.startsWith('192.168.79.') ? '127.0.0.1' : a),
  deadlineMs: 3000,
  closeGraceMs: CLOSE_GRACE_MS,
};

beforeAll(async () => {
  fake = await fakeSsh();
  await addPersonalAgent(t.services, t.burrowId, IDS.mara, { name: 'Wren', services: null });
  // The SSH fake stands behind 192.168.79.0/24 (its port listed), the HTTP fakes behind 192.168.77.0/24.
  useVaultNetForTests(t.services, NET);
  const res = await w.call(
    api.vaultNetworks.add,
    {},
    { cidr: '192.168.79.0/24', ports: [fake.port], note: 'The SSH fake' },
    'mara',
  );
  expect(res.status, res.raw).toBe(201);
});

afterAll(async () => {
  await fake?.close();
});

async function _turn(agentId: string, options: TestDispatchOptions = {}) {
  const d = await agentTokenFor(t.services, t.burrowId, agentId, IDS.billing, options);
  const mcp = await mcpClient(t.baseUrl, d.token);
  return { ...d, mcp };
}

async function _call(mcp: TestMcp, name: string, args: Record<string, unknown>) {
  const res = await mcp.client.callTool({ name, arguments: args });
  return {
    isError: res.isError === true,
    body: (res.structuredContent ?? {}) as Record<string, unknown>,
    raw: JSON.stringify(res),
  };
}

async function _contextOf(dispatchId: string): Promise<DispatchContext> {
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!row) throw new Error('no dispatch');
  return buildDispatchContext(t.services, row);
}

type Entry = {
  id: string;
  auth: { type: string; publicKey: string; fingerprint: string; keyType: string; origin: string };
  servers: {
    id: string;
    name: string;
    hostKey: { fingerprint: string } | null;
    seenHostKey: { fingerprint: string } | null;
    check: { status: string; outcome: string | null; summary: string };
  }[];
  key: { servers: string[] | null } | null;
  check: { status: string; summary: string };
  serverCount: number;
  url: string | null;
  recentUses: { what: string; server: string | null; exitCode: number | null; outcome: string }[];
};

async function entry(id: string): Promise<Entry> {
  const res = await w.call(api.vault.get, { entryId: id }, undefined);
  expect(res.status, res.raw).toBe(200);
  return res.body.entry as Entry;
}

async function create(body: Record<string, unknown>) {
  const res = await w.call(api.vault.create, {}, { name: 'Servers', kind: 'ssh', ...body });
  return res;
}

async function addServer(entryId: string, body: Record<string, unknown>) {
  return w.call(api.vault.addSshServer, { entryId }, body);
}

describe('an SSH key from generating to running a command (VT-S02…VT-S08)', () => {
  let id = '';
  let web = '';

  it('generates a key whose private half never leaves the server', async () => {
    const res = await create({ description: 'Deploys', sshKey: { mode: 'generate' } });
    expect(res.status, res.raw).toBe(201);
    const e = res.body.entry as Entry;
    id = e.id;
    expect(e).toMatchObject({
      url: null,
      serverCount: 0,
      check: { status: 'unchecked', summary: 'No servers yet' },
      auth: { type: 'ssh_key', keyType: 'ed25519', origin: 'generated' },
    });
    expect(e.auth.publicKey).toMatch(/^ssh-ed25519 AAAA[A-Za-z0-9+/]+=*$/);
    expect(e.auth.fingerprint).toBe(vaultSshFingerprint(e.auth.publicKey));
    expect(res.raw).not.toContain('PRIVATE KEY');
    // Sealed under the entry's AAD, an OpenSSH key ssh2 reads, with the entry's comment.
    const row = await entryById(t.services.db, id);
    const key = t.services.custody.open(vaultSecretAad(id), row?.sealed ?? '');
    expect(key).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    const parsed = utils.parseKey(key);
    const one = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!one || one instanceof Error) throw new Error('unreadable');
    expect(one.comment).toBe(`whombat-${vaultEntryKey(id)}`);
    expect(`${one.type} ${one.getPublicSSH().toString('base64')}`).toBe(e.auth.publicKey);
    // An event, neutral.
    const [added] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'vault.entry.added'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(added?.text).toBe('Added a private Vault entry');
  });

  it('refuses the shapes an SSH key doesn’t take', async () => {
    expect((await create({})).status).toBe(400);
    expect((await create({ url: 'https://x.example', sshKey: { mode: 'generate' } })).status).toBe(400);
    expect((await w.call(api.vault.check, { entryId: id }, undefined)).body).toMatchObject({
      error: { details: { code: 'wrong_kind' } },
    });
    expect((await w.call(api.vault.setSecret, { entryId: id }, { value: 'x' })).body).toMatchObject({
      error: { details: { code: 'wrong_kind' } },
    });
  });

  it('adds a server and its first check trusts the key it shows (VS-10)', async () => {
    const res = await addServer(id, {
      name: 'web-1',
      host: 'SSH.home.test',
      port: fake.port,
      username: 'deploy',
    });
    expect(res.status, res.raw).toBe(201);
    web = String(res.body.serverId);
    const e = res.body.entry as Entry;
    expect(e.servers).toMatchObject([
      { id: web, name: 'web-1', hostKey: null, seenHostKey: null, check: { status: 'unchecked' } },
    ]);
    expect((res.body.entry as { servers: { host: string }[] }).servers[0]?.host).toBe('ssh.home.test');
    // The same name twice is refused.
    const twice = await addServer(id, {
      name: 'web-1',
      host: 'ssh.home.test',
      port: fake.port,
      username: 'x',
    });
    expect(twice.status).toBe(409);
    expect(twice.body).toMatchObject({ error: { details: { code: 'server_name_taken' } } });
    // Capitals are fine, but a name is taken ignoring case (VT-D61): `ssh` reads them as one alias.
    const capitals = await addServer(id, {
      name: 'WEB-1',
      host: 'ssh.home.test',
      port: fake.port,
      username: 'x',
    });
    expect(capitals.status, capitals.raw).toBe(409);
    expect(capitals.body).toMatchObject({ error: { details: { code: 'server_name_taken' } } });

    const checked = await w.call(api.vault.checkSshServer, { entryId: id, serverId: web }, undefined);
    expect(checked.status, checked.raw).toBe(200);
    // First contact: the key it showed is trusted (signed), then the check signs in, and the key isn't on it yet.
    expect(checked.body.result).toMatchObject({ outcome: 'rejected' });
    expect(checked.body.eventId).toEqual(expect.any(String));
    const server = (checked.body.entry as Entry).servers[0];
    expect(server?.hostKey?.fingerprint).toBe(fake.hostKey().fingerprint);
    expect(server?.seenHostKey).toBeNull();
    expect(fake.users).toEqual([]);
  });

  it('trusts only the key the person saw, then signs in once', async () => {
    const wrong = await w.call(
      api.vault.trustSshHostKey,
      { entryId: id, serverId: web },
      { fingerprint: `SHA256:${'A'.repeat(43)}` },
    );
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({
      error: { details: { code: 'host_key_mismatch', hostKey: fake.hostKey() } },
    });
    // Not authorized on the server yet: trusted, but the key is refused.
    const trusted = await w.call(
      api.vault.trustSshHostKey,
      { entryId: id, serverId: web },
      { fingerprint: fake.hostKey().fingerprint },
    );
    expect(trusted.status, trusted.raw).toBe(200);
    expect(trusted.body.eventId).toEqual(expect.any(String));
    expect(trusted.body.result).toMatchObject({
      outcome: 'rejected',
      summary: 'The server refused the key.',
    });
    const e = await entry(id);
    fake.authorized.add(e.auth.publicKey);
    const again = await w.call(api.vault.checkSshServer, { entryId: id, serverId: web }, undefined);
    expect(again.body.result).toMatchObject({
      outcome: 'reached',
      status: 'reached',
      summary: 'Signed in as deploy',
    });
    expect((again.body.entry as Entry).check).toMatchObject({
      status: 'reached',
      summary: 'Signed in as deploy',
    });
    expect((again.body.entry as Entry).servers[0]?.hostKey?.fingerprint).toBe(fake.hostKey().fingerprint);
    expect(fake.users).toEqual(['deploy']);
    // A check runs nothing.
    expect(fake.commands).toEqual([]);
  });
});

describe('where a server may be (VT-S06)', () => {
  let id = '';
  beforeAll(async () => {
    id = String(((await create({ name: 'Elsewhere', sshKey: { mode: 'generate' } })).body.entry as Entry).id);
  });

  it('refuses loopback, metadata, unlisted home addresses and public servers off the SSH ports', async () => {
    for (const [host, port, problem] of [
      ['127.0.0.1', 22, 'never'],
      ['169.254.169.254', 22, 'never'],
      ['other.home.test', 22, 'not_listed'],
      ['ssh.example.com', 2222, 'port_not_allowed'],
      ['ssh.home.test', 2200, 'not_listed'],
    ] as const) {
      const res = await addServer(id, { name: 'x', host, port, username: 'u' });
      expect(res.status, `${host}:${port} ${res.raw}`).toBe(403);
      expect(res.body).toMatchObject({ error: { details: { code: 'address_not_allowed', problem } } });
    }
    const listed = await addServer(id, { name: 'other', host: 'other.home.test', port: 22, username: 'u' });
    expect(listed.body).toMatchObject({
      error: {
        details: { suggestion: { cidr: '192.168.80.0/24', port: 22 } },
      },
    });
    // A public host on port 22 is fine (it isn't reached here).
    expect(
      (await addServer(id, { name: 'pub', host: 'ssh.example.com', port: 22, username: 'u' })).status,
    ).toBe(201);
  });
});

describe('importing a key (VT-S03)', () => {
  const passphrase = 'correct horse battery staple';

  it('opens an encrypted OpenSSH key with its passphrase, once', async () => {
    const pair = sshKeyPair('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 4 });
    const none = await create({ name: 'Mine', sshKey: { mode: 'import', privateKey: pair.private } });
    expect(none.status).toBe(400);
    expect(none.body).toMatchObject({
      error: {
        fields: {
          'sshKey.passphrase': [
            'That key is protected by a passphrase. Enter it below: it is used once and not kept.',
          ],
        },
      },
    });
    const wrong = await create({
      name: 'Mine',
      sshKey: { mode: 'import', privateKey: pair.private, passphrase: 'not it at all' },
    });
    expect(wrong.body).toMatchObject({
      error: { fields: { 'sshKey.passphrase': ['That passphrase doesn’t open the key.'] } },
    });
    const ok = await create({
      name: 'Mine',
      sshKey: { mode: 'import', privateKey: pair.private, passphrase },
    });
    expect(ok.status, ok.raw).toBe(201);
    const e = ok.body.entry as Entry;
    expect(e.auth).toMatchObject({ keyType: 'ed25519', origin: 'imported' });
    expect(e.auth.publicKey).toBe(pair.public.split(' ').slice(0, 2).join(' '));
    expect(ok.raw).not.toContain(passphrase);
    // Stored unencrypted inside the seal; the passphrase isn't kept.
    const row = await entryById(t.services.db, e.id);
    expect(JSON.stringify(row)).not.toContain(passphrase);
  });

  it('takes PEM keys (PKCS#1, SEC1, PKCS#8, encrypted) and signs in with RSA over SHA-2', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs1',
      format: 'pem',
    });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({
      type: 'sec1',
      format: 'pem',
    });
    const ed = generateKeyPairSync('ed25519').privateKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase,
    });
    const made: Record<string, Entry> = {};
    for (const [name, text, extra, keyType] of [
      ['rsa', rsa, {}, 'rsa'],
      ['ec', ec, {}, 'ecdsa'],
      ['ed', ed, { passphrase }, 'ed25519'],
    ] as const) {
      const res = await create({ name, sshKey: { mode: 'import', privateKey: String(text), ...extra } });
      expect(res.status, res.raw).toBe(201);
      made[name] = res.body.entry as Entry;
      expect(made[name]?.auth.keyType).toBe(keyType);
    }
    const r = made.rsa as Entry;
    expect(r.auth.publicKey).toMatch(/^ssh-rsa /);
    expect((made.ec as Entry).auth.publicKey).toMatch(/^ecdsa-sha2-nistp384 /);
    // RSA signs in with rsa-sha2-* (never ssh-rsa / SHA-1).
    fake.authorized.add(r.auth.publicKey);
    const add = await addServer(r.id, {
      name: 'web',
      host: 'ssh.home.test',
      port: fake.port,
      username: 'rsa',
    });
    const serverId = String(add.body.serverId);
    const trust = await w.call(
      api.vault.trustSshHostKey,
      { entryId: r.id, serverId },
      { fingerprint: fake.hostKey().fingerprint },
    );
    expect(trust.body.result).toMatchObject({ outcome: 'reached', summary: 'Signed in as rsa' });
  });

  it('refuses what an entry can’t hold, in a sentence', async () => {
    const short = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({
      type: 'pkcs1',
      format: 'pem',
    });
    const dsa = generateKeyPairSync('dsa', { modulusLength: 2048, divisorLength: 256 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
    const pub = sshKeyPair('ed25519').public;
    for (const [text, message] of [
      [short, 'That RSA key is shorter than 2048 bits. Use a longer one or generate a new key.'],
      [dsa, 'Use an Ed25519, ECDSA or RSA key. DSA and other kinds aren’t accepted.'],
      [pub, 'That’s the public key. Paste the private key: the file without .pub.'],
    ] as const) {
      const res = await create({ name: 'Nope', sshKey: { mode: 'import', privateKey: String(text) } });
      expect(res.status, res.raw).toBe(400);
      expect(res.raw).toContain(message.replace(/’/g, '’'));
    }
  });

  it('replaces a key with an imported one (a secret op)', async () => {
    const id = String(
      ((await create({ name: 'Swap', sshKey: { mode: 'generate' } })).body.entry as Entry).id,
    );
    const pair = sshKeyPair('ecdsa', { bits: 256 });
    const res = await w.call(api.vault.replaceSshKey, { entryId: id }, { privateKey: pair.private });
    expect(res.status, res.raw).toBe(200);
    expect((res.body.entry as Entry).auth).toMatchObject({ keyType: 'ecdsa', origin: 'imported' });
    const [replaced] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'vault.entry.secret_replaced'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(replaced?.text).toBe('Replaced the secret of a private Vault entry');
  });
});

describe('lifecycle (VT-06)', () => {
  it('removes servers with their entry', async () => {
    const res = await create({ name: 'Gone', sshKey: { mode: 'generate' } });
    const id = String((res.body.entry as Entry).id);
    await addServer(id, { name: 'a', host: 'ssh.home.test', port: fake.port, username: 'u' });
    await w.call(api.vault.remove, { entryId: id }, undefined);
    const rows = await t.services.db.select().from(vaultSshServers).where(eq(vaultSshServers.entryId, id));
    expect(rows).toEqual([]);
  });
});
