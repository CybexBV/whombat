import { ApiError } from '@whombat/client';
import { api, type RealtimeEvent } from '@whombat/core';
import { bootstrap } from '@whombat/fixtures';
import { createFixtureFetch, type FixtureFetchOptions } from '@whombat/fixtures/fetch';
import { beforeEach, describe, expect, it } from 'vitest';
import { approvalScreen } from '../data/approval';
import { peopleFrom } from '../data/people';
import { serviceRows, showsServices } from '../data/services';
import { vaultAgentRows, vaultEntryScreen } from '../data/vault';
import { demoClient } from '../demo/session';
import { createClock } from '../lib/time';
import { minutesAfterSeed, worldContext } from '../test/world';
import { assistantAgent } from './assistant';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';

function setup(fetchOptions?: FixtureFetchOptions) {
  const timers: { fn: () => void; ms: number }[] = [];
  const now = createClock(minutesAfterSeed(0), Date.now());
  const server = createFixtureServer({
    inner: createFixtureFetch(fetchOptions),
    now,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  const client = demoClient(server.fetch);
  const events: RealtimeEvent[] = [];
  server.realtime.onEvent((e) => events.push(e));
  server.realtime.connect();
  return { server, client, timers, events };
}

describe('fixture server', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('approve → APPROVED · DEPLOYING with Undo; undo → pending again', async () => {
    const result = await s.client.approvals.decide({
      params: { burrow, number: 12 },
      body: { decision: 'approve' },
    });
    if (result.status !== 'ok') throw new Error(result.status);
    // Viewed a few seconds after deciding.
    const ctx = worldContext(minutesAfterSeed(0.1));
    const approved = approvalScreen(result.data.approval, ctx, '#billing-v2');
    expect(approved.label).toBe('APPROVED · DEPLOYING');
    expect(approved.tone).toBe('ok');
    expect(approved.conditions[2]).toMatchObject({ note: 'you · just now', met: true });
    expect(approved.message).toBe(
      'Dusty is rolling billing-api to staging. You’ll get a note here when it’s live, usually in about two minutes.',
    );
    expect(approved.footer).toEqual({ kind: 'undo', canUndo: true });
    expect(s.events.map((e) => e.type)).toEqual(['approval.updated']);

    const undone = await s.client.approvals.undo({ params: { burrow, number: 12 } });
    if (undone.status !== 'ok') throw new Error(undone.status);
    expect(approvalScreen(undone.data.approval, ctx).label).toBe('NEEDS A PERSON');
  });

  it('decline → DECLINED and the agent is told', async () => {
    const result = await s.client.approvals.decide({
      params: { burrow, number: 12 },
      body: { decision: 'decline' },
    });
    if (result.status !== 'ok') throw new Error(result.status);
    const model = approvalScreen(result.data.approval, worldContext());
    expect(model.label).toBe('DECLINED');
    expect(model.tone).toBe('bad');
    expect(model.message).toContain('Dusty');
    expect(model.message).not.toContain('Joris');
    expect(model.conditions[2]?.note).toBe('declined');
  });

  it('the agent in Mara’s Chat thinks, then its reply arrives live', async () => {
    const sent = await s.client.messages.send({
      params: { burrow, conversationId: 'cnv_dm-dusty' },
      body: { text: 'Can you check the VAT rounding too?', clientId: 'c-1' },
    });
    if (sent.status !== 'ok') throw new Error(sent.status);
    expect(s.events.map((e) => e.type)).toEqual(['typing']);
    expect(s.events[0]).toMatchObject({ type: 'typing', principalId: 'prn_dusty', active: true });
    expect(s.timers).toHaveLength(1);
    expect(s.timers[0]?.ms).toBe(1600);

    // Until the reply is "delivered", history does not show it.
    const before = await s.client.messages.list({ params: { burrow, conversationId: 'cnv_dm-dusty' } });
    expect(before.messages.at(-1)?.text).toBe('Can you check the VAT rounding too?');

    s.timers[0]?.fn();
    const created = s.events.at(-1);
    expect(created?.type).toBe('message.created');
    if (created?.type !== 'message.created') throw new Error('no reply');
    expect(created.message.authorId).toBe('prn_dusty');
    expect(created.message.text).toBe('On it. I’ll post back here when I have something worth reading.');
    const after = await s.client.messages.list({ params: { burrow, conversationId: 'cnv_dm-dusty' } });
    expect(after.messages.at(-1)?.id).toBe(created.message.id);
    // Both sort after the Chat's history (the cache orders messages by time).
    const sentAt = Date.parse(sent.data.message.createdAt);
    const history = before.messages.slice(0, -1).map((m) => Date.parse(m.createdAt));
    expect(sentAt).toBeGreaterThan(Math.max(...history));
    expect(Date.parse(created.message.createdAt)).toBeGreaterThan(sentAt);
    expect(after.messages.at(-2)?.createdAt).toBe(sent.data.message.createdAt);
  });
});

// The Vault (vault.md VT-73) goes through to `createFixtureFetch()` untouched: Mara's four entries, keys, checks.
describe('what the agent runs in the fixture world (OP-19, AP-5760)', () => {
  it('runs containers, and lists the agent’s services: one running with its link, Stop stops it', async () => {
    const s = setup();
    const host = await s.client.request(api.host.info, { params: { burrow } });
    if (host.status !== 'ok') throw new Error(host.status);
    expect(showsServices(host.data)).toBe(true);
    const got = await s.client.request(api.services.list, { params: { burrow } });
    if (got.status !== 'ok') throw new Error(got.status);
    const rows = serviceRows(got.data.services, { now: new Date(), timeZone: 'Europe/Amsterdam' });
    const running = rows.find((r) => r.canStop && r.url);
    if (!running) throw new Error('no running service');
    const stopped = await s.client.request(api.services.stop, {
      params: { burrow },
      body: { id: running.id },
    });
    if (stopped.status !== 'ok') throw new Error(stopped.status);
    expect(stopped.data.service.state).toBe('stopped');
  });
});

describe('the Vault in the fixture world', () => {
  it('lists Mara’s entries, on for the agent but an old secret, and opens one', async () => {
    const s = setup();
    const list = await s.client.vault.list({ params: { burrow } });
    // The demo world is the one-Whombat world (one-layout-android.md AP-2646): the SSH keys are its servers'.
    expect(list.entries.map((e) => e.name)).toEqual([
      'Deploy key',
      'Grafana',
      'Home Assistant',
      'Home lab',
      'Printer admin',
      'Shop admin',
      'Weather API key',
    ]);
    const principals = bootstrap().principals.map((p) => (p.kind === 'agent' ? assistantAgent() : p));
    const ctx = { ...worldContext(), people: peopleFrom(principals) };
    const got = await s.client.vault.get({ params: { burrow, entryId: 'vlt_homeassistant' } });
    // The agent holds Mara's entries (VS-01, VS-02, OA-09; AP-4035).
    expect(got.entry.key).not.toBeNull();
    expect(vaultEntryScreen(got.entry, ctx).access).toMatchObject({ name: 'Neo', value: 'on' });
    // An old secret entry is off.
    expect(list.entries.map((e) => e.agentOn)).toEqual([true, true, true, true, true, true, false]);
    const networks = await s.client.vaultNetworks.list({});
    expect(networks.networks.map((n) => n.cidr)).toEqual(['192.168.1.0/24']);
    await expect(s.client.vault.get({ params: { burrow, entryId: 'vlt_nobody' } })).rejects.toThrow(ApiError);
  });

  it('switches “Neo can use this” off and on, names an API’s variable, and keeps it (VS-03, CT-1240; AP-5280)', async () => {
    const s = setup();
    const entryId = 'vlt_grafana';
    const params = { burrow, entryId };
    const named = await s.client.request(api.vault.setKeyEnvName, {
      params,
      body: { envName: 'GRAFANA_TOKEN' },
    });
    if (named.status !== 'ok') throw new Error(named.status);
    expect(named.data.entry.key?.envName).toBe('GRAFANA_TOKEN');
    const off = await s.client.vault.takeKey({ params });
    if (off.status !== 'ok') throw new Error(off.status);
    expect(off.data.entry.key).toBeNull();
    const again = await s.client.vault.get({ params: { burrow, entryId } });
    expect(again.entry.key).toBeNull();
    const list = await s.client.vault.list({ params: { burrow } });
    expect(list.entries.find((e) => e.id === entryId)?.agentOn).toBe(false);
    // Settings → Agent → Keys lists the entries on for it (AP-4992).
    const rows = vaultAgentRows(list.entries);
    expect(rows.some((r) => r.entryId === entryId)).toBe(false);
    expect(rows.some((r) => r.entryId === 'vlt_homeassistant')).toBe(true);
  });

  it('turns a new tool on and checks the connection again', async () => {
    const s = setup();
    const entryId = 'vlt_homeassistant';
    const on = await s.client.vault.setTool({
      params: { burrow, entryId, tool: 'GetLiveContext' },
      body: { enabled: true },
    });
    if (on.status !== 'ok') throw new Error(on.status);
    expect(on.data.entry.tools.find((t) => t.name === 'GetLiveContext')).toMatchObject({
      enabled: true,
      isNew: false,
    });
    const checked = await s.client.vault.check({ params: { burrow, entryId: 'vlt_printer' } });
    if (checked.status !== 'ok') throw new Error(checked.status);
    expect(checked.data.result.summary).toBe('The server rejected the secret (401).');
  });
});

// TODO 16.4: mobile screens read `.error`/`.isPending` off these calls to drive their quiet loading,
// error and empty states — these switches force each condition through the same fixture fetch every
// other test in this file uses, so a screen's error-with-retry / skeleton branch is testable without a
// second mock. See docs/decisions/states.md.
describe('fixture fetch failure/latency switches (TODO 16.4)', () => {
  it('500s only the failing endpoint, leaving the rest of the world untouched', async () => {
    const s = setup({ failing: ['canvases.list'] });
    await expect(s.client.request(api.canvases.list, { params: { burrow } })).rejects.toThrow(ApiError);
    try {
      await s.client.request(api.canvases.list, { params: { burrow } });
      throw new Error('expected canvases.list to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(500);
    }
    // Unrelated endpoints keep serving fixture data — `failing` is scoped to the given endpoint ids.
    const inbox = await s.client.notifications.inbox({ params: { burrow }, query: { filter: 'all' } });
    expect(inbox.sections.length).toBeGreaterThan(0);
  });

  it('failing is a fixed set: the same endpoint keeps failing on retry, not one-shot', async () => {
    const s = setup({ failing: ['canvases.list'] });
    await expect(s.client.request(api.canvases.list, { params: { burrow } })).rejects.toThrow(ApiError);
    await expect(s.client.request(api.canvases.list, { params: { burrow } })).rejects.toThrow(ApiError);
  });
});
