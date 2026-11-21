/**
 * Done recently and Undo through connections (docs/decisions/one-whombat.md ONE-08; one-whombat-assistant.md
 * ONE-DW18…ONE-DW20): a write call that worked is recorded with a plain title and its inverse (Home Assistant's REST
 * turn_off read the light's state first); the person sees every change; Undo runs the inverse as a
 * new call through the pipeline — at once when the keys allow it, as an approval when they ask — and the original shows
 * “undone”. A read is no change; a change without an inverse offers no Undo. What the assistant finished is apart from
 * the changes: `report_done`, one row per thread (done-today.md DN-01…DN-03).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chatRoomHref, chatThreadHref, newId } from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  catalogConnections,
  changes,
  dispatches,
  doneTasks,
  events,
  lookResearches,
  messages,
  principals,
  vaultNetworks,
} from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { insertConnection, setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { agentTokenFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { listChanges, undoChange } from './changes';
import { doneToday, recentDoneTasks } from './done';
import { homeOverview } from './overview';
import {
  CHANGE_MERGE_WINDOW_MS,
  type ChangeInput,
  type ChangeMerge,
  openChange,
  recordChange,
  recordOrMergeChange,
} from './registry';

const t = useTestServer({ seed: true, listen: true });
const TOKEN = 'ha-llat-Undo9Zx8Wc2Vb6Nn1Kd5Hf';
const states: Record<string, { state: string; attributes: Record<string, unknown> }> = {
  'light.hallway': { state: 'on', attributes: { friendly_name: 'Hallway light' } },
};
let server: http.Server;
let port = 0;
let mine: PersonalSetup;
let ha = '';

async function stub() {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://x');
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/api/') return json(200, { message: 'API running.' });
      const state = /^\/api\/states\/(.+)$/.exec(url.pathname);
      if (req.method === 'GET' && state) {
        const s = states[state[1] as string];
        return s ? json(200, { entity_id: state[1], ...s }) : json(404, { message: 'Entity not found.' });
      }
      const svc = /^\/api\/services\/([a-z_]+)\/(turn_on|turn_off)$/.exec(url.pathname);
      if (req.method === 'POST' && svc) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { entity_id?: string };
        const s = body.entity_id ? states[body.entity_id] : undefined;
        if (s) s.state = svc[2] === 'turn_on' ? 'on' : 'off';
        return json(200, []);
      }
      // Reads Home Assistant only answers to a POST (HR-01).
      if (req.method === 'POST' && url.pathname === '/api/template') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('light.porch, light.attic');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/config/core/check_config')
        return json(200, { result: 'valid', errors: null });
      // Any other service call works and changes nothing here (a reload).
      if (req.method === 'POST' && url.pathname.startsWith('/api/services/')) return json(200, []);
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}

async function turn(): Promise<TestMcp> {
  const d = await agentTokenFor(t.services, t.burrowId, mine.agentId, mine.dmId);
  return mcpClient(t.baseUrl, d.token);
}

async function person(id: string) {
  const [row] = await t.services.db.select().from(principals).where(eq(principals.id, id));
  if (!row) throw new Error(id);
  return row;
}

async function switchOff(): Promise<string> {
  const mcp = await turn();
  const res = await mcp.client.callTool({
    name: 'connection_call',
    arguments: {
      connection: 'homeassistant',
      tool: 'request',
      arguments: {
        method: 'POST',
        path: '/api/services/light/turn_off',
        body: { entity_id: 'light.hallway' },
      },
    },
  });
  await mcp.close();
  expect((res.structuredContent as { status?: string }).status, JSON.stringify(res.structuredContent)).toBe(
    'ok',
  );
  const rows = await t.services.db
    .select()
    .from(changes)
    .where(eq(changes.title, 'Turned off Hallway light'));
  const newest = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!newest) throw new Error('no change');
  return newest.id;
}

beforeAll(async () => {
  await stub();
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      if (host !== 'ha.undo.test') throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return [{ address: '192.168.91.10', family: 4 }];
    },
    dialAddress: () => '127.0.0.1',
    deadlineMs: 3000,
  });
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_undo_test',
    cidr: '192.168.91.0/24',
    ports: [port],
    note: 'Undo stub',
    addedAt: t.services.clock(),
  });
  mine = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: null });
  ha = await insertConnection(t.services, {
    catalogId: 'homeassistant',
    burrowId: t.burrowId,
    label: 'Home Assistant',
    fields: { url: `http://ha.undo.test:${port}` },
    secret: TOKEN,
  });
  await setConnectionKeys(t.services, mine.agentId, { read: 'can', write: 'can' });
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
});

describe('changes through connections', () => {
  it('records a write that worked with a plain title and its inverse, for the person', async () => {
    const id = await switchOff();
    expect(states['light.hallway']?.state).toBe('off');
    const [row] = await t.services.db.select().from(changes).where(eq(changes.id, id));
    expect(row).toMatchObject({
      kind: 'connection.call',
      agentId: mine.agentId,
      // Made for the person (one-person.md OP-S52).
      personId: IDS.mara,
      subjectKind: 'connection',
      subjectId: ha,
      undoKind: 'connection.call',
      conversationId: mine.dmId,
    });
    expect(row?.undoEnc).not.toContain('hallway');
    const forMara = await listChanges(t.services.db, await person(IDS.mara), { now: t.services.clock() });
    expect(forMara.changes[0]).toMatchObject({
      id,
      title: 'Turned off Hallway light',
      actor: { kind: 'whombat', id: mine.agentId, name: 'Dusty' },
      undo: { state: 'available' },
      thingId: `connection:${ha}`,
    });
  });

  it('a read is no change', async () => {
    const before = (await t.services.db.select().from(changes)).length;
    const mcp = await turn();
    await mcp.client.callTool({
      name: 'connection_call',
      arguments: {
        connection: 'homeassistant',
        tool: 'request',
        arguments: { method: 'GET', path: '/api/states/light.hallway' },
      },
    });
    await mcp.close();
    expect((await t.services.db.select().from(changes)).length).toBe(before);
  });

  it('Undo runs the inverse through the pipeline and marks the change undone', async () => {
    const id = (await listChanges(t.services.db, await person(IDS.mara), { now: t.services.clock() }))
      .changes[0]?.id as string;
    const res = await undoChange(t.services, await person(IDS.mara), id);
    expect(res.state).toBe('undone');
    expect(res.change.undo.state).toBe('undone');
    expect(states['light.hallway']?.state).toBe('on');
    const list = await listChanges(t.services.db, await person(IDS.mara), { now: t.services.clock() });
    expect(list.changes[0]).toMatchObject({ title: 'Turned on Hallway light', undo: { state: 'available' } });
    await expect(undoChange(t.services, await person(IDS.mara), id)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('Undo asks when the keys ask, and says so', async () => {
    const id = await switchOff();
    await setConnectionKeys(t.services, mine.agentId, { read: 'can', write: 'ask' });
    const res = await undoChange(t.services, await person(IDS.mara), id);
    expect(res.state).toBe('asked');
    expect(res.approvalNumber).toBeGreaterThan(0);
    expect(res.change.undo.state).toBe('available');
    expect(states['light.hallway']?.state).toBe('off');
    await setConnectionKeys(t.services, mine.agentId, { read: 'can', write: 'can' });
  });
});

describe('what Done recently shows (home-redesign.md HR-02, HR-05, HR-06, HR-08)', () => {
  it('a write without words of its own names the connection without its address', async () => {
    const auto = `Home Assistant · ha.undo.test:${port}`;
    await t.services.db.update(catalogConnections).set({ label: auto }).where(eq(catalogConnections.id, ha));
    const mcp = await turn();
    const res = await mcp.client.callTool({
      name: 'connection_call',
      arguments: {
        connection: 'homeassistant',
        tool: 'request',
        arguments: { method: 'POST', path: '/api/services/script/reload', body: {} },
      },
    });
    await mcp.close();
    await t.services.db
      .update(catalogConnections)
      .set({ label: 'Home Assistant' })
      .where(eq(catalogConnections.id, ha));
    expect((res.structuredContent as { status?: string }).status).toBe('ok');
    const [row] = await t.services.db
      .select()
      .from(changes)
      .where(eq(changes.subjectId, ha))
      .orderBy(desc(changes.createdAt))
      .limit(1);
    expect(row?.title).toBe('Changed something in Home Assistant');
  });

  it('the agent’s words name a write Whombat has no words for; Whombat’s own words with Undo win', async () => {
    const mcp = await turn();
    const call = (path: string, body: unknown, change: string) =>
      mcp.client.callTool({
        name: 'connection_call',
        arguments: {
          connection: 'homeassistant',
          tool: 'request',
          arguments: { method: 'POST', path, body },
          change,
        },
      });
    await call('/api/services/script/reload', {}, 'Reloaded the scripts');
    const hallway = states['light.hallway'];
    if (hallway) hallway.state = 'on';
    await call('/api/services/light/turn_off', { entity_id: 'light.hallway' }, 'Switched the hall off');
    await mcp.close();
    const newest = await t.services.db
      .select({ title: changes.title, undoKind: changes.undoKind })
      .from(changes)
      .where(eq(changes.subjectId, ha))
      .orderBy(desc(changes.createdAt))
      .limit(2);
    expect(newest.map((r) => r.title)).toEqual(['Turned off Hallway light', 'Reloaded the scripts']);
    expect(newest[0]?.undoKind).toBe('connection.call');
  });

  it('a person’s own change stays off Home and on the thing’s page', async () => {
    await t.services.db.insert(changes).values({
      id: 'chg_hr05person01',
      burrowId: t.burrowId,
      actorId: IDS.mara,
      personId: IDS.mara,
      kind: 'connection.settings',
      title: 'Renamed Home Assistant',
      subjectKind: 'connection',
      subjectId: ha,
      link: `/things/connection%3A${ha}`,
      createdAt: t.services.clock(),
    });
    const mara = await person(IDS.mara);
    const home = await listChanges(t.services.db, mara, { now: t.services.clock() });
    expect(home.changes.map((c) => c.id)).not.toContain('chg_hr05person01');
    expect(home.changes.every((c) => c.actor.kind === 'whombat')).toBe(true);
    const page = await listChanges(t.services.db, mara, {
      thing: `connection:${ha}`,
      now: t.services.clock(),
    });
    expect(page.changes.find((c) => c.id === 'chg_hr05person01')?.actor).toMatchObject({
      kind: 'person',
      id: IDS.mara,
    });
  });

  it('Review opens the chat or the thread it was made in', async () => {
    const id = await switchOff();
    const forMara = await listChanges(t.services.db, await person(IDS.mara), { now: t.services.clock() });
    // Made at the top of her Chat: the room; made in one of its threads: that thread (chat-channel.md CHT-08).
    expect(forMara.changes.find((c) => c.id === id)).toMatchObject({
      link: chatRoomHref('chat'),
      thingId: `connection:${ha}`,
    });
    await t.services.db.update(changes).set({ threadRootId: 'msg_thread1' }).where(eq(changes.id, id));
    const inThread = await listChanges(t.services.db, await person(IDS.mara), { now: t.services.clock() });
    expect(inThread.changes.find((c) => c.id === id)?.link).toBe(chatThreadHref('chat', 'msg_thread1'));
  });

  it('a save within 2 minutes of the last one merges into it; later, or after an Undo, it is new', async () => {
    const start = new Date('2026-10-18T07:53:00Z');
    const writer = { tx: t.services.db, services: t.services };
    const merge = (fields: string[]): ChangeMerge => ({
      key: 'test.settings:pve-hr06:',
      fields,
      title: (all) => `Changed ${all.join(' and ')} of pve-hr06`,
      undo: (earlier, later) => ({ ...(later as object), ...(earlier as object) }),
    });
    const save = (at: number, field: string, old: string) => {
      const input: ChangeInput = {
        burrowId: t.burrowId,
        actorId: IDS.mara,
        personId: IDS.mara,
        kind: 'test.settings',
        title: 'x',
        subject: { kind: 'server', id: 'pve-hr06' },
        undo: { kind: 'test.settings', payload: { [field]: old } },
        at: new Date(start.getTime() + at),
      };
      return recordOrMergeChange(writer, input, merge([field]));
    };
    const first = await save(0, 'name', 'pve-01');
    expect(await save(60_000, 'notes', '')).toEqual({ changeId: first.changeId, merged: true });
    // Within 2 minutes of the last save (not of the first).
    expect((await save(60_000 + CHANGE_MERGE_WINDOW_MS - 1000, 'name', 'pve-01b')).merged).toBe(true);
    const [row] = await t.services.db.select().from(changes).where(eq(changes.id, first.changeId));
    expect(row).toMatchObject({
      title: 'Changed name and notes of pve-hr06',
      mergeFields: ['name', 'notes'],
    });
    expect(row?.createdAt.getTime()).toBe(start.getTime() + 60_000 + CHANGE_MERGE_WINDOW_MS - 1000);
    const opened = row ? openChange(t.services.custody, row) : null;
    expect(opened?.undo.payload).toEqual({ name: 'pve-01', notes: '' });
    const later = await save(60_000 + 3 * CHANGE_MERGE_WINDOW_MS, 'name', 'pve-01c');
    expect(later.merged).toBe(false);
    await t.services.db
      .update(changes)
      .set({ undoneAt: t.services.clock() })
      .where(eq(changes.id, later.changeId));
    expect((await save(60_000 + 3 * CHANGE_MERGE_WINDOW_MS + 1000, 'notes', 'x')).merged).toBe(false);
  });
});

describe('reads through a POST (home-redesign.md HR-01)', () => {
  it('a template or a config check is a read: the read key alone, no ask, no change', async () => {
    await setConnectionKeys(t.services, mine.agentId, { read: 'can', write: 'cannot' });
    try {
      const before = (await t.services.db.select().from(changes)).length;
      const mcp = await turn();
      for (const args of [
        { method: 'POST', path: '/api/template', body: { template: '{{ states.light | list }}' } },
        { method: 'POST', path: '/api/config/core/check_config' },
      ]) {
        const res = await mcp.client.callTool({
          name: 'connection_call',
          arguments: { connection: 'homeassistant', tool: 'request', arguments: args },
        });
        expect((res.structuredContent as { status?: string }).status).toBe('ok');
      }
      await mcp.close();
      expect((await t.services.db.select().from(changes)).length).toBe(before);
      const called = await t.services.db
        .select()
        .from(events)
        .where(eq(events.type, 'connection.tool_called'))
        .orderBy(desc(events.seq))
        .limit(2);
      expect(called.map((e) => (e.payload as { access?: string }).access)).toEqual(['read', 'read']);
    } finally {
      await setConnectionKeys(t.services, mine.agentId, { read: 'can', write: 'can' });
    }
  });
});

describe('report_change and its Undo (home-redesign.md HR-03)', () => {
  async function report(args: Record<string, unknown>) {
    const mcp = await turn();
    const res = await mcp.client.callTool({ name: 'report_change', arguments: args });
    await mcp.close();
    return res.structuredContent as { status: string; changeId?: string; code?: string };
  }

  it('records a change made outside connections, Undo asks the agent in its chat, and its report puts it back', async () => {
    const made = await report({
      title: 'Removed 14 old Zonneplan entities',
      thing: 'homeassistant',
      undo: 'Backup at /backup/ha-entities.tar',
    });
    expect(made.status).toBe('ok');
    const id = made.changeId as string;
    const [row] = await t.services.db.select().from(changes).where(eq(changes.id, id));
    expect(row).toMatchObject({
      kind: 'agent.report',
      agentId: mine.agentId,
      subjectKind: 'connection',
      subjectId: ha,
      conversationId: mine.dmId,
      undoKind: 'agent.report',
    });
    expect(row?.undoEnc).not.toContain('backup');
    const mara = await person(IDS.mara);
    const listed = (await listChanges(t.services.db, mara, { now: t.services.clock() })).changes.find(
      (c) => c.id === id,
    );
    expect(listed).toMatchObject({ undo: { state: 'available' }, link: chatRoomHref('chat') });

    // Undo: Mara's message in the chat, and the agent woken there with its own note.
    const asked = await undoChange(t.services, mara, id);
    expect(asked).toMatchObject({ state: 'requested', conversationId: mine.dmId });
    const [wake] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.agentId, mine.agentId), eq(dispatches.trigger, 'undo_requested')));
    expect(wake?.conversationId).toBe(mine.dmId);
    const [said] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, wake?.messageId as string));
    expect(said).toMatchObject({ authorId: IDS.mara, conversationId: mine.dmId, threadRootId: null });
    expect(said?.text).toContain('Removed 14 old Zonneplan entities');
    // In Chat the ask starts its own thread (the change was made at the top), and the assistant answers in it (CHT-02).
    expect(wake?.threadRootId).toBe(said?.id);
    const context = await buildDispatchContext(t.services, wake as NonNullable<typeof wake>);
    expect(context.undoRequest).toEqual({
      changeId: id,
      title: 'Removed 14 old Zonneplan entities',
      undo: 'Backup at /backup/ha-entities.tar',
    });
    // A second press soon after asks nobody again.
    await expect(undoChange(t.services, mara, id)).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('already undoing'),
    });

    const back = await report({ title: 'Put the 14 Zonneplan entities back', undoes: id });
    expect(back.status).toBe('ok');
    const [undone] = await t.services.db.select().from(changes).where(eq(changes.id, id));
    expect(undone).toMatchObject({ undoneById: IDS.mara, undoChangeId: back.changeId });
    expect((await report({ title: 'Again', undoes: id })).code).toBe('already_undone');
  });

  it('refuses a thing it can’t see and a change that isn’t here', async () => {
    expect((await report({ title: 'Changed the moon', thing: 'server:moon-01' })).code).toBe('unknown_thing');
    expect((await report({ title: 'Undid it', undoes: 'chg_hr03nothing1' })).code).toBe('unknown_change');
  });
});

describe('report_done: what the assistant finished, for the desk’s Done today (done-today.md DN-01…DN-03)', () => {
  /** A question of Mara's in her Chat: the thread the assistant answers it in. */
  async function question(text: string): Promise<string> {
    const id = newId('message');
    await t.services.db.insert(messages).values({
      id,
      burrowId: t.burrowId,
      conversationId: mine.dmId,
      authorId: IDS.mara,
      createdAt: t.services.clock(),
      text,
    });
    return id;
  }

  async function done(summary: string, threadRootId: string, onBehalfOfAccountId?: string | null) {
    const d = await agentTokenFor(t.services, t.burrowId, mine.agentId, mine.dmId, {
      threadRootId,
      ...(onBehalfOfAccountId !== undefined ? { onBehalfOfAccountId } : {}),
    });
    const mcp = await mcpClient(t.baseUrl, d.token);
    const res = await mcp.client.callTool({ name: 'report_done', arguments: { summary } });
    await mcp.close();
    return res;
  }

  it('keeps one task per thread, its latest words, newest first; the signed event carries no words', async () => {
    const pve = await question('Can you check on pve-01?');
    const plex = await question('Plex is stuck again');
    expect((await done('Checked the status of pve-01', pve)).structuredContent).toMatchObject({
      status: 'ok',
    });
    expect((await done('Restarted Plex', plex)).structuredContent).toMatchObject({ status: 'ok' });
    // More done in the first thread later: its words and time are replaced, still one task.
    await done('Checked pve-01 and freed its disk', pve);

    const rows = await t.services.db.select().from(doneTasks).where(eq(doneTasks.conversationId, mine.dmId));
    expect(rows.map((r) => [r.threadRootId, r.summary]).sort()).toEqual(
      [
        [pve, 'Checked pve-01 and freed its disk'],
        [plex, 'Restarted Plex'],
      ].sort(),
    );
    expect(rows.every((r) => r.agentId === mine.agentId && r.personId === IDS.mara)).toBe(true);
    const recent = await recentDoneTasks(t.services.db, t.burrowId, 10);
    expect(recent.map((r) => r.text).slice(0, 2)).toEqual([
      'Checked pve-01 and freed its disk',
      'Restarted Plex',
    ]);

    const signed = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.burrowId, t.burrowId), eq(events.type, 'task.done')));
    expect(signed.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(signed)).not.toContain('pve-01');
  });

  it('gives Chat’s Done today: Mara’s own of today, its thread, a fix, and Undo only for a task’s one change', async () => {
    const zigbee = await question('Zigbee stopped working');
    const light = await question('Turn off the hallway light');
    const tidy = await question('Tidy Home Assistant');
    await done('Restarted Zigbee', zigbee);
    await done('Turned off the hallway light', light);
    await done('Tidied Home Assistant', tidy);
    const now = t.services.clock();
    // The look Neo fixed in its own thread (look-research.md LR-S16 reports it there).
    await t.services.db.insert(lookResearches).values({
      id: newId('lookResearch'),
      burrowId: t.burrowId,
      agentId: mine.agentId,
      personId: IDS.mara,
      lookKey: `connection:${ha}`,
      kind: 'connection',
      name: 'Home Assistant',
      rank: 1,
      state: 'fixed',
      conversationId: mine.dmId,
      threadRootId: zigbee,
      startedAt: now,
      stateAt: now,
    });
    const writer = { tx: t.services.db, services: t.services };
    const made = (title: string, threadRootId: string) =>
      recordChange(writer, {
        burrowId: t.burrowId,
        actorId: mine.agentId,
        agentId: mine.agentId,
        personId: IDS.mara,
        kind: 'agent.report',
        title,
        undo: { kind: 'agent.report', payload: { how: 'put it back' } },
        conversationId: mine.dmId,
        threadRootId,
      });
    const off = await made('Turned off Hallway light', light);
    await made('Removed 3 old entities', tidy);
    await made('Renamed 2 rooms', tidy);

    const mara = await person(IDS.mara);
    const today = await doneToday(t.services.db, mara, t.services.clock(), 'UTC');
    const byText = new Map(today.map((d) => [d.text, d]));
    expect(byText.get('Restarted Zigbee')).toMatchObject({
      fixed: true,
      href: chatThreadHref('chat', zigbee),
    });
    expect(byText.get('Turned off the hallway light')).toMatchObject({ undo: { changeId: off } });
    expect(byText.get('Turned off the hallway light')?.fixed).toBeUndefined();
    // Two changes in one task: Undo would have to guess, so Everything I did has them.
    expect(byText.get('Tidied Home Assistant')?.undo).toBeUndefined();
    // Newest first, and nobody else's.
    expect(today.map((d) => d.at)).toEqual([...today.map((d) => d.at)].sort().reverse());
    expect(await doneToday(t.services.db, await person(mine.agentId), t.services.clock(), 'UTC')).toEqual([]);
    // Home's overview carries it.
    const burrow = await t.services.db.query.burrows.findFirst();
    if (!burrow) throw new Error('burrow');
    const home = await homeOverview(t.services, { principal: mara, burrow });
    expect(home.doneToday?.map((d) => d.text)).toContain('Restarted Zigbee');
  });

  it('is no tool of an outsiders’ turn', async () => {
    const thread = await question('A customer’s report');
    const res = await done('Answered a customer', thread, null);
    expect(res.isError).toBe(true);
    const rows = await t.services.db.select().from(doneTasks).where(eq(doneTasks.threadRootId, thread));
    expect(rows).toEqual([]);
  });
});
