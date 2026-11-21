/**
 * Asking for every sign-in (vault-simplify.md VLT-40…VLT-47) through `/mcp`, `guides.act` and the runner's routes,
 * against Postgres and the install SSH fake: needs the commit pipeline, the cards, the Vault's sealed store, the SSH
 * sign-ins and the dispatch queue together. For each kind the value is in no message, signed event, realtime frame,
 * log line or woken turn's `DispatchContext` (CIC-15), and the agent is woken with how it went.
 */
import { Writable } from 'node:stream';
import {
  api,
  buildPath,
  DispatchContext,
  GUIDE_VAULT_SERVER_TRIES,
  type GuideCard,
  VAULT_SCRUBBED,
  vaultSshAuthorizedKeysLine,
} from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { turnKeysFor } from '../agent-commands/keys';
import { RUNNER, runnerCall } from '../agent-commands/testing';
import { sendMessage } from '../commands/messages';
import { dispatches, events, messages, vaultEntries, vaultSshServers } from '../db/schema/index';
import { type FakeInstallSsh, fakeInstallSsh } from '../hosts/testing/fake-install-ssh';
import type { BusFrame } from '../realtime/bus';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { setGrant } from '../test/approvals';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { sshKeyPair } from '../test/ssh-keys';
import { accountOf, agentTokenFor } from '../test/tokens';
import { useVaultNetForTests, type VaultNet } from './net';
import { vaultSecretAad } from './store';
import { HOSTS, useVaultWorld } from './testing/world';

const appLog: string[] = [];
const stream = new Writable({
  write(chunk, _enc, done) {
    appLog.push(String(chunk));
    done();
  },
});

const t = useTestServer({
  seed: true,
  listen: true,
  env: { WHOMBAT_LOCAL_NETWORK: 'off' },
  logger: { level: 'trace', stream },
});
const w = useVaultWorld(t);
const frames: BusFrame[] = [];
const serviceLog: string[] = [];
let ssh: FakeInstallSsh;
let me: PersonalSetup;
let mara = '';

for (const n of [40, 41, 42, 43, 44]) HOSTS[`box${n}.asks.test`] = [`192.168.81.${n}`];
// A public site Hermes's browser signs in to.
HOSTS['login.asks.test'] = ['93.184.216.34'];

const NET: VaultNet = {
  resolve: async (host) => {
    const list = HOSTS[host];
    if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
  dialAddress: (a) => (a.startsWith('192.168.81.') ? '127.0.0.1' : a),
  deadlineMs: 3000,
};

const ROOT_PASSWORD = 'R00t-Card-Passw0rd-4410';
const DEPLOY_PASSWORD = 'Dep-Kept-Passw0rd-7720';

beforeAll(async () => {
  t.services.bus.onFrame((f) => frames.push(f));
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    const log = t.services.log as unknown as Record<string, (...args: unknown[]) => void>;
    const original = log[level]?.bind(log);
    log[level] = (...args: unknown[]) => {
      serviceLog.push(JSON.stringify(args));
      original?.(...args);
    };
  }
  ssh = await fakeInstallSsh();
  ssh.users.set('root', { password: ROOT_PASSWORD, uid: 0, sudo: 'nopasswd', authorized: [] });
  ssh.users.set('deploy', { password: DEPLOY_PASSWORD, uid: 1000, sudo: 'password', authorized: [] });
  me = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { name: 'Dusty', services: null });
  mara = await accountOf(t.services, IDS.mara);
  await w.listHomeNetwork();
  useVaultNetForTests(t.services, NET);
  const res = await w.call(
    api.vaultNetworks.add,
    {},
    { cidr: '192.168.81.0/24', ports: [ssh.port], note: 'The SSH fake' },
    'mara',
  );
  expect(res.status, res.raw).toBe(201);
  await setGrant(t.services, me.agentId, 'browser.use', 'can');
});

afterAll(async () => {
  await ssh?.close();
});

const addr = (n: number) => `box${n}.asks.test:${ssh.port}`;

/** The “Servers” key the first card made: with several keys the agent names the one it means (VS-09). */
async function serversKey(): Promise<string> {
  const [row] = await t.services.db
    .select({ id: vaultEntries.id })
    .from(vaultEntries)
    .where(and(eq(vaultEntries.ownerId, IDS.mara), eq(vaultEntries.name, 'Servers')));
  return row?.id ?? '';
}

/** A turn for Mara in a thread of a room of hers (her Chat by default). */
async function turnInThread(text: string, conversationId = me.dmId) {
  const res = await t.commit(IDS.mara, sendMessage, { conversationId, text });
  if (res.status !== 'ok') throw new Error('not sent');
  const root = (res.result as { id: string }).id;
  await t.services.db
    .update(dispatches)
    .set({ state: 'done' })
    .where(and(eq(dispatches.messageId, root), eq(dispatches.state, 'queued')));
  const d = await agentTokenFor(t.services, t.burrowId, me.agentId, conversationId, {
    onBehalfOfAccountId: mara,
    threadRootId: root,
    messageId: root,
    trigger: conversationId === me.dmId ? 'dm' : 'mention',
  });
  // Held by the test runner, as a claimed turn is (the runner's routes check the lease).
  await t.services.db
    .update(dispatches)
    .set({ runnerId: RUNNER, attempts: 1, leaseExpiresAt: new Date(Date.now() + 600_000) })
    .where(eq(dispatches.id, d.dispatchId));
  return { root, dispatchId: d.dispatchId, token: d.token, conversationId };
}

async function call(token: string, name: string, args: Record<string, unknown>) {
  const mcp = await mcpClient(t.baseUrl, token);
  try {
    const res = await mcp.client.callTool({ name, arguments: args });
    return { body: (res.structuredContent ?? {}) as Record<string, unknown>, raw: JSON.stringify(res) };
  } finally {
    await mcp.close();
  }
}

async function cardOf(messageId: string) {
  const [row] = await t.services.db.select().from(messages).where(eq(messages.id, messageId));
  if (row?.card?.kind !== 'guide') throw new Error('no guide card');
  return { row, card: row.card as GuideCard };
}

async function act(messageId: string, body: object) {
  const res = await t.api.inject({
    method: 'POST',
    url: `${api.guides.act.base}${buildPath(api.guides.act.path, { burrow: 'burrow-hq', messageId })}`,
    headers: { cookie: w.cookies.mara },
    payload: body,
  });
  return {
    status: res.statusCode,
    raw: res.body,
    json: (() => {
      try {
        return JSON.parse(res.body);
      } catch {
        return {};
      }
    })(),
  };
}

/** The turn the card's answer woke, if any. */
async function wokenBy(messageId: string) {
  const [woken] = await t.services.db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.agentId, me.agentId), eq(dispatches.messageId, messageId)))
    .orderBy(desc(dispatches.createdAt))
    .limit(1);
  return woken ?? null;
}

/** CIC-15: the value is in no message, signed event, realtime frame, log line or woken turn's context. */
async function nowhere(value: string, woken: typeof dispatches.$inferSelect | null) {
  const rows = await t.services.db.select().from(messages).where(eq(messages.burrowId, t.burrowId));
  expect(JSON.stringify(rows)).not.toContain(value);
  const log = await t.services.db.select().from(events).where(eq(events.burrowId, t.burrowId));
  expect(JSON.stringify(log)).not.toContain(value);
  expect(JSON.stringify(frames)).not.toContain(value);
  expect(appLog.join('\n')).not.toContain(value);
  expect(serviceLog.join('\n')).not.toContain(value);
  if (woken) {
    const context = DispatchContext.parse(await buildDispatchContext(t.services, woken));
    expect(JSON.stringify(context)).not.toContain(value);
  }
}

describe('a server card (VLT-42)', () => {
  it('uses the password once to put the key on, after a wrong try, and wakes the agent with how it went', async () => {
    const turn = await turnInThread('Can you look at box40?');
    const asked = await call(turn.token, 'vault_ask', {
      kind: 'server',
      address: addr(40),
      username: 'root',
      why: 'To check its disks.',
    });
    expect(asked.body, asked.raw).toMatchObject({ status: 'ok' });
    const messageId = asked.body.messageId as string;
    const { row, card } = await cardOf(messageId);
    expect(row.threadRootId).toBe(turn.root);
    expect(card.vaultAsk).toMatchObject({
      kind: 'server',
      username: 'root',
      entryId: null,
      server: { host: 'box40.asks.test', port: ssh.port, reason: 'new', tries: 0 },
    });
    const form = card.blocks.find((b) => b.type === 'form');
    expect(form?.type === 'form' && form.fields.map((f) => f.id)).toEqual([
      'password',
      'private_key',
      'passphrase',
    ]);

    // A wrong password: on the field, the card open, one try counted, nothing added.
    const wrong = await act(messageId, { actionId: 'save', values: { password: 'not-the-one-123' } });
    expect(wrong.status, wrong.raw).toBe(400);
    expect(wrong.json.error.details.code).toBe('invalid_values');
    expect(Object.keys(wrong.json.error.fields ?? {})).toEqual(['values.password']);
    expect((await cardOf(messageId)).card).toMatchObject({
      state: 'open',
      vaultAsk: { server: { tries: 1 } },
    });

    const saved = await act(messageId, { actionId: 'save', values: { password: ROOT_PASSWORD } });
    expect(saved.status, saved.raw).toBe(200);
    const after = await cardOf(messageId);
    expect(after.card.state).toBe('done');
    expect(after.card.answer).toMatchObject({ vaultOutcome: 'key_added' });
    const entryId = after.card.answer?.vaultEntryId ?? '';
    const server = after.card.answer?.vaultServer ?? '';
    expect(server).toBeTruthy();
    // A new “Servers” key, on for the assistant; its line on the server; the server pinned, no password kept.
    const [entry] = await t.services.db.select().from(vaultEntries).where(eq(vaultEntries.id, entryId));
    expect(entry).toMatchObject({ kind: 'ssh', name: 'Servers', ownerId: IDS.mara });
    expect(entry?.agentOnAt).not.toBeNull();
    const auth = entry?.auth as { publicKey: string };
    expect(ssh.users.get('root')?.authorized).toEqual([vaultSshAuthorizedKeysLine(auth.publicKey, entryId)]);
    const [added] = await t.services.db
      .select()
      .from(vaultSshServers)
      .where(eq(vaultSshServers.entryId, entryId));
    expect(added).toMatchObject({
      host: 'box40.asks.test',
      username: 'root',
      name: server,
      passwordSealed: null,
    });
    expect(added?.hostKeyFingerprint).toBe(ssh.hostKey().fingerprint);
    // Woken in the card's thread, the card as what woke it; its history line says how it went.
    const woken = await wokenBy(messageId);
    expect(woken).toMatchObject({ trigger: 'dm', threadRootId: turn.root, conversationId: me.dmId });
    await nowhere(ROOT_PASSWORD, woken);
    await nowhere('not-the-one-123', null);
  });

  it('keeps the password for a server that doesn’t take keys; the commands sign in with it, scrubbed', async () => {
    const turn = await turnInThread('Deploy to box41 please');
    const asked = await call(turn.token, 'vault_ask', {
      kind: 'server',
      address: addr(41),
      username: 'deploy',
    });
    const messageId = asked.body.messageId as string;
    const saved = await act(messageId, {
      actionId: 'save',
      values: { way: 'keep_password', password: DEPLOY_PASSWORD },
    });
    expect(saved.status, saved.raw).toBe(200);
    const { card } = await cardOf(messageId);
    expect(card.answer).toMatchObject({ vaultOutcome: 'password_saved' });
    const [kept] = await t.services.db
      .select()
      .from(vaultSshServers)
      .where(eq(vaultSshServers.host, 'box41.asks.test'));
    expect(kept?.passwordSealed).toBeTruthy();
    expect(kept?.passwordSealed).not.toContain(DEPLOY_PASSWORD);
    // The Vault shows it as set, never the value.
    const listed = await w.call(api.vault.get, { entryId: kept?.entryId as string }, undefined, 'mara');
    expect(listed.raw).not.toContain(DEPLOY_PASSWORD);
    expect(
      JSON.parse(listed.raw).entry.servers.find((s: { host: string }) => s.host === 'box41.asks.test'),
    ).toMatchObject({ password: { set: true } });

    // The woken turn's commands: an alias, password sign-in, the password only in its askpass file.
    const woken = await wokenBy(messageId);
    if (!woken) throw new Error('not woken');
    const keys = await turnKeysFor(t.services, woken);
    const config = Buffer.from(
      keys.files.find((f) => f.path === 'ssh_config')?.base64 ?? '',
      'base64',
    ).toString();
    expect(config).toMatch(/HostKeyAlias wbpw1\.invalid/);
    expect(config).toMatch(/Host \*\n {2}KbdInteractiveAuthentication no\n$/);
    expect(config).not.toContain(DEPLOY_PASSWORD);
    const file = keys.files.find((f) => f.path === 'askpass/wbpw1.invalid');
    expect(JSON.parse(Buffer.from(file?.base64 ?? '', 'base64').toString())).toEqual({
      user: 'deploy',
      password: DEPLOY_PASSWORD,
    });
    expect(keys.env.map((e) => e.value).join(' ')).not.toContain(DEPLOY_PASSWORD);
    // Scrubbed from what the assistant writes.
    const posted = await t.commit(me.agentId, sendMessage, {
      conversationId: me.dmId,
      text: `pw ${DEPLOY_PASSWORD}`,
    });
    expect(posted.status).toBe('ok');
    const [last] = await t.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, me.dmId), eq(messages.authorId, me.agentId)))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    expect(last?.text).toBe(`pw ${VAULT_SCRUBBED}`);
    await nowhere(DEPLOY_PASSWORD, woken);
  });

  it('imports the person’s own key as a Server key entry; the passphrase opens it once', async () => {
    const passphrase = 'Own-Key-Passphrase-55';
    const pair = sshKeyPair('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 2 });
    ssh.users.get('deploy')?.authorized.push(pair.public.split(' ').slice(0, 2).join(' '));
    const turn = await turnInThread('Look at box42');
    const asked = await call(turn.token, 'vault_ask', {
      kind: 'server',
      address: addr(42),
      username: 'deploy',
      name: 'box-42',
    });
    const messageId = asked.body.messageId as string;
    const badPass = await act(messageId, {
      actionId: 'save',
      values: { way: 'own_key', private_key: pair.private, passphrase: 'wrong-pass-123' },
    });
    expect(badPass.status, badPass.raw).toBe(400);
    expect(Object.keys(badPass.json.error.fields ?? {})).toEqual(['values.passphrase']);
    const saved = await act(messageId, {
      actionId: 'save',
      values: { way: 'own_key', private_key: pair.private, passphrase },
    });
    expect(saved.status, saved.raw).toBe(200);
    const { card } = await cardOf(messageId);
    expect(card.answer).toMatchObject({ vaultOutcome: 'key_imported', vaultServer: 'box-42' });
    const [entry] = await t.services.db
      .select()
      .from(vaultEntries)
      .where(eq(vaultEntries.id, card.answer?.vaultEntryId ?? ''));
    expect(entry).toMatchObject({ kind: 'ssh', name: 'box-42' });
    expect(entry?.agentOnAt).not.toBeNull();
    // Stored opened (no passphrase), sealed under the entry's own AAD.
    const stored = t.services.custody.open(vaultSecretAad(entry?.id ?? ''), entry?.sealed ?? '');
    expect(stored).toContain('OPENSSH PRIVATE KEY');
    await nowhere(passphrase, await wokenBy(messageId));
  });

  it('closes the card after three tries that don’t sign in, and wakes the agent with the reason', async () => {
    const turn = await turnInThread('box43 next');
    const asked = await call(turn.token, 'vault_ask', {
      kind: 'server',
      address: addr(43),
      // The fake is one server for every box: root takes the “Servers” key already, deploy doesn't.
      username: 'deploy',
      reason: 'key_refused',
      entry: await serversKey(),
    });
    const messageId = asked.body.messageId as string;
    for (let i = 1; i < GUIDE_VAULT_SERVER_TRIES; i++)
      expect(
        (await act(messageId, { actionId: 'save', values: { password: `nope-${i}-pass` } })).status,
      ).toBe(400);
    const last = await act(messageId, { actionId: 'save', values: { password: 'nope-3-pass' } });
    expect(last.status, last.raw).toBe(200);
    const { card } = await cardOf(messageId);
    expect(card).toMatchObject({
      state: 'done',
      answer: { vaultOutcome: 'refused', vaultRefusal: 'password_wrong' },
    });
    expect(await wokenBy(messageId)).not.toBeNull();
    const added = await t.services.db
      .select()
      .from(vaultSshServers)
      .where(eq(vaultSshServers.host, 'box43.asks.test'));
    expect(added).toEqual([]);
  });

  it('asks in any room of the person’s and wakes the agent there', async () => {
    const turn = await turnInThread('Check box44 from here', IDS.billing);
    const asked = await call(turn.token, 'vault_ask', {
      kind: 'server',
      address: addr(44),
      username: 'root',
      entry: await serversKey(),
    });
    expect(asked.body, asked.raw).toMatchObject({ status: 'ok' });
    const messageId = asked.body.messageId as string;
    expect((await cardOf(messageId)).row.conversationId).toBe(IDS.billing);
    const no = await act(messageId, { actionId: 'no' });
    expect(no.status, no.raw).toBe(200);
    expect((await cardOf(messageId)).card.answer).toMatchObject({ vaultOutcome: 'declined' });
    expect(await wokenBy(messageId)).toMatchObject({ conversationId: IDS.billing, trigger: 'mention' });
  });
});

describe('Hermes’s own asks and codes (VLT-44, VLT-45)', () => {
  const lease = { runnerId: RUNNER, attempt: 1 };
  const ask = (dispatchId: string, body: object) =>
    runnerCall(t, 'POST', '/dispatches/:dispatchId/login-asks', { dispatchId }, { ...lease, ...body });
  const wait = (dispatchId: string, messageId: string, waitMs = 0) =>
    runnerCall(
      t,
      'GET',
      '/dispatches/:dispatchId/login-asks/:messageId',
      { dispatchId, messageId },
      undefined,
      {
        ...lease,
        waitMs,
      },
    );

  it('posts a login card in the turn’s thread and gives the saved login to the waiting turn, waking nobody', async () => {
    const turn = await turnInThread('Sign in to the asks site');
    const asked = await ask(turn.dispatchId, {
      kind: 'login',
      origin: 'https://login.asks.test',
      username: null,
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toMatchObject({ status: 'asked' });
    const messageId = asked.body.messageId as string;
    // Asked again for the same site in the turn: the same card.
    expect(
      (await ask(turn.dispatchId, { kind: 'login', origin: 'https://login.asks.test' })).body.messageId,
    ).toBe(messageId);
    expect((await cardOf(messageId)).row).toMatchObject({
      threadRootId: turn.root,
      dispatchId: turn.dispatchId,
    });
    expect((await wait(turn.dispatchId, messageId)).body).toEqual({ status: 'pending' });
    const pending = wait(turn.dispatchId, messageId, 20_000);
    const secret = 'Site-Login-Passw0rd-881';
    const saved = await act(messageId, { actionId: 'save', values: { username: 'mara', secret } });
    expect(saved.status, saved.raw).toBe(200);
    const answer = (await pending).body;
    expect(answer).toMatchObject({
      status: 'saved',
      login: { origin: 'https://login.asks.test', username: 'mara', otp: false },
    });
    expect(JSON.stringify(answer)).not.toContain(secret);
    // Its password comes as every login's does.
    const entryId = (answer.login as { entryId: string }).entryId;
    const pw = await runnerCall(
      t,
      'POST',
      '/dispatches/:dispatchId/logins/:entryId',
      { dispatchId: turn.dispatchId, entryId },
      lease,
    );
    expect(pw.body).toMatchObject({ password: secret });
    expect(await wokenBy(messageId)).toBeNull();
    await nowhere(secret, null);
  });

  it('a code goes to the waiting sign-in once, never stored; after the turn it came too late', async () => {
    const turn = await turnInThread('Two-step sign-in');
    const asked = await ask(turn.dispatchId, { kind: 'code', origin: 'https://login.asks.test' });
    const messageId = asked.body.messageId as string;
    expect((await cardOf(messageId)).card.vaultAsk).toMatchObject({ kind: 'code', name: 'login.asks.test' });
    const code = '804472';
    expect((await act(messageId, { actionId: 'save', values: { code } })).status).toBe(200);
    expect((await cardOf(messageId)).card.answer).toMatchObject({ vaultOutcome: 'code_given' });
    expect((await wait(turn.dispatchId, messageId)).body).toEqual({ status: 'code', code });
    // Once.
    expect((await wait(turn.dispatchId, messageId)).body).toEqual({ status: 'declined' });
    expect(await wokenBy(messageId)).toBeNull();
    await nowhere(code, null);

    // The agent's own code card, answered after its turn ended: too late, and the agent hears so.
    const later = await turnInThread('Another code');
    const mine = await call(later.token, 'vault_ask', {
      kind: 'code',
      name: 'login.asks.test',
      hint: 'By text.',
    });
    const card = mine.body.messageId as string;
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, later.dispatchId));
    expect((await act(card, { actionId: 'save', values: { code: '115533' } })).status).toBe(200);
    expect((await cardOf(card)).card.answer).toMatchObject({ vaultOutcome: 'too_late' });
    expect(await wokenBy(card)).not.toBeNull();
    await nowhere('115533', null);
  });

  it('a wait that ran out leaves the card; a later answer wakes the agent', async () => {
    const turn = await turnInThread('Sign in later');
    const asked = await ask(turn.dispatchId, {
      kind: 'login',
      origin: 'https://login.asks.test',
      username: 'mara',
    });
    const messageId = asked.body.messageId as string;
    // Eleven minutes ago, as far as the card is concerned.
    await t.services.db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(messages.id, messageId));
    expect((await wait(turn.dispatchId, messageId)).body).toEqual({ status: 'timed_out' });
    expect((await cardOf(messageId)).card.state).toBe('open');
    const no = await act(messageId, { actionId: 'no' });
    expect(no.status, no.raw).toBe(200);
    expect(await wokenBy(messageId)).not.toBeNull();
  });

  it('asks nobody in an outsiders’ turn', async () => {
    const d = await agentTokenFor(t.services, t.burrowId, me.agentId, me.dmId, { onBehalfOfAccountId: null });
    await t.services.db
      .update(dispatches)
      .set({ runnerId: RUNNER, attempts: 1, leaseExpiresAt: new Date(Date.now() + 600_000) })
      .where(eq(dispatches.id, d.dispatchId));
    const asked = await ask(d.dispatchId, { kind: 'login', origin: 'https://login.asks.test' });
    expect(asked.body).toMatchObject({ status: 'refused', reason: 'not_person' });
    // Not even served there: no card.
    const tool = await call(d.token, 'vault_ask', { kind: 'code', name: 'login.asks.test' });
    expect(tool.body.status, tool.raw).not.toBe('ok');
  });
});
