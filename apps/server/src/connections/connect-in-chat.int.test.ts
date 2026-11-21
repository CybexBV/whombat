/**
 * Setting up from the chat (connect-in-chat.md) through `/mcp` and `guides.act`, against Postgres: needs the commit
 * pipeline, the person's Chat, the Vault's sealed store and the dispatch queue together. `connection_add` puts the
 * connect card in the turn's thread (the level by risk, Add as a server first for Proxmox VE); `vault_ask` puts a
 * write-only field there, and what the person types lands in their Vault and nowhere else: not in a message, an event,
 * a realtime frame, a log line or the woken turn's context. An MCP server or API set up by talking connects on its card
 * with the key the person types (connect-by-talking.md), checked against the fake service, and wakes the assistant;
 * the assistant then gives it a logo and a page of its own (connection-looks.md), tried before it is kept.
 */
import { Writable } from 'node:stream';
import {
  api,
  buildPath,
  CONNECT_HERE_DECLINE,
  CONNECT_HERE_FORM,
  DispatchContext,
  type GuideCard,
  VAULT_ASK_TEXT,
  vaultAskLockedLabel,
  vaultAskTitle,
} from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import {
  catalogConnections,
  connectionTools,
  dispatches,
  events,
  messages,
  vaultEntries,
} from '../db/schema/index';
import type { BusFrame } from '../realtime/bus';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { accountOf, agentTokenFor } from '../test/tokens';
import { vaultSecretAad } from '../vault/store';
import { API_TOKEN, HA_TOKEN, useVaultWorld } from '../vault/testing/world';

/** Everything the app logs, as written. */
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
/** What the services log (the test logger drops it): kept so it can be searched. */
const serviceLog: string[] = [];
let me: PersonalSetup;
let mara = '';

const SECRET = 'Grafana-Admin-Passw0rd-73551';

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
  me = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { name: 'Dusty', services: null });
  mara = await accountOf(t.services, IDS.mara);
  await w.listHomeNetwork();
});

/** A turn for Mara in a thread of her Chat: the thread's first message is hers. */
async function turnInThread(text = 'Connect my things please') {
  const res = await t.commit(IDS.mara, sendMessage, { conversationId: me.dmId, text });
  if (res.status !== 'ok') throw new Error('not sent');
  const root = (res.result as { id: string }).id;
  // The turn her message queued is this one: it runs now, so a wake afterwards queues a turn of its own.
  await t.services.db
    .update(dispatches)
    .set({ state: 'done' })
    .where(and(eq(dispatches.messageId, root), eq(dispatches.state, 'queued')));
  const d = await agentTokenFor(t.services, t.burrowId, me.agentId, me.dmId, {
    onBehalfOfAccountId: mara,
    threadRootId: root,
    messageId: root,
    trigger: 'dm',
  });
  return { root, dispatchId: d.dispatchId, token: d.token };
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
  return { status: res.statusCode, raw: res.body };
}

describe('connection_add', () => {
  it('puts the connect card in the thread, Manage for Home Assistant', async () => {
    const turn = await turnInThread();
    const res = await call(turn.token, 'connection_add', {
      service: 'Home Assistant',
      address: 'http://192.168.77.20:8123',
    });
    expect(res.body, res.raw).toMatchObject({
      status: 'ok',
      service: 'homeassistant',
      address: 'http://192.168.77.20:8123',
      found: false,
      access: 'manage',
      server: false,
    });
    const { row, card } = await cardOf(res.body.messageId as string);
    expect(row.authorId).toBe(me.agentId);
    expect(row.threadRootId).toBe(turn.root);
    expect(card).toMatchObject({ guide: 'add_connection', node: 'connect' });
    expect(card.title).toContain('Home Assistant');
    const action = card.blocks.flatMap((b) => (b.type === 'actions' ? b.actions : []))[0];
    expect(action?.href).toContain('connection=homeassistant');
    expect(action?.href).toContain('access=manage');
    expect(action?.href).toContain(encodeURIComponent('http://192.168.77.20:8123'));
  });

  it('starts a NAS at Look only', async () => {
    const turn = await turnInThread();
    const res = await call(turn.token, 'connection_add', { service: 'synology', address: '192.168.77.21' });
    expect(res.body, res.raw).toMatchObject({ status: 'ok', access: 'read' });
    const { card } = await cardOf(res.body.messageId as string);
    expect(JSON.stringify(card.blocks)).toContain('access=read');
  });

  it('adds Proxmox VE as a server first', async () => {
    const turn = await turnInThread();
    const res = await call(turn.token, 'connection_add', {
      service: 'proxmox',
      address: 'https://192.168.77.22:8006',
    });
    expect(res.body, res.raw).toMatchObject({ status: 'ok', server: true });
    const { card } = await cardOf(res.body.messageId as string);
    const actions = card.blocks.flatMap((b) => (b.type === 'actions' ? b.actions : []));
    expect(actions.map((a) => a.id)).toEqual(['server', 'connect']);
    expect(actions[0]?.href).toContain('add=1');
    expect(actions[0]?.href).toContain('address=192.168.77.22');
  });

  it('says plainly what it doesn’t know', async () => {
    const turn = await turnInThread();
    const res = await call(turn.token, 'connection_add', { service: 'a toaster' });
    expect(res.body).toMatchObject({ status: 'failed', reason: 'unknown_service' });
  });
});

describe('vault_ask', () => {
  it('saves what the person types into their Vault, and nowhere else', async () => {
    const turn = await turnInThread('Check my Grafana dashboards');
    const asked = await call(turn.token, 'vault_ask', {
      kind: 'basic',
      name: 'Grafana',
      address: w.apiUrl(),
      username: 'admin',
      why: 'To read your dashboards.',
    });
    expect(asked.body, asked.raw).toMatchObject({ status: 'ok' });
    const messageId = asked.body.messageId as string;
    const before = await cardOf(messageId);
    expect(before.row.threadRootId).toBe(turn.root);
    expect(before.card).toMatchObject({
      guide: 'secret',
      state: 'open',
      title: vaultAskTitle('Dusty', { kind: 'basic', name: 'Grafana' }),
      vaultAsk: { kind: 'basic', name: 'Grafana', username: 'admin' },
    });
    const form = before.card.blocks.find((b) => b.type === 'form');
    expect(form?.type === 'form' && form.fields.map((f) => [f.id, f.kind])).toEqual([['secret', 'secret']]);

    const saved = await act(messageId, { actionId: 'save', values: { secret: SECRET } });
    expect(saved.status, saved.raw).toBe(200);

    const after = await cardOf(messageId);
    expect(after.card.state).toBe('done');
    expect(after.card.answer).toMatchObject({
      label: vaultAskLockedLabel('saved', { name: 'Grafana' }),
      vaultOutcome: 'saved',
    });
    const entryId = after.card.answer?.vaultEntryId ?? '';
    const [entry] = await t.services.db.select().from(vaultEntries).where(eq(vaultEntries.id, entryId));
    expect(entry).toMatchObject({ ownerId: IDS.mara, name: 'Grafana', kind: 'http' });
    expect(entry?.sealed && t.services.custody.open(vaultSecretAad(entryId), entry.sealed)).toBe(SECRET);
    // The assistant holds it from the start (vault-self-serve.md VS-01).
    expect(entry?.agentOnAt).toBeTruthy();

    // The agent is woken in the card's thread, with the card as what woke it.
    const [woken] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.agentId, me.agentId), eq(dispatches.messageId, messageId)))
      .orderBy(desc(dispatches.createdAt))
      .limit(1);
    expect(woken).toMatchObject({ trigger: 'dm', threadRootId: turn.root, conversationId: me.dmId });

    // Nowhere else: the room's messages, the signed log, what went out live, the logs, the woken turn's context.
    const rows = await t.services.db.select().from(messages).where(eq(messages.burrowId, t.burrowId));
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    const log = await t.services.db.select().from(events).where(eq(events.burrowId, t.burrowId));
    expect(JSON.stringify(log)).not.toContain(SECRET);
    expect(JSON.stringify(frames)).not.toContain(SECRET);
    expect(appLog.join('\n')).not.toContain(SECRET);
    expect(serviceLog.join('\n')).not.toContain(SECRET);
    if (!woken) throw new Error('not woken');
    const context = DispatchContext.parse(await buildDispatchContext(t.services, woken));
    expect(JSON.stringify(context)).not.toContain(SECRET);
    expect(JSON.stringify(context)).toContain(entryId);
  });

  it('asks for the username when it isn’t known, and refuses an empty field without a value in sight', async () => {
    const turn = await turnInThread();
    const asked = await call(turn.token, 'vault_ask', {
      kind: 'login',
      name: 'Fake API',
      address: w.apiUrl(),
    });
    const messageId = asked.body.messageId as string;
    const { card } = await cardOf(messageId);
    const form = card.blocks.find((b) => b.type === 'form');
    // A website login's authenticator key is optional on the card (VLT-46).
    expect(form?.type === 'form' && form.fields.map((f) => f.id)).toEqual(['username', 'secret', 'totp']);
    const empty = await act(messageId, { actionId: 'save', values: { username: 'mara' } });
    expect(empty.status).toBe(400);
    expect(JSON.parse(empty.raw).error.details.code).toBe('invalid_values');
    expect((await cardOf(messageId)).card.state).toBe('open');
  });

  it('carries on when the person says no', async () => {
    const turn = await turnInThread();
    const asked = await call(turn.token, 'vault_ask', {
      kind: 'token',
      name: 'Fake API',
      address: w.apiUrl(),
    });
    const messageId = asked.body.messageId as string;
    expect((await cardOf(messageId)).card.title).toBe(
      vaultAskTitle('Dusty', { kind: 'token', name: 'Fake API' }),
    );
    const no = await act(messageId, { actionId: 'no' });
    expect(no.status, no.raw).toBe(200);
    const { card } = await cardOf(messageId);
    expect(card.answer).toMatchObject({ label: VAULT_ASK_TEXT.notNow, vaultOutcome: 'declined' });
    expect(card.answer?.vaultEntryId).toBeUndefined();
    const woken = await t.services.db.select().from(dispatches).where(eq(dispatches.messageId, messageId));
    expect(woken).toHaveLength(1);
  });

  it('refuses an address the Vault won’t send to, before asking', async () => {
    const turn = await turnInThread();
    const res = await call(turn.token, 'vault_ask', {
      kind: 'token',
      name: 'Elsewhere',
      address: 'http://10.99.0.7/api',
    });
    expect(res.body, res.raw).toMatchObject({ status: 'failed', reason: 'not_allowed' });
    const posted = await t.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, me.dmId), eq(messages.threadRootId, turn.root)));
    expect(posted.filter((m) => m.card)).toHaveLength(0);
    const weather = await call(turn.token, 'connection_add', {
      service: 'Weatherly',
      address: w.apiUrl('/v1/weather'),
      signIn: 'query',
      keyName: 'appid',
    });
    expect(weather.body, weather.raw).toMatchObject({
      status: 'ok',
      service: 'custom_api',
      connectsHere: true,
    });
    expect((await cardOf(weather.body.messageId as string)).card.connectAsk?.label).toBe('Weatherly');
  });
});

describe('connecting an MCP server or API by talking (connect-by-talking.md)', () => {
  it('connects an API on the card with the key the person types, and wakes the assistant', async () => {
    const turn = await turnInThread('Connect the fake API, here are its docs');
    const res = await call(turn.token, 'connection_add', {
      service: 'custom_api',
      name: 'Fake API',
      address: w.apiUrl(),
      signIn: 'bearer',
      notes: 'GET /echo answers what it got.',
    });
    expect(res.body, res.raw).toMatchObject({
      status: 'ok',
      service: 'custom_api',
      connectsHere: true,
      signIn: 'bearer',
      access: 'read',
    });
    const messageId = res.body.messageId as string;
    const before = await cardOf(messageId);
    expect(before.row.threadRootId).toBe(turn.root);
    expect(before.card).toMatchObject({
      guide: 'add_connection',
      node: 'here',
      state: 'open',
      connectAsk: { catalogId: 'custom_api', label: 'Fake API', url: w.apiUrl() },
    });

    // A key the API turns down: said on the field, the card stays open and nothing is saved.
    const wrong = await act(messageId, { actionId: CONNECT_HERE_FORM, values: { secret: 'not-the-key' } });
    expect(wrong.status, wrong.raw).toBe(400);
    expect(JSON.parse(wrong.raw).error.fields).toHaveProperty('values.secret');
    expect((await cardOf(messageId)).card.state).toBe('open');

    const done = await act(messageId, { actionId: CONNECT_HERE_FORM, values: { secret: API_TOKEN } });
    expect(done.status, done.raw).toBe(200);
    const after = await cardOf(messageId);
    expect(after.card.state).toBe('done');
    const connectionId = after.card.answer?.connectionId ?? '';
    expect(connectionId).toMatch(/^con_/);
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    expect(row).toMatchObject({
      catalogId: 'custom_api',
      label: 'Fake API',
      access: 'read',
      status: 'active',
    });
    expect(JSON.stringify(row?.fields)).toContain('/echo');

    const [woken] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.agentId, me.agentId), eq(dispatches.messageId, messageId)))
      .orderBy(desc(dispatches.createdAt))
      .limit(1);
    expect(woken).toMatchObject({ trigger: 'dm', threadRootId: turn.root, conversationId: me.dmId });
    if (!woken) throw new Error('not woken');
    const context = JSON.stringify(DispatchContext.parse(await buildDispatchContext(t.services, woken)));
    expect(context).toContain(connectionId);

    // The key is in no message, event, frame or log line, and not in the woken turn.
    const rows = await t.services.db.select().from(messages).where(eq(messages.burrowId, t.burrowId));
    expect(JSON.stringify(rows)).not.toContain(API_TOKEN);
    const log = await t.services.db.select().from(events).where(eq(events.burrowId, t.burrowId));
    expect(JSON.stringify(log)).not.toContain(API_TOKEN);
    expect(JSON.stringify(frames)).not.toContain(API_TOKEN);
    expect(appLog.join('\n')).not.toContain(API_TOKEN);
    expect(serviceLog.join('\n')).not.toContain(API_TOKEN);
    expect(context).not.toContain(API_TOKEN);

    // The same address again is the connection it is.
    const again = await call(turn.token, 'connection_add', { service: 'custom_api', address: w.apiUrl() });
    expect(again.body).toMatchObject({ status: 'failed', reason: 'already_connected', connectionId });
  });

  it('asks an MCP server whether it needs a key, and connects it with one', async () => {
    const turn = await turnInThread();
    const res = await call(turn.token, 'connection_add', {
      service: 'MCP server',
      name: 'Home tools',
      address: w.haUrl('/api/mcp'),
      signIn: 'none',
    });
    // The server asks for a key, so the card does, whatever the assistant guessed.
    expect(res.body, res.raw).toMatchObject({ status: 'ok', connectsHere: true, signIn: 'bearer' });
    const messageId = res.body.messageId as string;
    const { card } = await cardOf(messageId);
    const form = card.blocks.find((b) => b.type === 'form');
    expect(form?.type === 'form' && form.fields.map((f) => [f.id, f.kind])).toEqual([['secret', 'secret']]);
    const done = await act(messageId, { actionId: CONNECT_HERE_FORM, values: { secret: HA_TOKEN } });
    expect(done.status, done.raw).toBe(200);
    const connectionId = (await cardOf(messageId)).card.answer?.connectionId ?? '';
    const tools = await t.services.db
      .select()
      .from(connectionTools)
      .where(eq(connectionTools.connectionId, connectionId));
    expect(tools.map((x) => x.name)).toContain('HassTurnOn');
  });

  it('sets the card aside on Not now, waking nobody', async () => {
    const turn = await turnInThread();
    const res = await call(turn.token, 'connection_add', {
      service: 'custom_api',
      name: 'Another API',
      address: w.apiUrl('/v1/other'),
      signIn: 'header',
      keyName: 'X-Api-Key',
    });
    const messageId = res.body.messageId as string;
    const no = await act(messageId, { actionId: CONNECT_HERE_DECLINE });
    expect(no.status, no.raw).toBe(200);
    const { card } = await cardOf(messageId);
    expect(card).toMatchObject({ state: 'done' });
    expect(card.answer?.connectionId).toBeUndefined();
    const woken = await t.services.db.select().from(dispatches).where(eq(dispatches.messageId, messageId));
    expect(woken).toHaveLength(0);
  });

  it('tells the assistant what is missing or can’t be reached, before any card', async () => {
    const turn = await turnInThread();
    const none = await call(turn.token, 'connection_add', { service: 'custom_mcp' });
    expect(none.body).toMatchObject({ status: 'failed', reason: 'invalid_address' });
    const away = await call(turn.token, 'connection_add', {
      service: 'custom_api',
      address: 'http://10.99.0.7/api',
    });
    expect(away.body, away.raw).toMatchObject({ status: 'failed', reason: 'not_allowed' });
    const header = await call(turn.token, 'connection_add', {
      service: 'custom_api',
      address: w.apiUrl('/v1/third'),
      signIn: 'header',
    });
    expect(header.body).toMatchObject({ status: 'failed', reason: 'invalid_sign_in' });
    // An API the catalog doesn't know, named by itself with its sign-in, is one set up by talking.
    const named = await call(turn.token, 'connection_add', {
      service: 'Weatherly',
      signIn: 'query',
      keyName: 'appid',
    });
    expect(named.body).toMatchObject({ status: 'failed', reason: 'invalid_address' });
    const posted = await t.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, me.dmId), eq(messages.threadRootId, turn.root)));
    expect(posted.filter((m) => m.card)).toHaveLength(0);
    const weather = await call(turn.token, 'connection_add', {
      service: 'Weatherly',
      address: w.apiUrl('/v1/weather'),
      signIn: 'query',
      keyName: 'appid',
    });
    expect(weather.body, weather.raw).toMatchObject({
      status: 'ok',
      service: 'custom_api',
      connectsHere: true,
    });
    expect((await cardOf(weather.body.messageId as string)).card.connectAsk?.label).toBe('Weatherly');
  });
});

describe('a logo and a page for a connection set up by talking (connection-looks.md)', () => {
  const LOGO =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#5cdd8b" d="M2 2h20v20H2z"/></svg>',
    );
  const recipe = {
    reads: [{ id: 'echo', path: '/echo', query: { hello: 'world' } }],
    counts: {
      title: 'What it says',
      lines: [{ id: 'method', title: 'Asked with', value: { read: 'echo', at: 'method' } }],
    },
    facts: [{ label: 'Path', value: { read: 'echo', at: 'path' } }],
  };

  it('tries a page, keeps it with the logo on save, and shows both', async () => {
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(and(eq(catalogConnections.burrowId, t.burrowId), eq(catalogConnections.label, 'Fake API')));
    if (!row) throw new Error('the fake API isn’t connected');
    const turn = await turnInThread('Give the fake API a page');

    // A path that finds nothing is said, and nothing is kept.
    const wrong = await call(turn.token, 'connection_look', {
      connection: 'Fake API',
      page: { ...recipe, facts: [{ label: 'Path', value: { read: 'echo', at: 'nope.deeper' } }] },
      save: true,
    });
    expect(wrong.body, wrong.raw).toMatchObject({ status: 'ok', saved: false });
    expect(JSON.stringify(wrong.body.page)).toContain('nope.deeper');

    const tried = await call(turn.token, 'connection_look', {
      connection: 'Fake API',
      page: recipe,
      logo: LOGO,
    });
    expect(tried.body, tried.raw).toMatchObject({ status: 'ok', saved: false, logo: { shapes: 1 } });
    expect(JSON.stringify(tried.body.page)).toContain('GET');
    const before = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, row.id));
    expect(before[0]?.page).toBeNull();

    const saved = await call(turn.token, 'connection_look', {
      connection: row.id,
      page: recipe,
      logo: LOGO,
      save: true,
    });
    expect(saved.body, saved.raw).toMatchObject({ status: 'ok', saved: true });
    const [after] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, row.id));
    expect(after?.page).toMatchObject({ reads: [{ id: 'echo' }] });
    expect(after?.logo?.logo.shapes[0]?.fill).toBe('#5cdd8b');
    const changed = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.burrowId, t.burrowId), eq(events.type, 'connection.changed')));
    expect(changed.some((e) => JSON.stringify(e.payload).includes('page'))).toBe(true);

    // The page reads what the recipe names, in slots, with the logo; Home's row has the logo too.
    const page = await w.call(api.things.page, { thing: `connection:${row.id}` });
    expect(page.status, page.raw).toBe(200);
    const parsed = api.things.page.response.parse(page.body);
    expect(parsed.logo?.shapes).toHaveLength(1);
    const panels = parsed.tabs[0]?.panels ?? [];
    const counts = panels.find((p) => p.id === 'counts');
    expect(counts?.kind === 'list' && counts.items[0]?.figure?.value).toBe('GET');
    expect(JSON.stringify(parsed.facts)).toContain('/v1/echo');
    const home = await w.call(api.home.overview, {});
    expect(home.status, home.raw).toBe(200);
    expect(JSON.stringify(home.body)).toContain('#5cdd8b');

    // A catalog service keeps its own look.
    const notCustom = await call(turn.token, 'connection_look', { connection: 'Nobody here', logo: LOGO });
    expect(notCustom.body).toMatchObject({ status: 'refused', reason: 'not_found' });

    // Taken away again: the generic page and mark.
    const removed = await call(turn.token, 'connection_look', {
      connection: row.id,
      page: null,
      logo: 'none',
      save: true,
    });
    expect(removed.body, removed.raw).toMatchObject({ status: 'ok', saved: true, logo: null });
    const [gone] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, row.id));
    expect(gone?.page).toBeNull();
    expect(gone?.logo).toBeNull();
  });
});
