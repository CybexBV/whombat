/** The one-Whombat demo world (one-whombat-mobile.md AP-1377): its answers match the contracts, its writes change it. */
import { homeStatusLine, homeThingRows, statusText } from '@whombat/client';
import {
  AGENT_NAME_FORM_TEXT,
  AGENT_NAME_RESERVED_TEXT,
  type AnyEndpoint,
  api,
  type RealtimeEvent,
} from '@whombat/core';
import { at, BURROW_ID, mara } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN } from '../data/config';
import { demoClient } from '../demo/session';
import { createClock } from '../lib/time';
import {
  ASSISTANT_ID,
  DEFAULT_CHAT_ID,
  HEAT_CHAT_ID,
  HEAT_PROPOSAL,
  PVE_CHAT_ID,
  RESTART_APPROVAL,
} from './assistant';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';

function setup() {
  const timers: { fn: () => void; ms: number }[] = [];
  const now = createClock(new Date(at('14:05')), Date.now());
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    assistant: true,
    // The task chats of before Chat (chatChannel.test.ts has Chat's world).
    chat: false,
  });
  const client = demoClient(server.fetch);
  const events: { topic: string; event: RealtimeEvent }[] = [];
  server.realtime.onEvent((event, frame) => events.push({ topic: frame.topic, event }));
  server.realtime.connect();
  const flush = () => {
    for (const t of timers.splice(0)) t.fn();
  };
  return { server, client, timers, events, flush };
}

/** The raw answer, parsed with the endpoint's own response schema (strictly: what a newer app would choke on). */
async function raw(
  s: ReturnType<typeof setup>,
  ep: AnyEndpoint,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; data: unknown }> {
  const res = await s.server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}${path}`, init);
  const data = (await res.json()) as unknown;
  const parsed = ep.response.safeParse(data);
  if (!parsed.success) throw new Error(`${ep.id}: ${parsed.error.message}`);
  return { status: res.status, data };
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('the one-Whombat demo world', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('answers every read with the contracts’ shapes', async () => {
    await raw(s, api.home.overview, '/home');
    await raw(s, api.watch.list, '/watch?state=all');
    await raw(s, api.chats.list, '/chats');
    await raw(s, api.chats.list, '/chats?subjectKind=server&subjectId=pve-02');
    await raw(s, api.hosts.status, '/hosts/status');
    await raw(s, api.hosts.fleet, '/hosts/fleet');
    for (const id of ['thetitan', 'pve-01', 'pve-02', 'blackbox', 'the-falcon'])
      await raw(s, api.hosts.getServer, `/hosts/servers/${id}`);
    await raw(s, api.hosts.listGuests, '/hosts/guests?server=pve-02');
    // A guest's screen (AP-1501).
    await raw(s, api.hosts.getGuest, '/hosts/servers/pve-02/guests/pve%3A118');
    await raw(s, api.hosts.guestMetrics, '/hosts/servers/pve-02/guests/pve%3A118/metrics?range=24h');
    for (const op of ['config.get', 'snapshot.list', 'backup.list', 'task.list'])
      await raw(
        s,
        api.hosts.manageRead,
        `/hosts/servers/pve-02/manage?op=${op}&guestId=pve%3A118&platform=pve`,
      );
    for (const op of ['choices', 'backup.list', 'backupjob.list'])
      await raw(s, api.hosts.manageRead, `/hosts/servers/pve-02/manage?op=${op}&platform=pve`);
    await raw(s, api.conversations.get, `/conversations/${HEAT_CHAT_ID}`);
    await raw(s, api.messages.list, `/conversations/${HEAT_CHAT_ID}/messages?limit=50`);
    await raw(s, api.approvals.get, `/approvals/${RESTART_APPROVAL}`);
    await raw(s, api.conversations.bootstrap, '/bootstrap');
    await raw(s, api.agent.get, '/agent');
    for (const id of ['con_ha', 'con_unifi', 'con_hetzner', 'con_mail'])
      await raw(s, api.connections.tools, `/connections/${id}/tools`);
    // Everything I did (AP-2266).
    await raw(s, api.changes.list, '/changes?limit=20');
  });

  it('has Done recently with Undo and Review, a pinned panel, and Undo that takes a change back (AP-2266)', async () => {
    const home = await s.client.request(api.home.overview, { params: { burrow } });
    if (home.status !== 'ok') throw new Error(home.status);
    expect(home.data.widgets.map((w) => w.title)).toEqual(['Power use']);
    const [first] = home.data.doneRecently;
    expect(first).toMatchObject({ id: 'chg_home-nest-memory', undo: { state: 'available' } });
    expect(first?.link).toBe(`/chats/${PVE_CHAT_ID}`);
    const undone = await raw(s, api.changes.undo, `/changes/${first?.id}/undo`, post({}));
    expect(undone.data).toMatchObject({ state: 'undone', change: { undo: { state: 'undone' } } });
    expect(s.events.map((e) => e.event.type)).toContain('home.changed');
    const all = await s.client.request(api.changes.list, { params: { burrow }, query: { limit: 2 } });
    if (all.status !== 'ok') throw new Error(all.status);
    expect(all.data.changes).toHaveLength(2);
    expect(all.data.changes[0]?.undo.state).toBe('undone');
    expect(all.data.before).toBe(all.data.changes[1]?.id);
    // A change Neo reported: Undo asks Neo to put it back, and a second press soon after is refused (HR-03).
    const reported = home.data.doneRecently[1];
    const asked = await raw(s, api.changes.undo, `/changes/${reported?.id}/undo`, post({}));
    expect(asked.data).toMatchObject({ state: 'requested', conversationId: DEFAULT_CHAT_ID });
    const again = await s.server.fetch(
      `${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}/changes/${reported?.id}/undo`,
      post({}),
    );
    expect(again.status).toBe(409);
  });

  it('is mock 4’s Home: three things need you, the servers, Home Assistant and Network', async () => {
    const home = await s.client.request(api.home.overview, { params: { burrow } });
    if (home.status !== 'ok') throw new Error(home.status);
    // The worst first (status-line.md): the failed array is named, the other two counted.
    const line = homeStatusLine(home.data);
    expect(line.flatMap((p) => (p.strong ? [p.text] : []))).toEqual(['blackbox’s disk array failed.']);
    expect(statusText(line)).toContain('2 other things need you');
    expect(home.data.needsYou.map((i) => i.title)).toEqual([
      'blackbox’s disk array failed',
      'Restart arnica-prod-nest-01?',
      'Heat pump: what may I change?',
    ]);
    // Tonight at 03:00 is the next 03:00 after 14:05.
    expect(home.data.needsYou[1]?.actions[1]).toMatchObject({ kind: 'approve_later', at: at('03:00', 1) });
    // Your things (AP-2264): the connections with figures first, then the rest; servers have their own card.
    const things = homeThingRows(home.data.things, Date.parse(at('14:05')), 'Europe/Amsterdam');
    expect(things.map((r) => [r.name, r.figures[0]?.value ?? null, r.used])).toEqual([
      ['Home Assistant', '169', null],
      ['UniFi', expect.any(String), null],
      ['Heat pump', null, null],
      ['Hetzner', null, 'yesterday'],
      ['Mail', null, 'today'],
    ]);
    expect(things.map((r) => r.line).slice(2)).toEqual([
      expect.any(String),
      'Connected · used yesterday',
      'Connected · used today',
    ]);
  });

  it('has one agent, Neo with Neo’s face, and Mara’s Chat as her room (OA-01, OA-04)', async () => {
    const b = await s.client.request(api.conversations.bootstrap, { params: { burrow } });
    if (b.status !== 'ok') throw new Error(b.status);
    expect(b.data.burrow.name).toBe('Lumio');
    const agents = b.data.principals.filter((p) => p.kind === 'agent');
    expect(agents.map((p) => [p.id, p.name, p.kind === 'agent' ? p.face : null])).toEqual([
      [ASSISTANT_ID, 'Neo', 'neo'],
    ]);
    // Without Chat's threaded rooms (`chat: false`) her Chat is the one room; chatChannel.test.ts has Feedback too.
    expect(b.data.sidebar.dms.map((d) => [d.id, d.link])).toEqual([[DEFAULT_CHAT_ID, { type: 'dm' }]]);
  });

  it('renames Neo with the server’s checks, gives it another face, and its chat follows (AP-1551)', async () => {
    await s.client.request(api.conversations.bootstrap, { params: { burrow } });
    const patch = (body: unknown): RequestInit => ({ ...post(body), method: 'PATCH' });
    const refusal = async (body: unknown) => {
      const res = await s.server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}/agent`, patch(body));
      expect(res.status).toBe(422);
      return ((await res.json()) as { error: { fields: { name: string[] } } }).error.fields.name[0];
    };
    expect(await refusal({ name: 'Whombat' })).toBe(AGENT_NAME_RESERVED_TEXT);
    expect(await refusal({ name: 'rex the dog' })).toBe(AGENT_NAME_FORM_TEXT);
    // No other agent holds a name (OA-08): a person's first name is fine.
    const renamed = await raw(s, api.agent.update, '/agent', patch({ name: 'Joris' }));
    expect((renamed.data as { agent: { name: string; face: string } }).agent).toMatchObject({
      name: 'Joris',
      face: 'neo',
    });
    const faced = await raw(s, api.agent.update, '/agent', patch({ name: 'Banjo' }));
    expect((faced.data as { agent: { name: string } }).agent.name).toBe('Banjo');
    const looked = await raw(s, api.agent.update, '/agent', patch({ face: 'skipper' }));
    expect((looked.data as { agent: { name: string; face: string } }).agent).toMatchObject({
      name: 'Banjo',
      face: 'skipper',
    });
    expect(s.events.map((e) => [e.topic, e.event.type])).toContainEqual([
      `burrow:${BURROW_ID}`,
      'agent.updated',
    ]);
    const b = await s.client.request(api.conversations.bootstrap, { params: { burrow } });
    if (b.status !== 'ok') throw new Error(b.status);
    expect(b.data.principals.find((p) => p.id === ASSISTANT_ID)).toMatchObject({
      name: 'Banjo',
      face: 'skipper',
    });
    const list = await s.client.request(api.chats.list, { params: { burrow } });
    if (list.status !== 'ok') throw new Error(list.status);
    expect(list.data.chats.find((c) => c.default)?.title).toBe('Banjo');
  });

  it('approves for tonight: the item leaves Home and Home is told', async () => {
    const result = await raw(
      s,
      api.approvals.decide,
      `/approvals/${RESTART_APPROVAL}/decide`,
      post({ decision: 'approve', executeAt: at('03:00', 1) }),
    );
    expect((result.data as { approval: { executeAt: string } }).approval.executeAt).toBe(at('03:00', 1));
    const home = await s.client.request(api.home.overview, { params: { burrow } });
    if (home.status !== 'ok') throw new Error(home.status);
    expect(home.data.needsYou.map((i) => i.kind)).toEqual(['alert', 'device_skill']);
    expect(s.events.map((e) => [e.topic, e.event.type])).toContainEqual([`me:${mara.id}`, 'home.changed']);
  });

  it('snoozes until tomorrow, and acknowledges and watches an alert again', async () => {
    await raw(
      s,
      api.needsYou.snooze,
      '/needs-you/snooze',
      post({ ref: { kind: 'alert', id: 'al_blackbox_md0' }, until: at('09:00', 1) }),
    );
    const home = await s.client.request(api.home.overview, { params: { burrow } });
    if (home.status !== 'ok') throw new Error(home.status);
    expect(home.data.needsYou).toHaveLength(2);

    const before = await s.client.request(api.watch.list, { params: { burrow }, query: { state: 'all' } });
    if (before.status !== 'ok') throw new Error(before.status);
    const open = (items: { state: string; severity: string }[]) =>
      items.filter((i) => i.state === 'open' && i.severity !== 'info').length;
    expect(open(before.data.items)).toBe(3);
    await raw(s, api.hosts.ackAlert, '/hosts/alerts/al_pve02_temp/ack', post({ minutes: 60 }));
    const after = await s.client.request(api.watch.list, { params: { burrow }, query: { state: 'all' } });
    if (after.status !== 'ok') throw new Error(after.status);
    const warm = after.data.items.find((i) => i.ref.id === 'al_pve02_temp');
    expect(warm?.state).toBe('snoozed');
    expect(open(after.data.items)).toBe(2);
    await raw(s, api.hosts.unackAlert, '/hosts/alerts/al_pve02_temp/ack', { method: 'DELETE' });
    const again = await s.client.request(api.watch.list, { params: { burrow }, query: { state: 'open' } });
    if (again.status !== 'ok') throw new Error(again.status);
    expect(again.data.items.some((i) => i.ref.id === 'al_pve02_temp')).toBe(true);
  });

  it('gives Neo the agent’s default keys and saves new ones with a Keys event each (OA-05, AP-1555)', async () => {
    const put = (body: unknown): RequestInit => ({ ...post(body), method: 'PUT' });
    const profile = await raw(s, api.agent.get, '/agent');
    const held = (profile.data as { grants: { keyId: string; tier: string }[] }).grants;
    expect(held.find((g) => g.keyId === 'merge.main')?.tier).toBe('ask');
    expect(held.find((g) => g.keyId === 'mail.read')?.tier).toBe('can');
    const next = held.map((g) => (g.keyId === 'merge.main' ? { ...g, tier: 'can' } : g));
    const saved = await raw(s, api.agent.setKeys, '/agent/keys', put({ grants: next }));
    const data = saved.data as { grants: { keyId: string; tier: string }[]; events: { text: string }[] };
    expect(data.grants.find((g) => g.keyId === 'merge.main')?.tier).toBe('can');
    expect(data.events).toHaveLength(1);
  });

  it('starts a chat: it is listed, and Neo answers after thinking', async () => {
    const started = await raw(
      s,
      api.chats.start,
      '/chats',
      post({ text: 'Is pve-02 cool again?', subject: { kind: 'server', id: 'pve-02', name: 'pve-02' } }),
    );
    expect(started.status).toBe(201);
    const id = (started.data as { conversation: { id: string } }).conversation.id;
    const list = await s.client.request(api.chats.list, { params: { burrow } });
    if (list.status !== 'ok') throw new Error(list.status);
    expect(list.data.chats[0]).toMatchObject({ id, title: 'Is pve-02 cool again?', default: false });
    expect(s.events.map((e) => e.event.type)).toEqual(['typing']);
    s.flush();
    const reply = s.events.at(-1)?.event;
    expect(reply?.type).toBe('message.created');
    if (reply?.type === 'message.created') expect(reply.message.authorId).toBe(ASSISTANT_ID);
    const messages = await s.client.request(api.messages.list, {
      params: { burrow, conversationId: id },
      query: { limit: 50 },
    });
    if (messages.status !== 'ok') throw new Error(messages.status);
    expect(messages.data.messages).toHaveLength(2);
  });

  it('renames and archives a task chat, never the default one', async () => {
    await raw(s, api.chats.rename, `/chats/${PVE_CHAT_ID}`, {
      ...post({ title: 'pve-02 heat' }),
      method: 'PATCH',
    });
    await raw(s, api.chats.archive, `/chats/${PVE_CHAT_ID}/archive`, post({}));
    const list = await s.client.request(api.chats.list, { params: { burrow } });
    if (list.status !== 'ok') throw new Error(list.status);
    expect(list.data.chats.some((c) => c.id === PVE_CHAT_ID)).toBe(false);
    const archived = await s.client.request(api.chats.list, {
      params: { burrow },
      query: { archived: 'true' },
    });
    if (archived.status !== 'ok') throw new Error(archived.status);
    expect(archived.data.chats.map((c) => c.title)).toEqual(['pve-02 heat']);
    const res = await s.server.fetch(
      `${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}/chats/${DEFAULT_CHAT_ID}/archive`,
      post({}),
    );
    expect(res.status).toBe(404);
  });

  it('switches the heat pump on: the card changes on its message, it leaves Needs you and reads', async () => {
    const decided = await raw(
      s,
      api.deviceSkills.decide,
      `/device-skills/${HEAT_PROPOSAL}/decide`,
      post({ actions: { room_setpoint: { tier: 'can', limits: { min: 16, max: 24 } } }, switchOn: true }),
    );
    expect((decided.data as { card: { status: string } }).card.status).toBe('on');
    expect(s.events.map((e) => e.event.type)).toEqual(['message.updated', 'home.changed']);
    const home = await s.client.request(api.home.overview, { params: { burrow } });
    if (home.status !== 'ok') throw new Error(home.status);
    expect(home.data.needsYou.some((i) => i.kind === 'device_skill')).toBe(false);
    expect(home.data.things.find((t) => t.kind === 'device')).toMatchObject({ status: 'ok' });
  });

  it('shuts a guest down: accepted at once, stopped a moment later with a hosts event', async () => {
    const accepted = await raw(
      s,
      api.hosts.guestAction,
      '/hosts/servers/pve-02/guests/pve:118/actions',
      post({ action: 'shutdown', confirm: true }),
    );
    expect(accepted.status).toBe(202);
    s.flush();
    expect(s.events.slice(-2).map((e) => e.event)).toEqual([
      { type: 'hosts.guest', serverId: 'pve-02', guestId: 'pve:118', state: 'stopped' },
      {
        type: 'hosts.task',
        serverId: 'pve-02',
        guestId: 'pve:118',
        actionId: 'act_118_shutdown',
        op: 'shutdown',
        result: 'ok',
      },
    ]);
    const guests = await s.client.request(api.hosts.listGuests, {
      params: { burrow },
      query: { server: 'pve-02' },
    });
    if (guests.status !== 'ok') throw new Error(guests.status);
    expect(guests.data.guests.find((g) => g.id === 'pve:118')?.state).toBe('stopped');
  });

  it('changes a guest’s settings with the digest, and ends a backup as a task (AP-1501)', async () => {
    const path = '/hosts/servers/pve-02/manage';
    const read = await raw(s, api.hosts.manageRead, `${path}?op=config.get&guestId=pve%3A118&platform=pve`);
    const cfg = (read.data as { config: { digest: string; values: Record<string, string> } }).config;
    const stale = await s.server.fetch(
      `${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}${path}`,
      post({ op: 'config.set', guestId: 'pve:118', params: { set: { cores: '6' } }, digest: 'old' }),
    );
    expect(stale.status).toBe(409);
    const saved = await raw(
      s,
      api.hosts.manage,
      path,
      post({ op: 'config.set', guestId: 'pve:118', params: { set: { cores: '6' } }, digest: cfg.digest }),
    );
    expect(saved.data).toMatchObject({ ok: true, changes: [{ key: 'cores', new: '6', pending: true }] });
    const backup = await raw(
      s,
      api.hosts.manage,
      path,
      post({
        op: 'backup.create',
        guestId: 'pve:118',
        params: { storage: 'PBS-BlackBox', mode: 'snapshot' },
      }),
    );
    const taskId = (backup.data as { task: { id: string } }).task.id;
    const running = await raw(
      s,
      api.hosts.getTask,
      `/hosts/servers/pve-02/tasks/${encodeURIComponent(taskId)}`,
    );
    expect(running.data).toMatchObject({ status: 'running' });
    s.flush();
    expect(s.events.at(-1)?.event).toEqual({
      type: 'hosts.task',
      serverId: 'pve-02',
      guestId: 'pve:118',
      taskId,
      op: 'backup.create',
      result: 'ok',
    });
  });

  it('has thetitan as an Incus host holding this Whombat and blackbox as an Unraid server (AP-1640)', async () => {
    const beast = await raw(s, api.hosts.getServer, '/hosts/servers/thetitan');
    expect(beast.data).toMatchObject({
      server: { platform: 'incus', hostsThisWhombat: true },
      incus: { version: '6.0.4' },
    });
    const box = await raw(s, api.hosts.getServer, '/hosts/servers/blackbox');
    expect(box.data).toMatchObject({
      server: { platform: 'unraid' },
      unraid: { version: '7.3.1', array: { state: 'started', disabled: 1 } },
    });
    const self = await raw(s, api.hosts.getGuest, '/hosts/servers/thetitan/guests/incus%3Awhombat-dev-box');
    expect(self.data).toMatchObject({ self: true, manageable: true, platform: 'incus' });
    const plex = await raw(s, api.hosts.getGuest, '/hosts/servers/blackbox/guests/docker%3Aplex');
    expect(plex.data).toMatchObject({ updateAvailable: true, template: true, autostart: true });
    const path = '/hosts/servers/thetitan/manage';
    for (const op of ['config.get', 'snapshot.list', 'backup.list', 'task.list'])
      await raw(s, api.hosts.manageRead, `${path}?op=${op}&guestId=incus%3Awhombat-prod-box&platform=incus`);
    await raw(s, api.hosts.manageRead, `${path}?op=choices&platform=incus`);
    // This Whombat itself is refused; another instance's settings go with the ETag.
    const refused = await s.server.fetch(
      `${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}${path}`,
      post({ op: 'config.set', guestId: 'incus:whombat-dev-box', params: { set: { 'limits.cpu': '2' } } }),
    );
    expect(refused.status).toBe(409);
    const saved = await raw(
      s,
      api.hosts.manage,
      path,
      post({
        op: 'config.set',
        guestId: 'incus:whombat-prod-box',
        params: { set: { 'limits.memory': '16GiB' } },
        digest: 'etag-whombat-prod-box-1',
      }),
    );
    expect(saved.data).toMatchObject({
      ok: true,
      changes: [{ key: 'limits.memory', old: '8GiB', new: '16GiB' }],
    });
    // A rename answers the new id at once; the task ends with its frame.
    const renamed = await raw(
      s,
      api.hosts.manage,
      path,
      post({ op: 'guest.rename', guestId: 'incus:rackoon', params: { name: 'rackoon-old' } }),
    );
    expect(renamed.data).toMatchObject({ newId: 'incus:rackoon-old' });
    s.flush();
    expect(s.events.at(-1)?.event).toMatchObject({ type: 'hosts.task', op: 'guest.rename', result: 'ok' });
    // Unraid: a container update runs as an unraid task, autostart is done at once.
    const box2 = '/hosts/servers/blackbox/manage';
    const update = await raw(
      s,
      api.hosts.manage,
      box2,
      post({ op: 'container.update', guestId: 'docker:plex', confirm: true }),
    );
    expect((update.data as { task: { id: string } }).task.id).toMatch(/^unraid:[0-9a-f]{16}$/);
    await raw(
      s,
      api.hosts.manage,
      box2,
      post({ op: 'guest.autostart', guestId: 'docker:plex', params: { on: false } }),
    );
    s.flush();
    const after = await raw(s, api.hosts.getGuest, '/hosts/servers/blackbox/guests/docker%3Aplex');
    expect(after.data).toMatchObject({ updateAvailable: false, autostart: false });
    await raw(s, api.hosts.manage, box2, post({ op: 'parity.start', params: { correct: false } }));
    const parity = await raw(s, api.hosts.getServer, '/hosts/servers/blackbox');
    expect(parity.data).toMatchObject({
      unraid: { array: { parity: { state: 'running', action: 'check' } } },
    });
  });

  it('has the-falcon as a QEMU/KVM host whose VMs change like Incus instances (AP-1646)', async () => {
    const dragon = await raw(s, api.hosts.getServer, '/hosts/servers/the-falcon');
    expect(dragon.data).toMatchObject({ server: { platform: 'libvirt' }, libvirt: { version: '12.2.0' } });
    const path = '/hosts/servers/the-falcon/manage';
    const g = 'libvirt%3Awin11-gaming';
    const vm = await raw(s, api.hosts.getGuest, `/hosts/servers/the-falcon/guests/${g}`);
    expect(vm.data).toMatchObject({ platform: 'libvirt', manageable: true });
    for (const op of ['config.get', 'snapshot.list', 'backup.list', 'task.list'])
      await raw(s, api.hosts.manageRead, `${path}?op=${op}&guestId=${g}&platform=libvirt`);
    const choices = await raw(s, api.hosts.manageRead, `${path}?op=choices&platform=libvirt`);
    expect((choices.data as { choices: { isos: unknown[] } }).choices.isos.length).toBe(4);
    // The CD/DVD changes while it runs; a clone waits until it is switched off.
    const saved = await raw(
      s,
      api.hosts.manage,
      path,
      post({
        op: 'config.set',
        guestId: 'libvirt:win11-gaming',
        platform: 'libvirt',
        params: { set: { cdrom0: 'source=empty,bus=sata' } },
        digest: 'sha-win11-gaming-1',
      }),
    );
    expect(saved.data).toMatchObject({
      ok: true,
      changes: [{ key: 'cdrom0', new: 'source=empty,bus=sata' }],
    });
    const clone = await s.server.fetch(
      `${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}${path}`,
      post({
        op: 'guest.clone',
        guestId: 'libvirt:win11-gaming',
        platform: 'libvirt',
        params: { name: 'w2' },
      }),
    );
    expect(clone.status).toBe(409);
    const backup = await raw(
      s,
      api.hosts.manage,
      path,
      post({ op: 'backup.create', guestId: 'libvirt:home-router', platform: 'libvirt', params: {} }),
    );
    expect((backup.data as { task: { id: string } }).task.id).toMatch(/^libvirt:[0-9a-f]{16}$/);
    s.flush();
    const after = await raw(s, api.hosts.getServer, '/hosts/servers/the-falcon');
    // Its libvirt hints (the system's, a restart after its updates, are the updates world's; AP-2886).
    const kinds = (after.data as { hints: { kind: string }[] }).hints.map((h) => h.kind);
    expect(kinds.filter((k) => k.startsWith('libvirt.'))).toEqual(['libvirt.pool_full']);
  });

  it('plays a server’s updates: waiting, installing, waiting for a restart (AP-2886)', async () => {
    const system = async (id: string) =>
      (
        (await raw(s, api.hosts.getServer, `/hosts/servers/${id}`)).data as {
          health: { system: Record<string, unknown> };
        }
      ).health.system;
    expect(await system('pve-02')).toMatchObject({ updates: 4, packageTask: null });
    expect(await system('thetitan')).toMatchObject({ packageTask: { op: 'install' } });
    expect(await system('the-falcon')).toMatchObject({
      rebootRequired: true,
      packageLast: { installed: 12 },
    });
    const list = await raw(s, api.hosts.inspect, '/hosts/servers/pve-02/inspect/updates');
    expect((list.data as { items: { name: string }[] }).items.map((i) => i.name)).toContain('openssl');
    const started = await raw(
      s,
      api.hosts.manage,
      '/hosts/servers/pve-02/manage',
      post({ op: 'packages.check', platform: 'host', params: {} }),
    );
    const id = (started.data as { task: { id: string } }).task.id;
    expect(id).toMatch(/^pkg:/);
    const task = await raw(
      s,
      api.hosts.getTask,
      `/hosts/servers/pve-02/tasks/${id}?platform=host&logStart=0`,
    );
    expect(task.data).toMatchObject({ status: 'running', cancellable: true });
    await raw(
      s,
      api.hosts.serverAction,
      '/hosts/servers/the-falcon/actions',
      post({ action: 'host_reboot', confirm: true }),
    );
    expect(await system('the-falcon')).toMatchObject({ rebootRequired: false });
  });

  it('is off unless asked for', async () => {
    const plain = createFixtureServer({
      inner: createFixtureFetch(),
      now: createClock(new Date(), Date.now()),
      assistant: false,
    });
    const res = await plain.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}/home`);
    expect(res.status).toBe(404);
  });
});
