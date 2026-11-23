/**
 * Home and Watch (docs/decisions/one-whombat.md ONE-05, ONE-07, ONE-09, ONE-10; one-whombat-assistant.md ONE-DW21…):
 * Needs you from approvals (Approve · Tonight at 03:00 · Not now), Whombat's open questions and connections to
 * reconnect, snoozed by the person; Working on from Whombat's open plan in a chat; Your things from the connections with the
 * health poller's glance; registry sources merged; Approve later runs at its time; a pinned widget reads its tool
 * without the model; Watch lists what stopped working; the REST routes answer the contract. Chats with the assistant
 * (home-redesign.md HR-40…HR-43): working, waiting, the newest others, and `home.changed` as they move; a connection's
 * last call that worked (HR-45).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chatThreadHref,
  HomeOverview,
  newId,
  thingId,
  topics,
  WatchListResponse,
  WidgetsResponse,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { settleAgentStatus } from '../commands/agent-status';
import { decideApproval, requestApproval } from '../commands/approvals';
import { sendMessage } from '../commands/messages';
import { createPlan, updatePlanStep } from '../commands/plans';
import { callArgsAad, callConnectionTool, executeConnectionCall, newCallId } from '../connections/call';
import { syncTools } from '../connections/sync';
import {
  applianceEvents,
  approvals,
  catalogConnections,
  connections,
  connectionTools,
  conversations,
  dispatches,
  githubConnections,
  messages,
  needsYouSnoozes,
  plans,
  principals,
  vaultNetworks,
  watchOns,
  widgetPoints,
  widgets,
} from '../db/schema/index';
import { useBoxBackup } from '../managed/box-backup';
import { runInDispatchScope } from '../runtime/dispatch-scope';
import { IDS } from '../seed/test-world';
import { simulateExecutors } from '../test/approvals';
import { insertConnection, setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { taskChatWith } from '../test/task-chats';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import type { GlanceLine } from '../things/quiet/glance';
import { attachFakeHomeAssistant, fakeHaState } from '../things/testing/fake-ha';
import { useVaultNetForTests } from '../vault/net';
import { registerBoxBackupSource } from './box-backup';
import { checkConnectionHealth } from './health';
import { runDueApprovals } from './jobs';
import { pollMailGlances } from './mail-glance';
import { homeOverview, watchList, workingTask } from './overview';
import { registerNeedsYouSource, registerThingsSource, unregister } from './registry';
import { ignoreNeedsYou, snoozeNeedsYou } from './snoozes';
import { nextLocalTime } from './time';
import { pinWidget, refreshWidget } from './widgets';

const t = useTestServer({ seed: true, listen: true });
const TOKEN = 'ha-llat-Home9Zx8Wc2Vb6Nn1Kd5Hf';
let server: http.Server;
let port = 0;
let mine: PersonalSetup;
let ha = '';
let cookie = '';
const pump = { flow: 34.5, outside: '9' };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/') return json({ message: 'API running.' });
    if (url.pathname === '/api/states')
      return json([
        {
          entity_id: 'climate.living_room',
          state: 'heat',
          attributes: { friendly_name: 'Living room', current_temperature: 21, hvac_action: 'heating' },
        },
        { entity_id: 'alarm_control_panel.home', state: 'armed_home', attributes: {} },
        { entity_id: 'lock.front_door', state: 'locked', attributes: { friendly_name: 'Front door' } },
        { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen' } },
        { entity_id: 'light.hall', state: 'on', attributes: { friendly_name: 'Hall' } },
        { entity_id: 'light.porch', state: 'off', attributes: {} },
      ]);
    if (url.pathname === '/api/states/sensor.heat_pump')
      return json({
        entity_id: 'sensor.heat_pump',
        state: 'ok',
        attributes: { flow: pump.flow, outside: pump.outside },
      });
    res.writeHead(404).end();
  });
  // Home Assistant's WebSocket API: its tile says how it runs (connection-pages.md CP-16).
  const detach = attachFakeHomeAssistant(server, fakeHaState({ token: TOKEN }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  useVaultNetForTests(t.services, {
    resolve: async () => [{ address: '192.168.92.10', family: 4 }],
    dialAddress: () => '127.0.0.1',
    deadlineMs: 3000,
  });
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_home_test',
    cidr: '192.168.92.0/24',
    ports: [port],
    note: 'Home stub',
    addedAt: t.services.clock(),
  });
  mine = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: null });
  ha = await insertConnection(t.services, {
    catalogId: 'homeassistant',
    burrowId: t.burrowId,
    label: 'Home Assistant',
    fields: { url: `http://ha.home-test.test:${port}` },
    secret: TOKEN,
  });
  // Repairs start off (watch-defaults.md): this person turned them on, so the waiting repair says it first.
  await t.services.db.insert(watchOns).values({
    ownerId: t.burrowId,
    thingId: thingId('connection', ha),
    checkId: 'homeassistant.repair',
    byId: IDS.mara,
    at: t.services.clock(),
  });
  await setConnectionKeys(t.services, mine.agentId, { read: 'can', write: 'can' });
  await syncTools(t.services, ha);
  simulateExecutors(t.services, 'deploy');
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  return async () => {
    detach();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
});

async function viewer(id: string) {
  const [principal] = await t.services.db.select().from(principals).where(eq(principals.id, id));
  const burrow = await t.services.db.query.burrows.findFirst();
  if (!principal || !burrow) throw new Error('viewer');
  return { principal, burrow };
}

/** The parts of every `home.changed` the person gets from now on (topic `me`). */
function homeChanged(personId: string) {
  const parts: string[][] = [];
  const stop = t.services.bus.onFrame((f) => {
    if (f.topic === topics.me(personId) && f.event.type === 'home.changed') parts.push([...f.event.parts]);
  });
  return { parts, stop };
}

/** An agent's call of Home Assistant's `request` tool, decided and run as the MCP tool does. */
async function callHa(agentId: string, args: Record<string, unknown>, conversationId?: string) {
  const [tool] = await t.services.db
    .select()
    .from(connectionTools)
    .where(and(eq(connectionTools.connectionId, ha), eq(connectionTools.name, 'request')));
  const [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, ha));
  if (!tool || !row) throw new Error('no request tool');
  const callId = newCallId();
  const asked = await t.commit(agentId, callConnectionTool, {
    connectionId: ha,
    handle: row.handle,
    tool: 'request',
    toolHash: tool.hash,
    callId,
    argsEnc: t.services.custody.seal(callArgsAad(callId), JSON.stringify(args)),
    ...(conversationId ? { conversationId } : {}),
  });
  if (asked.status !== 'ok') return { asked, result: null };
  const result = await executeConnectionCall(t.services, {
    burrowId: t.burrowId,
    agentId,
    connectionId: ha,
    tool: 'request',
    handle: row.handle,
    callId,
    args,
    where: null,
    conversationId: conversationId ?? null,
  });
  return { asked, result };
}

async function ask(title: string) {
  const res = await t.commit(IDS.dusty, requestApproval, {
    conversationId: IDS.billing,
    action: {
      type: 'deploy',
      params: { environment: 'staging', service: 'billing-api', ref: 'main', sha: null },
    },
    title,
    question: `${title}?`,
    target: 'staging · billing-api',
    whatHappens: ['Roll billing-api to staging'],
    explainer: 'It is down for about 40 seconds.',
    summary: '',
    conditions: [],
    approverIds: [IDS.mara],
  });
  if (res.status !== 'ok') throw new Error(res.status);
  return res.result;
}

describe('Needs you', () => {
  it('shows an approval with its yes, tonight and no; a snooze hides it for the person only', async () => {
    const asked = await ask('Restart billing on staging');
    const home = await homeOverview(t.services, await viewer(IDS.mara));
    const item = home.needsYou.find((i) => i.approvalNumber === asked.number);
    expect(item).toMatchObject({
      kind: 'approval',
      title: 'Deploy main to staging?',
      body: 'It is down for about 40 seconds.',
    });
    expect(item?.actions.map((a) => a.kind)).toEqual(['approve', 'approve_later', 'decline']);
    const burrow = (await viewer(IDS.mara)).burrow;
    expect(item?.actions[1]?.at).toBe(nextLocalTime(t.services.clock(), burrow.timeZone, 3).toISOString());
    expect(home.summary.needsYou).toBeGreaterThan(0);
    const until = new Date(t.services.clock().getTime() + 3600_000).toISOString();
    expect(
      (await t.commit(IDS.mara, snoozeNeedsYou, { ref: item?.ref as { kind: string; id: string }, until }))
        .status,
    ).toBe('ok');
    const later = await homeOverview(t.services, await viewer(IDS.mara));
    expect(later.needsYou.find((i) => i.approvalNumber === asked.number)).toBeUndefined();
  });

  it('Ignore hides an item for good, leaves the approval undecided, and can be taken back (CT-352)', async () => {
    const asked = await ask('Restart billing next week');
    const item = (await homeOverview(t.services, await viewer(IDS.mara))).needsYou.find(
      (i) => i.approvalNumber === asked.number,
    );
    const ref = item?.ref as { kind: string; id: string };
    expect((await t.commit(IDS.mara, ignoreNeedsYou, { ref, ignored: true })).status).toBe('ok');
    const later = await homeOverview(t.services, await viewer(IDS.mara));
    expect(later.needsYou.find((i) => i.approvalNumber === asked.number)).toBeUndefined();
    // For good: no end, and the approval is still waiting.
    const [mark] = await t.services.db
      .select()
      .from(needsYouSnoozes)
      .where(and(eq(needsYouSnoozes.personId, IDS.mara), eq(needsYouSnoozes.refId, ref.id)));
    expect(mark).toMatchObject({ state: 'ignored', until: null });
    const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, asked.approvalId));
    expect(row?.state).toBe('pending');
    // Taken back (the toast's Undo): it needs her again.
    expect((await t.commit(IDS.mara, ignoreNeedsYou, { ref, ignored: false })).status).toBe('ok');
    const back = await homeOverview(t.services, await viewer(IDS.mara));
    expect(back.needsYou.find((i) => i.approvalNumber === asked.number)).toBeDefined();
  });

  it('Talk to the assistant about it: a new thread it opens with the item’s words, no turn until she writes (IBX-07)', async () => {
    const asked = await ask('Restart billing on Friday');
    const item = (await homeOverview(t.services, await viewer(IDS.mara))).needsYou.find(
      (i) => i.approvalNumber === asked.number,
    );
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const res = await t.api.inject({
      method: 'POST',
      url: '/api/v1/burrows/burrow-hq/needs-you/discuss',
      headers: { cookie },
      payload: { ref: item?.ref },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const body = res.json();
    expect(body.conversation.id).toBe(mine.dmId);
    expect(body.message).toMatchObject({ authorId: mine.agentId, threadRootId: null });
    expect(body.message.text).toContain('Deploy main to staging');
    const turns = await t.services.db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(eq(dispatches.threadRootId, body.message.id));
    expect(turns).toEqual([]);
    // What isn't in her Inbox can't be talked over this way.
    const gone = await t.api.inject({
      method: 'POST',
      url: '/api/v1/burrows/burrow-hq/needs-you/discuss',
      headers: { cookie },
      payload: { ref: { kind: 'approval', id: 'nope' } },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('Approve later: a yes now runs at its time, not before', async () => {
    const calls: string[] = [];
    t.services.approvals.setExecutor('deploy', async (a) => {
      calls.push(a.id);
      return { ok: true, resultUrl: null };
    });
    const asked = await ask('Restart billing tonight');
    const at = new Date(t.services.clock().getTime() + 3600_000).toISOString();
    await expect(
      t.commit(IDS.mara, decideApproval, { number: asked.number, decision: 'decline', executeAt: at }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      t.commit(IDS.mara, decideApproval, {
        number: asked.number,
        decision: 'approve',
        executeAt: new Date(t.services.clock().getTime() + 8 * 24 * 3600_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(
      (await t.commit(IDS.mara, decideApproval, { number: asked.number, decision: 'approve', executeAt: at }))
        .status,
    ).toBe('ok');
    expect(calls).not.toContain(asked.approvalId);
    expect(await runDueApprovals(t.services)).toBe(0);
    const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, asked.approvalId));
    expect(row?.state).toBe('approved');
    expect(row?.executeAt?.toISOString()).toBe(at);
    // Its time comes.
    await t.services.db
      .update(approvals)
      .set({ executeAt: new Date(t.services.clock().getTime() - 1000) })
      .where(eq(approvals.id, asked.approvalId));
    expect(await runDueApprovals(t.services)).toBe(1);
    expect(calls).toContain(asked.approvalId);
  });

  it('the assistant’s open question shows until the person answers', async () => {
    // A task chat from before Chat keeps its rule: any later message answers.
    const conversationId = await taskChatWith(
      t.services,
      t.burrowId,
      mine.agentId,
      IDS.mara,
      'Set up the heat pump',
    );
    await t.commit(mine.agentId, sendMessage, {
      conversationId,
      text: 'May I read the gateway at 10.100.0.42?',
      asks: true,
    });
    let home = await homeOverview(t.services, await viewer(IDS.mara));
    expect(home.needsYou.find((i) => i.kind === 'question')).toMatchObject({
      title: 'May I read the gateway at 10.100.0.42?',
      body: 'In “Set up the heat pump”',
      actions: [{ kind: 'open', href: `/chats/${conversationId}` }],
    });
    const asked = async (id?: string) =>
      (await homeOverview(t.services, await viewer(IDS.mara))).needsYou.some(
        (i) => i.kind === 'question' && (!id || i.ref.id === id),
      );
    // Neither the assistant's own later message nor one of theirs they deleted answers it.
    await t.commit(mine.agentId, sendMessage, { conversationId, text: 'I’ll wait for you.' });
    const deleted = await t.commit(IDS.mara, sendMessage, { conversationId, text: 'Hold on' });
    if (deleted.status !== 'ok') throw new Error(deleted.status);
    await t.services.db
      .update(messages)
      .set({ deletedAt: t.services.clock() })
      .where(eq(messages.id, deleted.result.id));
    expect(await asked()).toBe(true);
    await t.commit(IDS.mara, sendMessage, { conversationId, text: 'Yes' });
    home = await homeOverview(t.services, await viewer(IDS.mara));
    expect(home.needsYou.find((i) => i.kind === 'question')).toBeUndefined();
    // In Chat it names the assistant, never “Whombat” (assistant-name.md AN-01), and Answer opens its thread; only a
    // reply in that thread answers it (chat-channel.md CHT-08).
    const shall = await t.commit(mine.agentId, sendMessage, {
      conversationId: mine.dmId,
      text: 'Shall I?',
      asks: true,
    });
    if (shall.status !== 'ok') throw new Error(shall.status);
    const question = async () =>
      (await homeOverview(t.services, await viewer(IDS.mara))).needsYou.find((i) => i.kind === 'question');
    expect(await question()).toMatchObject({
      body: 'In your chat with Dusty',
      actions: [{ kind: 'open', href: chatThreadHref('chat', shall.result.id) }],
    });
    await t.commit(IDS.mara, sendMessage, { conversationId: mine.dmId, text: 'Something else' });
    expect((await question())?.ref.id).toBe(shall.result.id);
    await t.commit(IDS.mara, sendMessage, {
      conversationId: mine.dmId,
      text: 'Yes',
      threadRootId: shall.result.id,
    });
    expect(await question()).toBeUndefined();
    // A question asked inside a thread: their reply before it, one in another thread or one they deleted doesn't answer
    // it; a later reply of theirs in that thread does.
    const again = await t.commit(mine.agentId, sendMessage, {
      conversationId: mine.dmId,
      text: 'Restart it too?',
      asks: true,
      threadRootId: shall.result.id,
    });
    if (again.status !== 'ok') throw new Error(again.status);
    expect(await asked(again.result.id)).toBe(true);
    const elsewhere = await t.commit(IDS.mara, sendMessage, {
      conversationId: mine.dmId,
      text: 'Another thing',
    });
    if (elsewhere.status !== 'ok') throw new Error(elsewhere.status);
    await t.commit(IDS.mara, sendMessage, {
      conversationId: mine.dmId,
      text: 'Yes',
      threadRootId: elsewhere.result.id,
    });
    const undone = await t.commit(IDS.mara, sendMessage, {
      conversationId: mine.dmId,
      text: 'Yes',
      threadRootId: shall.result.id,
    });
    if (undone.status !== 'ok') throw new Error(undone.status);
    await t.services.db
      .update(messages)
      .set({ deletedAt: t.services.clock() })
      .where(eq(messages.id, undone.result.id));
    expect(await asked(again.result.id)).toBe(true);
    await t.commit(IDS.mara, sendMessage, {
      conversationId: mine.dmId,
      text: 'Yes, restart it',
      threadRootId: shall.result.id,
    });
    expect(await asked(again.result.id)).toBe(false);

    // Working on: Whombat's open plan in that chat.
    await t.services.db.insert(plans).values({
      id: newId('plan'),
      burrowId: t.burrowId,
      title: 'Adding your Daikin heat pump',
      conversationId,
      createdById: mine.agentId,
      createdAt: t.services.clock(),
      steps: [
        {
          id: newId('step'),
          title: 'Found it on your network',
          state: 'done',
          stateLabel: 'Done',
          runId: null,
          approvalId: null,
          automationRunId: null,
          dispatchId: null,
          note: 'A Modbus gateway at 10.100.0.42',
          updatedAt: null,
          refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
        },
        {
          id: newId('step'),
          title: 'Waiting for you',
          state: 'gate',
          stateLabel: 'Needs a person',
          runId: null,
          approvalId: null,
          automationRunId: null,
          dispatchId: null,
          note: null,
          updatedAt: null,
          refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
        },
        {
          id: newId('step'),
          title: 'Add it to the night-time heating',
          state: 'queued',
          stateLabel: 'Queued',
          runId: null,
          approvalId: null,
          automationRunId: null,
          dispatchId: null,
          note: null,
          updatedAt: null,
          refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
        },
      ],
    });
    home = await homeOverview(t.services, await viewer(IDS.mara));
    expect(await workingTask(t.services, await viewer(IDS.mara))).toMatchObject({
      conversationId,
      title: 'Adding your Daikin heat pump',
      progress: { done: 1, total: 3 },
      steps: [
        { title: 'Found it on your network', detail: 'A Modbus gateway at 10.100.0.42', state: 'done' },
        { title: 'Waiting for you', state: 'waiting' },
        { title: 'Add it to the night-time heating', state: 'todo' },
      ],
    });
    expect(home.summary.working).toBe(1);
  });
});

describe('Needs you names the agent (assistant-name.md AN-01; one-agent.md OA-08)', () => {
  it('names the agent for a connection to reconnect', async () => {
    await t.services.db
      .update(catalogConnections)
      .set({ status: 'needs_reauth' })
      .where(eq(catalogConnections.id, ha));
    try {
      const home = await homeOverview(t.services, await viewer(IDS.mara));
      expect(home.needsYou.find((i) => i.ref.id === ha)?.body).toContain('Dusty');
      const watch = await watchList(t.services, await viewer(IDS.mara), { state: 'all' });
      expect(watch.find((i) => i.ref.id === ha)?.body).toContain('Dusty');
    } finally {
      await t.services.db
        .update(catalogConnections)
        .set({ status: 'active' })
        .where(eq(catalogConnections.id, ha));
    }
  });
});

describe('Your things, health and Watch', () => {
  it('a connection shows the health poller’s glance; registry sources merge in, a broken one is left out', async () => {
    const [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, ha));
    if (!row) throw new Error('no connection');
    const glance = await checkConnectionHealth(t.services, row);
    // How Home Assistant runs, never the house (connection-pages.md CP-16).
    expect(glance).toMatchObject({
      status: 'warn',
      line: 'Home Assistant 2026.10.2',
      facts: [
        { label: 'Integrations', value: '169 of 171', note: '2 not loading' },
        { label: 'Log errors', value: expect.any(String), note: 'since restart' },
        { label: 'Updates', value: '2', note: 'waiting' },
      ],
      // The noisiest source in its log, for the page's errors chart (dashboards-server.md DS-S07).
      logTop: 'knx',
      // Why it needs a look, for the sidebar's dot (sidebar.md SB-03): an integration that doesn't load colours it
      // only from the second pass in a row (quiet-notices.md QN-04), so the repair says it first.
      reason: 'A repair is waiting',
    });
    // The lines that could colour it, kept for whoever shows it (QN-S07).
    expect(glance?.lines?.map((l) => [l.check, l.seen])).toEqual([
      ['homeassistant.integration', 1],
      ['homeassistant.repair', 1],
    ]);
    registerThingsSource('test.servers', async () => [
      {
        id: 'server:pve-02',
        kind: 'server',
        name: 'pve-02',
        icon: 'server',
        status: 'warn',
        facts: [],
        href: '/things/server%3Apve-02',
      },
    ]);
    registerNeedsYouSource('test.broken', async () => {
      throw new Error('hosts down');
    });
    const home = await homeOverview(t.services, await viewer(IDS.mara));
    // The seeded world has GitHub's repositories, so GitHub is one of them too.
    expect(home.things.map((x) => x.id)).toEqual(['server:pve-02', 'connection:github', `connection:${ha}`]);
    expect(home.things.find((x) => x.id === `connection:${ha}`)).toMatchObject({
      name: 'Home Assistant',
      status: 'warn',
      line: 'Home Assistant 2026.10.2',
      catalogId: 'homeassistant',
      reason: 'A repair is waiting',
    });
    unregister('things', 'test.servers');
    unregister('needsYou', 'test.broken');
  });

  it('a health pass that changes nothing on the glance tells Home nothing', async () => {
    const pass = async () => {
      const [row] = await t.services.db
        .select()
        .from(catalogConnections)
        .where(eq(catalogConnections.id, ha));
      if (!row) throw new Error('no connection');
      return checkConnectionHealth(t.services, row);
    };
    // Until its lines have been seen twice in a row, a pass can still change what colours the glance.
    await pass();
    await pass();
    await pass();
    const heard = homeChanged(IDS.mara);
    try {
      await pass();
      expect(heard.parts).toEqual([]);
    } finally {
      heard.stop();
    }
  });

  it('the person’s Google account is a connection by its name, with its unread mail', async () => {
    const google = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: ['mail'] });
    expect(await pollMailGlances(t.services)).toBeGreaterThan(0);
    const mara = await homeOverview(t.services, await viewer(IDS.mara));
    const mail = mara.things.find((x) => x.icon === 'google');
    expect(mail).toMatchObject({
      kind: 'connection',
      name: 'Google',
      status: 'ok',
      facts: [{ label: 'Unread' }],
    });
    expect(mail?.line).toMatch(/^\d+\+? unread · /);
    await t.services.db.delete(connections).where(eq(connections.id, google.connectionId as string));
  });

  it('a Google account without mail is a connection too, saying which account it is', async () => {
    const google = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: ['calendar'] });
    try {
      const mara = await homeOverview(t.services, await viewer(IDS.mara));
      const thing = mara.things.find((x) => x.id === `connection:${google.connectionId}`);
      expect(thing).toMatchObject({ name: 'Google', status: 'ok', facts: [] });
      expect(thing?.line).toContain('@');
    } finally {
      await t.services.db.delete(connections).where(eq(connections.id, google.connectionId as string));
    }
  });

  it('GitHub connected here is a connection with its account and repositories', async () => {
    await t.services.db
      .insert(githubConnections)
      .values({ burrowId: t.burrowId, login: 'mara-gh', connectedById: IDS.mara })
      .onConflictDoNothing();
    try {
      const mara = await homeOverview(t.services, await viewer(IDS.mara));
      const github = mara.things.find((x) => x.id === 'connection:github');
      expect(github).toMatchObject({ kind: 'connection', name: 'GitHub', icon: 'github', status: 'ok' });
      expect(github?.line).toMatch(/^@mara-gh · \d+ repositor(y|ies) on$/);
      expect(github?.href).toBe('/things/connection%3Agithub');
    } finally {
      await t.services.db.delete(githubConnections).where(eq(githubConnections.burrowId, t.burrowId));
    }
  });

  it('Watch lists a connection that stopped answering, and a snooze takes it out of the open list', async () => {
    await t.services.db
      .update(catalogConnections)
      .set({
        glance: { status: 'offline', line: 'Couldn’t reach it', facts: [], reason: 'Couldn’t reach it' },
      })
      .where(eq(catalogConnections.id, ha));
    const items = await watchList(t.services, await viewer(IDS.mara));
    expect(items.find((i) => i.ref.id === ha)).toMatchObject({
      source: 'connection',
      severity: 'bad',
      title: 'Home Assistant isn’t answering',
      state: 'open',
    });
    const until = new Date(t.services.clock().getTime() + 3600_000).toISOString();
    await t.commit(IDS.mara, snoozeNeedsYou, { ref: { kind: 'connection', id: ha }, until });
    expect(
      (await watchList(t.services, await viewer(IDS.mara))).find((i) => i.ref.id === ha),
    ).toBeUndefined();
    expect(
      (await watchList(t.services, await viewer(IDS.mara), { state: 'all' })).find((i) => i.ref.id === ha)
        ?.state,
    ).toBe('snoozed');
    await t.services.db.update(catalogConnections).set({ glance: null }).where(eq(catalogConnections.id, ha));
  });

  it('Needs you counts a watched problem at warn, as the desk screen does, and never a heads-up', async () => {
    const line = (check: string, nature: 'problem' | 'fyi', title: string): GlanceLine => ({
      check,
      nature,
      tone: 'warn',
      title,
      seen: 3,
      confirm: 2,
    });
    const glance = (l: GlanceLine) =>
      t.services.db
        .update(catalogConnections)
        .set({ glance: { status: 'warn', line: l.title, facts: [], reason: l.title, lines: [l] } })
        .where(eq(catalogConnections.id, ha));
    const item = async () =>
      (await homeOverview(t.services, await viewer(IDS.mara))).needsYouList?.find((i) => i.ref.id === ha);
    // The test before snoozed it.
    await t.services.db.delete(needsYouSnoozes).where(eq(needsYouSnoozes.refId, ha));
    await glance(line('homeassistant.backup', 'problem', 'No backup for 3 days'));
    expect(await item()).toMatchObject({
      severity: 'warn',
      nature: 'problem',
      title: 'Home Assistant: No backup for 3 days',
      group: 'you',
    });
    await glance(line('homeassistant.unavailable', 'fyi', '3 devices not answering'));
    expect(await item()).toBeUndefined();
    await t.services.db.update(catalogConnections).set({ glance: null }).where(eq(catalogConnections.id, ha));
  });
});

describe('Your things: everything connected (home-redesign.md HR-23, HR-45)', () => {
  it('lists a connection without figures, with when a call through it last worked', async () => {
    const thing = async () =>
      (await homeOverview(t.services, await viewer(IDS.mara))).things.find(
        (x) => x.id === `connection:${ha}`,
      );
    // Not looked at yet: no figures, still on Home.
    expect(await thing()).toMatchObject({ kind: 'connection', facts: [] });
    expect(await thing()).not.toHaveProperty('usedAt');
    // A call the service answers with an error isn't one that worked.
    const missing = await callHa(mine.agentId, { method: 'GET', path: '/api/nothing-here' });
    expect(missing.result).toMatchObject({ kind: 'ok', output: { isError: true } });
    expect(await thing()).not.toHaveProperty('usedAt');
    const read = await callHa(mine.agentId, { method: 'GET', path: '/api/' });
    expect(read.result).toMatchObject({ kind: 'ok', output: { isError: false } });
    const [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, ha));
    expect(row?.lastWorkedAt).toBeInstanceOf(Date);
    expect(await thing()).toMatchObject({ facts: [], usedAt: row?.lastWorkedAt?.toISOString() });
  });
});

describe('widgets', () => {
  it('the agent pins a read-only tool for its turn’s person; the server reads its numbers without the model', async () => {
    const forMara = { onBehalfOf: { principalId: IDS.mara } };
    const res = await t.commit(
      mine.agentId,
      pinWidget,
      {
        title: 'Heat pump',
        subtitle: 'Daikin Altherma',
        source: {
          kind: 'connection_tool',
          connectionId: ha,
          tool: 'request',
          args: { method: 'GET', path: '/api/states/sensor.heat_pump' },
          values: [
            { key: 'flow', label: 'Water to radiators', unit: '°C', path: '/attributes/flow' },
            { key: 'outside', label: 'Outside', unit: '°C', path: '/attributes/outside' },
          ],
        },
        refreshSec: 60,
      },
      forMara,
    );
    if (res.status !== 'ok') throw new Error(res.status);
    await t.services.background.settle();
    pump.flow = 35;
    expect(await refreshWidget(t.services, res.result.widgetId)).toBe(true);
    const points = await t.services.db
      .select()
      .from(widgetPoints)
      .where(eq(widgetPoints.widgetId, res.result.widgetId));
    expect(points.length).toBeGreaterThanOrEqual(1);
    const home = await homeOverview(t.services, await viewer(IDS.mara));
    const w = home.widgets.find((x) => x.id === res.result.widgetId);
    expect(w).toMatchObject({
      title: 'Heat pump',
      series: [
        { key: 'flow', label: 'Water to radiators', unit: '°C', color: 1 },
        { key: 'outside', label: 'Outside', unit: '°C', color: 2 },
      ],
      latest: [
        { key: 'flow', value: 35, unit: '°C' },
        { key: 'outside', value: 9, unit: '°C' },
      ],
      refreshSec: 60,
    });
    // A write can't feed a widget.
    await expect(
      t.commit(
        mine.agentId,
        pinWidget,
        {
          title: 'Nope',
          source: {
            kind: 'connection_tool',
            connectionId: ha,
            tool: 'request',
            args: { method: 'POST', path: '/api/services/light/turn_on' },
            values: [{ key: 'x', label: 'X', path: '/x' }],
          },
        },
        forMara,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // An outsiders' turn has no Home to pin onto (one-person.md OP-17).
    await expect(
      runInDispatchScope({ dispatchId: null, agentId: mine.agentId, onBehalfOfAccountId: null }, () =>
        t.commit(mine.agentId, pinWidget, {
          title: 'Nope',
          source: {
            kind: 'connection_tool',
            connectionId: ha,
            tool: 'request',
            args: { method: 'GET', path: '/api/' },
            values: [{ key: 'x', label: 'X', path: '/x' }],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('REST', () => {
  it('answers Home, Watch, the widgets and the changes in the contract’s shapes', async () => {
    const get = (url: string) =>
      t.api.inject({ method: 'GET', url: `/api/v1/burrows/burrow-hq${url}`, headers: { cookie } });
    const home = await get('/home');
    expect(home.statusCode, home.body).toBe(200);
    expect(HomeOverview.safeParse(home.json()).success).toBe(true);
    const watch = await get('/watch?state=all');
    expect(watch.statusCode, watch.body).toBe(200);
    expect(WatchListResponse.safeParse(watch.json()).success).toBe(true);
    const list = await get('/widgets');
    expect(WidgetsResponse.parse(list.json()).widgets).toHaveLength(1);
    const id = list.json().widgets[0].id as string;
    const moved = await t.api.inject({
      method: 'POST',
      url: `/api/v1/burrows/burrow-hq/widgets/${id}/move`,
      headers: { cookie },
      payload: { position: 0 },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const changes = await get('/changes?limit=5');
    expect(changes.statusCode, changes.body).toBe(200);
    const removed = await t.api.inject({
      method: 'DELETE',
      url: `/api/v1/burrows/burrow-hq/widgets/${id}`,
      headers: { cookie },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().widgets).toEqual([]);
    expect(await t.services.db.select().from(widgets)).toEqual([]);
    const snooze = await t.api.inject({
      method: 'POST',
      url: '/api/v1/burrows/burrow-hq/needs-you/snooze',
      headers: { cookie },
      payload: { ref: { kind: 'alert', id: 'a1' }, until: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(snooze.statusCode, snooze.body).toBe(200);
    const ignore = await t.api.inject({
      method: 'POST',
      url: '/api/v1/burrows/burrow-hq/needs-you/ignore',
      headers: { cookie },
      payload: { ref: { kind: 'alert', id: 'a1' } },
    });
    expect(ignore.statusCode, ignore.body).toBe(200);
    expect(ignore.json()).toEqual({ ref: { kind: 'alert', id: 'a1' }, ignored: true });
  });
});

describe('Chats with the agent (home-redesign.md HR-40…HR-43)', () => {
  let pebble: PersonalSetup;
  const chat = { zonneplan: '', stats: '', devices: '' };
  const own = (id: string) => Object.values(chat).includes(id) || id === pebble.dmId;
  /** Mara's Home with only the chats this part makes (her others come from earlier parts). */
  const tomsHome = async () => {
    const home = await homeOverview(t.services, await viewer(IDS.mara));
    return { ...home, chats: home.chats.filter((c) => own(c.conversationId)) };
  };
  const states = async () => (await tomsHome()).chats.map((c) => [c.conversationId, c.state]);

  beforeAll(async () => {
    // Mara's Chat with the agent.
    pebble = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: null });
    const now = t.services.clock().getTime();
    const started: [keyof typeof chat, string, number][] = [
      ['zonneplan', 'Remove the old Zonneplan entities', 30],
      ['stats', 'Repair the statistics warning', 20],
      ['devices', 'Which devices aren’t answering?', 10],
    ];
    for (const [key, text, minutesAgo] of started) {
      // Task chats from before Chat: Home still lists the ones not archived.
      chat[key] = await taskChatWith(t.services, t.burrowId, pebble.agentId, IDS.mara, text);
      await t.services.db
        .update(conversations)
        .set({ lastMessageAt: new Date(now - minutesAgo * 60_000) })
        .where(eq(conversations.id, chat[key]));
    }
    await t.services.db
      .update(conversations)
      .set({ lastMessageAt: new Date(now - 60 * 60_000) })
      .where(eq(conversations.id, pebble.dmId));
  });

  it('lists the person’s chats newest first, the default chat among them', async () => {
    const home = await tomsHome();
    expect(home.chats.map((c) => [c.conversationId, c.state])).toEqual([
      [chat.devices, 'recent'],
      [chat.stats, 'recent'],
      [chat.zonneplan, 'recent'],
      [pebble.dmId, 'recent'],
    ]);
    expect(home.chats[0]).toMatchObject({ title: 'Which devices aren’t answering?' });
    expect(home.chats[0]).not.toHaveProperty('default');
    expect(home.chats[3]).toMatchObject({ title: 'Dusty', default: true });
  });

  it('a plan makes its chat working, with its progress and step, and tells the person', async () => {
    const heard = homeChanged(IDS.mara);
    try {
      const made = await t.commit(IDS.mara, createPlan, {
        conversationId: chat.zonneplan,
        title: 'Removing old Zonneplan entities',
        steps: [
          { title: 'Find them' },
          { title: 'Remove the entities' },
          { title: 'Restart Home Assistant' },
        ],
      });
      if (made.status !== 'ok') throw new Error(made.status);
      expect(heard.parts).toContainEqual(['working']);
      const [plan] = await t.services.db.select().from(plans).where(eq(plans.id, made.result.planId));
      const first = plan?.steps[0]?.id ?? '';
      heard.parts.length = 0;
      await t.commit(IDS.mara, updatePlanStep, { planId: made.result.planId, stepId: first, state: 'done' });
      expect(heard.parts).toContainEqual(['working']);
    } finally {
      heard.stop();
    }
    const home = await tomsHome();
    expect(home.chats[0]).toMatchObject({
      conversationId: chat.zonneplan,
      state: 'working',
      progress: { done: 1, total: 3 },
      step: 'Remove the entities',
    });
    expect((await workingTask(t.services, await viewer(IDS.mara)))?.conversationId).toBe(chat.zonneplan);
    expect(home.chats.slice(1).map((c) => c.state)).toEqual(['recent', 'recent', 'recent']);
  });

  it('a turn underway puts its chat first, and its start and end tell the person', async () => {
    const id = newId('dispatch');
    const heard = homeChanged(IDS.mara);
    try {
      await t.services.db.insert(dispatches).values({
        id,
        burrowId: t.burrowId,
        agentId: pebble.agentId,
        trigger: 'dm',
        conversationId: chat.devices,
        state: 'running',
        createdAt: t.services.clock(),
        claimedAt: t.services.clock(),
      });
      // What the runtime commits once it claimed the turn (agent-status.md AS-03), for the turn's person.
      const forTom = { onBehalfOf: { principalId: IDS.mara } };
      await t.commit(pebble.agentId, settleAgentStatus, {}, forTom);
      expect(heard.parts).toContainEqual(['working']);
      expect(await states()).toEqual([
        [chat.devices, 'working'],
        [chat.zonneplan, 'working'],
        [chat.stats, 'recent'],
        [pebble.dmId, 'recent'],
      ]);
      const home = await tomsHome();
      // No plan in that chat: working, without progress.
      expect(home.chats[0]).not.toHaveProperty('progress');
      heard.parts.length = 0;
      await t.services.db
        .update(dispatches)
        .set({ state: 'done', finishedAt: t.services.clock() })
        .where(eq(dispatches.id, id));
      await t.commit(pebble.agentId, settleAgentStatus, {}, forTom);
      expect(heard.parts).toContainEqual(['working']);
    } finally {
      heard.stop();
    }
    expect((await states())[0]).toEqual([chat.zonneplan, 'working']);
    expect((await states()).slice(1)).toContainEqual([chat.devices, 'recent']);
  });

  it('a question or an approval for the person makes its chat wait, until they snooze or answer it', async () => {
    await t.commit(pebble.agentId, sendMessage, {
      conversationId: chat.stats,
      text: 'Shall I repair it now?',
      asks: true,
    });
    expect(await states()).toEqual([
      [chat.zonneplan, 'working'],
      [chat.stats, 'waiting'],
      [chat.devices, 'recent'],
      [pebble.dmId, 'recent'],
    ]);
    // A change to a shared connection asks Tom; its card lands in the chat it was asked in (chat-asks.md CA-01).
    await setConnectionKeys(t.services, pebble.agentId, { read: 'can', write: 'ask' });
    const heard = homeChanged(IDS.mara);
    let number = 0;
    try {
      const restart = await callHa(
        pebble.agentId,
        { method: 'POST', path: '/api/services/homeassistant/restart' },
        chat.stats,
      );
      if (restart.asked.status !== 'pending_approval') throw new Error(restart.asked.status);
      number = restart.asked.approvalNumber;
      expect(heard.parts).toContainEqual(['needsYou', 'working']);
    } finally {
      heard.stop();
    }
    const [approval] = await t.services.db.select().from(approvals).where(eq(approvals.number, number));
    const waits = (await tomsHome()).chats.filter((c) => c.state === 'waiting');
    expect(approval?.conversationId).toBe(chat.stats);
    expect(waits.map((c) => c.conversationId)).toEqual([chat.stats]);
    // “Not now”: the approval leaves Needs you, and its chat no longer waits.
    const until = new Date(t.services.clock().getTime() + 3600_000).toISOString();
    await t.commit(IDS.mara, snoozeNeedsYou, { ref: { kind: 'approval', id: String(number) }, until });
    // Tom answers the question.
    await t.commit(IDS.mara, sendMessage, { conversationId: chat.stats, text: 'Yes please' });
    expect((await tomsHome()).chats.filter((c) => c.state === 'waiting')).toEqual([]);
  });

  it('answers in the REST overview, leaving out archived chats', async () => {
    const tom = (await sessionFor(t.services, IDS.mara)).cookie;
    await t.services.db
      .update(conversations)
      .set({ chatArchivedAt: t.services.clock() })
      .where(eq(conversations.id, chat.devices));
    const res = await t.api.inject({
      method: 'GET',
      url: '/api/v1/burrows/burrow-hq/home',
      headers: { cookie: tom },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(HomeOverview.safeParse(res.json()).success).toBe(true);
    const ids = (res.json().chats as { conversationId: string }[]).map((c) => c.conversationId);
    expect(ids).toContain(chat.zonneplan);
    expect(ids).not.toContain(chat.devices);
  });
});

describe('This Whombat isn’t backed up (first-day.md)', () => {
  /** The backup service as the runtime reaches it: no destination until one is set. */
  const service = {
    destination: null as string | null,
    puts: [] as Record<string, unknown>[],
    doc() {
      return {
        kind: 'whombat.backup-status/1',
        state: this.destination ? 'pending' : 'unprotected',
        protected: false,
        destination: this.destination
          ? { configured: true, kind: 'sftp', display: this.destination }
          : { configured: false },
        lastSuccess: null,
        lastFailure: null,
        lastAttemptOk: null,
        coverage: [],
        recoverability: { lastDrill: null },
        kitGeneration: 0,
        running: null,
        updatedAt: t.services.clock().toISOString(),
      };
    },
  };
  const port = {
    call: async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/v1/status') return { status: 200, body: service.doc() };
      if (method === 'GET' && path === '/v1/ssh-public-key')
        return {
          status: 200,
          body: { publicKey: 'ssh-ed25519 AAAAC3Nza whombat-backup@dev_1', fingerprint: 'SHA256:abc' },
        };
      if (method === 'PUT' && path === '/v1/destination') {
        service.puts.push(body as Record<string, unknown>);
        service.destination = 'nas-01.lan';
        return {
          status: 200,
          body: { repositoryId: 'repo1', appendOnly: 'unknown', generation: 1, kind: 'sftp' },
        };
      }
      return { status: 404, body: null };
    },
  };
  const item = async () =>
    (await homeOverview(t.services, await viewer(IDS.mara))).needsYouList?.find((i) => i.kind === 'backup');

  beforeAll(() => {
    // The manager hasn't reported: the backup service's own answer counts.
    useBoxBackup(t.services, { port, status: () => null });
    registerBoxBackupSource();
  });

  it('comes back as one Needs you item with the assistant’s proposal, not in an older app’s list', async () => {
    const home = await homeOverview(t.services, await viewer(IDS.mara));
    const proposal = home.needsYouList?.filter((i) => i.kind === 'backup') ?? [];
    expect(proposal).toHaveLength(1);
    expect(proposal[0]).toMatchObject({
      ref: { kind: 'backup', id: 'this-whombat' },
      group: 'you',
      // Nothing added, nothing found: a USB disk.
      title: expect.stringContaining('USB disk'),
    });
    expect(proposal[0]?.actions.map((a) => a.kind)).toEqual(['ask', 'open']);
    expect(home.needsYou.some((i) => i.kind === 'backup')).toBe(false);
    // Ignore takes it to the foot.
    const ref = proposal[0]?.ref as { kind: string; id: string };
    expect((await t.commit(IDS.mara, ignoreNeedsYou, { ref, ignored: true })).status).toBe('ok');
    expect((await item())?.group).toBe('quiet');
    expect((await t.commit(IDS.mara, ignoreNeedsYou, { ref, ignored: false })).status).toBe('ok');
    expect((await item())?.group).toBe('you');
  });

  it('goes once the assistant sets where backups go on the person’s yes; it never moves them', async () => {
    const account = await accountOf(t.services, IDS.mara);
    const turn = await agentTokenFor(t.services, t.burrowId, mine.agentId, mine.dmId, {
      onBehalfOfAccountId: account,
    });
    const call = async (args: Record<string, unknown>) => {
      const mcp = await mcpClient(t.baseUrl, turn.token);
      try {
        return (await mcp.client.callTool({ name: 'whombat_backup', arguments: args }))
          .structuredContent as Record<string, unknown>;
      } finally {
        await mcp.close();
      }
    };
    expect(await call({})).toMatchObject({
      status: 'ok',
      state: 'unprotected',
      publicKey: expect.stringContaining('whombat-backup@'),
    });
    expect(
      await call({ set: 'sftp', host: 'nas-01.lan', user: 'whombat', path: '/srv/whombat-backup' }),
    ).toMatchObject({ status: 'set', kind: 'sftp', destination: 'nas-01.lan' });
    expect(service.puts).toEqual([
      { repository: 'sftp:nas-01.lan:/srv/whombat-backup', allowInit: true, sftpUser: 'whombat' },
    ]);
    // Signed for the box: the person's account, the assistant beside it.
    const [event] = await t.services.db
      .select()
      .from(applianceEvents)
      .where(eq(applianceEvents.type, 'backup.destination_set'));
    expect(event?.payload).toMatchObject({ kind: 'sftp', host: 'nas-01.lan', agentId: mine.agentId });
    expect(await item()).toBeUndefined();
    // Somewhere already: moving it is the person's.
    expect(await call({ set: 'disk' })).toMatchObject({ status: 'failed', reason: 'already_set' });
    expect(service.puts).toHaveLength(1);
  });
});
