/**
 * Automations that act without AI, end to end (docs/decisions/direct-automations.md): a `run_action` step shuts a
 * server down through the Servers connection with no assistant turn and no model (the fake hosts service is on a local
 * socket: nothing leaves the box), a server already off is a quiet no-op, the server this Whombat runs on still asks on
 * the approval card, a light goes off through Home Assistant's own API, a UPS on battery acts through a quiet window
 * that hushes only news, a Home Assistant state that must hold waits its minutes, and a doorbell pressed again within the
 * cooldown starts nothing more. Postgres because every step is a signed commit and every start a claim in the scan's
 * transaction.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type AutomationDefinitionInput,
  type AutomationRun,
  newId,
  UPS_ON_BATTERY_CHECK,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { updatePreferences } from '../commands/account';
import { decideApproval } from '../commands/approvals';
import { syncTools } from '../connections/sync';
import {
  approvals,
  automations,
  automationVersions,
  automationWaits,
  catalogConnections,
  connectionTools,
  incidents,
  quietWindows,
  vaultNetworks,
} from '../db/schema/index';
import { SERVERS_CATALOG } from '../hosts/asks';
import { serversPrincipal } from '../hosts/principal';
import { ensureServersConnection } from '../hosts/provision';
import { hostsFor } from '../hosts/service';
import { FakeHostsService } from '../hosts/testing/fake';
import { incidentsPass } from '../incidents/store';
import { personAccountId } from '../read/principals';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { useVaultNetForTests } from '../vault/net';
import { runAutomationNow } from './commands';
import { noteSmartHome, smartHomePrincipal, smartHomeTriggersFor } from './home-triggers';

type Json = Record<string, unknown>;

const MINUTE = 60_000;
const fake = new FakeHostsService();
const w = useAutomationWorld({
  env: { WHOMBAT_HOSTS_SOCKET: fake.socket, WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile },
});

/** A fake Home Assistant on this machine: the states it holds, their names, and the service calls it was asked for. */
const home = {
  states: new Map<string, string>([
    ['light.porch', 'off'],
    ['script.good_night', 'off'],
  ]),
  names: new Map<string, string>([['light.porch', 'Porch light']]),
  calls: [] as { path: string; body: Json }[],
  port: 0,
};
const haServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const path = req.url ?? '';
    const answer = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    const state = /^\/api\/states\/(.+)$/.exec(path);
    if (req.method === 'GET' && state?.[1]) {
      const now = home.states.get(state[1]);
      const name = home.names.get(state[1]);
      return now
        ? answer(200, { entity_id: state[1], state: now, attributes: name ? { friendly_name: name } : {} })
        : answer(404, { message: 'Entity not found.' });
    }
    if (req.method === 'POST' && path.startsWith('/api/services/')) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Json;
      home.calls.push({ path, body });
      return answer(200, []);
    }
    return answer(404, { message: 'Not found' });
  });
});

let haId = '';
let protectId = '';

/** Home Assistant on the home network, as the person allowed it (again after a restart: it belongs to the services). */
function homeNetwork() {
  useVaultNetForTests(w.services, {
    resolve: async (host) => {
      if (host === 'homeassistant.example.com') return [{ address: '10.100.92.20', family: 4 }];
      throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
    dialAddress: (address) => (address === '10.100.92.20' ? '127.0.0.1' : address),
    deadlineMs: 3000,
  });
}

/**
 * Follows the hosts service's events, as the box does (how a power action ended comes that way), and waits until the
 * stream is open. Again after a restart: it belongs to the services.
 */
async function followHosts() {
  fake.dropStreams();
  hostsFor(w.services).start();
  for (let i = 0; fake.streams < 1; i++) {
    if (i > 100) throw new Error('no event stream');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  await fake.start();
  // The Servers connection, as the box makes it once the hosts service answers.
  for (let i = 0; !(await ensureServersConnection(w.services).catch(() => null)); i++) {
    if (i > 100) throw new Error('no Servers connection');
    await new Promise((r) => setTimeout(r, 50));
  }
  await followHosts();
  // basalt's owner allowed restarting the machine itself (granite's fixture has no switches: everything goes).
  const basalt = fake.details.basalt?.server as Json | undefined;
  const switches = basalt?.remote_control as Json | undefined;
  if (!switches) throw new Error('basalt has no switches');
  switches.host_power = true;
  switches.agent_host_power = true;

  await new Promise<void>((r) => haServer.listen(0, '127.0.0.1', r));
  home.port = (haServer.address() as AddressInfo).port;
  homeNetwork();
  await w.services.db.insert(vaultNetworks).values({
    id: newId('vaultNetwork'),
    cidr: '10.100.92.0/24',
    ports: [home.port],
    note: 'Home Assistant',
    addedByAccountId: null,
    addedAt: w.now(),
  });
  haId = await insertConnection(w.services, {
    catalogId: 'homeassistant',
    burrowId: w.burrowId,
    connectedById: IDS.mara,
    label: 'Home Assistant',
    fields: { url: `http://homeassistant.example.com:${home.port}` },
    secret: 'test-token',
  });
  await syncTools(w.services, haId);
  protectId = await insertConnection(w.services, {
    catalogId: 'unifi_protect',
    burrowId: w.burrowId,
    connectedById: IDS.mara,
    label: 'UniFi Protect',
    fields: { url: 'https://192.168.1.1' },
    secret: 'test-key',
  });
});

afterAll(async () => {
  hostsFor(w.services).close();
  await fake.stop();
  await new Promise<void>((r) => haServer.close(() => r()));
});

function definition(
  steps: AutomationDefinitionInput['steps'],
  triggers: AutomationDefinitionInput['triggers'] = [{ kind: 'manual' }],
): AutomationDefinitionInput {
  return { version: 1, conversationId: IDS.incidents, triggers, steps };
}

const tell = (text: string) => ({ id: 'tell', kind: 'post_message' as const, text });

const shutDown = (server: string, more: Json = {}) => ({
  id: 'off',
  kind: 'run_action' as const,
  thing: `server:${server}`,
  thingName: server,
  action: 'shut_down' as const,
  ...more,
});

async function runNow(automationId: string): Promise<AutomationRun> {
  const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId });
  await w.settle();
  return w.run(runId as string);
}

const step = (run: AutomationRun, id: string) => {
  const s = run.steps.find((x) => x.stepId === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

const actions = (server: string) => fake.calls('POST', `/api/v1/servers/${server}/actions`);

/** The steps an automation's current version keeps. */
async function savedSteps(automationId: string) {
  const [row] = await w.services.db.select().from(automations).where(eq(automations.id, automationId));
  const [v] = await w.services.db
    .select()
    .from(automationVersions)
    .where(
      and(
        eq(automationVersions.automationId, automationId),
        eq(automationVersions.n, row?.currentVersion ?? 0),
      ),
    );
  if (!v) throw new Error('no version');
  return v;
}

/** Gives servers other host names in the hosts service, as a person renaming them would; the old ones back after. */
async function withHostnames(names: Record<string, string>, body: () => Promise<void>) {
  const cards = fake.fleet.servers as Json[];
  const before = new Map(cards.map((c) => [c, c.hostname]));
  const rename = (to: Record<string, string>) => {
    for (const c of cards) if (typeof c.id === 'string' && c.id in to) c.hostname = to[c.id];
    hostsFor(w.services).forget();
  };
  try {
    rename(names);
    await body();
  } finally {
    for (const [c, hostname] of before) c.hostname = hostname;
    hostsFor(w.services).forget();
  }
}

/** Gives the version an automation runs other steps, as one saved some other way would keep them. */
async function saveSteps(automationId: string, change: (s: Json) => Json) {
  const v = await savedSteps(automationId);
  const steps = v.definition.steps.map((x) => (x.kind === 'run_action' ? change(x as Json) : x));
  await w.services.db
    .update(automationVersions)
    .set({ definition: { ...v.definition, steps } as typeof v.definition })
    .where(and(eq(automationVersions.automationId, automationId), eq(automationVersions.n, v.n)));
}

/** The Servers connection, as the box made it. */
async function serversConnection() {
  const [row] = await w.services.db
    .select()
    .from(catalogConnections)
    .where(
      and(eq(catalogConnections.burrowId, w.burrowId), eq(catalogConnections.catalogId, SERVERS_CATALOG)),
    );
  if (!row) throw new Error('no Servers connection');
  return row;
}

/** Says yes on the approval card a step waits on. */
async function approve(run: AutomationRun, id: string) {
  const waiting = step(run, id);
  const [approval] = await w.services.db
    .select()
    .from(approvals)
    .where(eq(approvals.id, waiting.approvalId as string));
  if (!approval) throw new Error('no approval');
  await w.ok(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
  await w.settle();
}

/**
 * An automation saved before scenes and scripts were taken out of what runs without AI: published with a light, then
 * its saved definition given the script step, as such an automation is stored.
 */
async function savedWithScript(name: string): Promise<string> {
  const light = {
    id: 'act',
    kind: 'run_action' as const,
    thing: `connection:${haId}`,
    thingName: 'Home Assistant',
    target: 'light.porch',
    targetName: 'Porch light',
    action: 'turn_on' as const,
  };
  const id = await w.publish(definition([light]), { name });
  const [row] = await w.services.db.select().from(automations).where(eq(automations.id, id));
  const [v] = await w.services.db
    .select()
    .from(automationVersions)
    .where(and(eq(automationVersions.automationId, id), eq(automationVersions.n, row?.currentVersion ?? 0)));
  if (!v) throw new Error('no version');
  const steps = v.definition.steps.map((s) =>
    s.kind === 'run_action' ? { ...s, target: 'script.good_night', targetName: 'Good night' } : s,
  );
  await w.services.db
    .update(automationVersions)
    .set({ definition: { ...v.definition, steps } })
    .where(and(eq(automationVersions.automationId, id), eq(automationVersions.n, v.n)));
  return id;
}

/** A run whose action step Whombat had marked running when it stopped, after the restart. */
async function cutShort(automationId: string): Promise<string> {
  const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId });
  await w.services.db.execute(
    sql`update automation_runs set status = 'running', started_at = now() where id = ${runId as string}`,
  );
  await w.services.db.execute(
    sql`update automation_run_steps set state = 'running', attempt = 0, started_at = now(),
      output = jsonb_build_object('approvalId', 'apr_cut_short', 'approvalAttempt', 0, 'callId', ${`call_${runId}`}::text)
      where run_id = ${runId as string} and step_id = 'act'`,
  );
  hostsFor(w.services).close();
  await w.restart();
  homeNetwork();
  await followHosts();
  await w.services.automations.bootRecovery();
  await w.settle();
  return runId as string;
}

async function signSmartHome(input: z.input<typeof noteSmartHome.schema>) {
  const signer = await smartHomePrincipal.ensure(w.services, w.burrowId);
  return w.ok(signer, noteSmartHome, input);
}

describe('a run_action step', () => {
  it('shuts a server down by itself, with no assistant turn, and says what it did in one line', async () => {
    const turnsBefore = (await w.dispatchesOf('automation')).length;
    const id = await w.publish(definition([shutDown('granite'), tell('{{steps.off.text}}')]));
    const run = await runNow(id);
    expect(run.status).toBe('succeeded');
    const off = step(run, 'off');
    expect(off.state).toBe('succeeded');
    expect(off.output).toMatchObject({ ran: true });
    expect(String((off.output as Json).text)).toContain('granite');
    const asked = actions('granite');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).toMatchObject({ action: 'host_shutdown', confirm: true });
    // No model was asked anything: the box did it alone.
    expect(await w.dispatchesOf('automation')).toHaveLength(turnsBefore);
    const said = await w.runThread(run.id);
    expect(said.some((m) => m.text?.includes('granite'))).toBe(true);
  });

  it('sends nothing to a server it can’t reach, says so, and doesn’t count it as done', async () => {
    const id = await w.publish(
      definition([shutDown('marble', { otherwise: 'skip' }), tell('{{steps.off.text}}')]),
    );
    const run = await runNow(id);
    expect(run.status).toBe('succeeded');
    const off = step(run, 'off');
    expect(off.state).toBe('skipped');
    expect(off.output).toMatchObject({ ran: false });
    expect((off.output as Json).noop).toBeUndefined();
    expect(String((off.output as Json).text)).toContain('marble');
    expect(String((off.output as Json).text)).toMatch(/reach/);
    expect(actions('marble')).toHaveLength(0);
    // Without `skip`, it stops the run.
    const strict = await w.publish(definition([shutDown('marble')]));
    expect(step(await runNow(strict), 'off').state).toBe('failed');
  });

  it('says its line in Dutch for a person who reads Dutch', async () => {
    const accountId = await personAccountId(w.services.db);
    if (!accountId) throw new Error('missing the person’s account');
    await updatePreferences(w.services, accountId, { locale: 'nl-NL' });
    try {
      const id = await w.publish(definition([shutDown('marble'), tell('{{steps.off.text}}')]));
      const run = await runNow(id);
      const text = String((step(run, 'off').output as Json).text);
      expect(text).toContain('marble');
      expect(text).toContain('niet bereiken');
      expect(step(run, 'off').inputSummary).toContain('uitzetten');
    } finally {
      await updatePreferences(w.services, accountId, { locale: null });
    }
  });

  it('asks before shutting down the server this Whombat runs on, and acts only on the yes', async () => {
    const id = await w.publish(definition([shutDown('basalt', { action: 'restart' })]));
    const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId: id });
    await w.settle();
    let run = await w.run(runId as string);
    const waiting = step(run, 'off');
    expect(waiting.state).toBe('waiting');
    expect(waiting.approvalId).toBeTruthy();
    expect(actions('basalt')).toHaveLength(0);
    await approve(run, 'off');
    run = await w.run(runId as string);
    expect(step(run, 'off').state).toBe('succeeded');
    expect(actions('basalt').at(-1)?.body).toMatchObject({ action: 'host_reboot' });
  });

  it('asks on the card in a test run, and acts only on the yes', async () => {
    const id = await w.publish(definition([shutDown('granite'), tell('{{steps.off.text}}')]));
    const before = actions('granite').length;
    const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId: id, test: true });
    await w.settle();
    let run = await w.run(runId as string);
    expect(step(run, 'off').state).toBe('waiting');
    expect(step(run, 'off').approvalId).toBeTruthy();
    expect(actions('granite')).toHaveLength(before);
    const [card] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, step(run, 'off').approvalId as string));
    expect(card?.summary).toMatch(/try/);
    await approve(run, 'off');
    run = await w.run(runId as string);
    expect(run.status).toBe('succeeded');
    expect(step(run, 'off').state).toBe('succeeded');
    expect(actions('granite')).toHaveLength(before + 1);
  });

  it('never drafts a Home Assistant script, and one an automation saved before asks each time', async () => {
    const script = {
      id: 'act',
      kind: 'run_action' as const,
      thing: `connection:${haId}`,
      thingName: 'Home Assistant',
      target: 'script.good_night',
      action: 'turn_on' as const,
    };
    await expect(w.publish(definition([script]))).rejects.toThrow();

    const id = await savedWithScript('Saved good night');
    const calls = home.calls.length;
    let run = await runNow(id);
    expect(step(run, 'act').state).toBe('waiting');
    expect(home.calls).toHaveLength(calls);
    await approve(run, 'act');
    run = await w.run(run.id);
    expect(step(run, 'act').state).toBe('succeeded');
    expect(home.calls.at(-1)).toEqual({
      path: '/api/services/script/turn_on',
      body: { entity_id: 'script.good_night' },
    });
  });

  it('keeps and says the names Whombat knows, never the ones it was given', async () => {
    const start = {
      id: 'on',
      kind: 'run_action' as const,
      thing: 'server:shale',
      thingName: 'media box',
      target: 'pve:107',
      targetName: 'plex',
      action: 'start' as const,
    };
    const id = await w.publish(definition([start, tell('{{steps.on.text}}')]));
    expect((await savedSteps(id)).definition.steps[0]).toMatchObject({
      thingName: 'shale',
      targetName: 'win11-lab',
    });
    const run = await runNow(id);
    const on = step(run, 'on');
    expect(on.state).toBe('succeeded');
    expect(String((on.output as Json).text)).toContain('win11-lab');
    expect(String((on.output as Json).text)).not.toContain('plex');
  });

  it('says the names Whombat knows now for an automation saved under other names', async () => {
    home.states.set('light.porch', 'off');
    const light = {
      id: 'act',
      kind: 'run_action' as const,
      thing: `connection:${haId}`,
      thingName: 'Home Assistant',
      target: 'light.porch',
      targetName: 'Porch light',
      action: 'turn_on' as const,
    };
    const id = await w.publish(definition([light]), { name: 'Saved under another name' });
    const v = await savedSteps(id);
    // As a draft could have saved it before the names were checked: another light's name.
    const steps = v.definition.steps.map((x) =>
      x.kind === 'run_action' ? { ...x, thingName: 'Hallway', targetName: 'Kitchen light' } : x,
    );
    await w.services.db
      .update(automationVersions)
      .set({ definition: { ...v.definition, steps } })
      .where(and(eq(automationVersions.automationId, id), eq(automationVersions.n, v.n)));
    const run = await runNow(id);
    const act = step(run, 'act');
    expect(act.state).toBe('succeeded');
    expect(String((act.output as Json).text)).toContain('Porch light');
    expect(`${(act.output as Json).text} ${act.inputSummary}`).not.toMatch(/Kitchen|Hallway/);
  });

  it('refuses a step whose machine or entity isn’t there', async () => {
    const start = {
      id: 'on',
      kind: 'run_action' as const,
      thing: 'server:shale',
      thingName: 'shale',
      target: 'pve:999',
      action: 'start' as const,
    };
    await expect(w.publish(definition([start]))).rejects.toThrow(/pve:999/);
    const light = {
      id: 'on',
      kind: 'run_action' as const,
      thing: `connection:${haId}`,
      thingName: 'Home Assistant',
      target: 'light.nowhere',
      action: 'turn_on' as const,
    };
    await expect(w.publish(definition([light]))).rejects.toThrow(/light\.nowhere/);
  });

  it('keeps acting on the server it was saved for when another one takes its name', async () => {
    await withHostnames({ granite: 'storage' }, async () => {
      const id = await w.publish(definition([shutDown('storage'), tell('{{steps.off.text}}')]));
      expect((await savedSteps(id)).definition.steps[0]).toMatchObject({ thing: 'server:granite' });
      await withHostnames({ granite: 'granite', obsidian: 'storage' }, async () => {
        const granite = actions('granite').length;
        const obsidian = actions('obsidian').length;
        const off = step(await runNow(id), 'off');
        expect(off.state).toBe('succeeded');
        expect(actions('granite')).toHaveLength(granite + 1);
        expect(actions('obsidian')).toHaveLength(obsidian);
      });
    });
  });

  it('keeps acting on the machine it was saved for when another one takes its name', async () => {
    const guests = fake.guestsOf('shale');
    const lab = guests.find((g) => g.id === 'pve:107');
    const build = guests.find((g) => g.id === 'pve:101');
    if (!lab || !build) throw new Error('missing shale’s machines');
    const start = {
      id: 'on',
      kind: 'run_action' as const,
      thing: 'server:shale',
      thingName: 'shale',
      target: 'win11-lab',
      action: 'start' as const,
    };
    const id = await w.publish(definition([start]));
    expect((await savedSteps(id)).definition.steps[0]).toMatchObject({ target: 'pve:107' });
    const names = { lab: lab.name, build: build.name };
    lab.name = 'win11-old';
    build.name = 'win11-lab';
    hostsFor(w.services).forget();
    try {
      const path = (guest: string) => `/api/v1/servers/shale/guests/${guest}/actions`;
      const before = {
        lab: fake.calls('POST', path('pve:107')).length,
        build: fake.calls('POST', path('pve:101')).length,
      };
      const on = step(await runNow(id), 'on');
      expect(on.state).toBe('succeeded');
      expect(String((on.output as Json).text)).toContain('win11-old');
      expect(fake.calls('POST', path('pve:107'))).toHaveLength(before.lab + 1);
      expect(fake.calls('POST', path('pve:101'))).toHaveLength(before.build);
    } finally {
      lab.name = names.lab;
      build.name = names.build;
      hostsFor(w.services).forget();
    }
  });

  it('acts only on a server by its id: a step kept under a name is refused and sends nothing', async () => {
    const id = await w.publish(definition([shutDown('granite'), tell('{{steps.off.text}}')]));
    await saveSteps(id, (x) => ({ ...x, thing: 'server:storage', thingName: 'storage' }));
    await withHostnames({ granite: 'storage' }, async () => {
      const before = actions('granite').length;
      const off = step(await runNow(id), 'off');
      expect(off.state).not.toBe('succeeded');
      expect(off.error).toContain('storage');
      expect(actions('granite')).toHaveLength(before);
    });
  });

  it('keeps to the limits the person set on the tool', async () => {
    const servers = await serversConnection();
    const where = and(eq(connectionTools.connectionId, servers.id), eq(connectionTools.name, 'server_power'));
    await w.services.db
      .update(connectionTools)
      .set({ limits: { args: { '/action': { choices: ['reboot'] } } } })
      .where(where);
    try {
      const before = actions('granite').length;
      const id = await w.publish(definition([shutDown('granite')]));
      const off = step(await runNow(id), 'off');
      expect(off.state).not.toBe('succeeded');
      expect(off.error).toMatch(/wasn’t sent/);
      expect(actions('granite')).toHaveLength(before);
    } finally {
      await w.services.db.update(connectionTools).set({ limits: null }).where(where);
    }
  });

  it('counts a shutdown only once the server says so, and says so when it refused', async () => {
    let refuse = true;
    fake.on('POST', '/api/v1/servers/obsidian/actions', () => {
      if (!refuse) return null;
      // The server says no at once: before Whombat even has the action's id.
      fake.emit('action.finished', {
        action_id: 'act_refused_obsidian',
        server: 'obsidian',
        guest: 'host',
        action: 'host_shutdown',
        result: 'error',
        message: 'Remote control is turned off',
        state: null,
        noop: false,
        code: 'remote_control_disabled',
      });
      return { status: 202, body: { action_id: 'act_refused_obsidian', audit_id: 'au_refused_obsidian' } };
    });
    try {
      const id = await w.publish(
        definition([shutDown('obsidian', { otherwise: 'skip' }), tell('{{steps.off.text}}')]),
      );
      const run = await runNow(id);
      expect(actions('obsidian')).toHaveLength(1);
      const off = step(run, 'off');
      expect(off.state).toBe('skipped');
      expect(off.output).toMatchObject({ ran: false });
      expect(String((off.output as Json).text)).toContain('obsidian');
      expect(String((off.output as Json).text)).toMatch(/allow/);
    } finally {
      refuse = false;
    }
  });

  it('asks again when the connection went elsewhere after the card, and sends nothing on that yes', async () => {
    const id = await w.publish(definition([shutDown('basalt', { action: 'restart' })]));
    const before = actions('basalt').length;
    const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId: id });
    await w.settle();
    let run = await w.run(runId as string);
    expect(step(run, 'off').state).toBe('waiting');
    const servers = await serversConnection();
    await w.services.db
      .update(catalogConnections)
      .set({ fields: { ...(servers.fields ?? {}), moved: 'elsewhere' } })
      .where(eq(catalogConnections.id, servers.id));
    try {
      await approve(run, 'off');
      run = await w.run(runId as string);
      expect(step(run, 'off').state).not.toBe('succeeded');
      expect(actions('basalt')).toHaveLength(before);
    } finally {
      await w.services.db
        .update(catalogConnections)
        .set({ fields: servers.fields })
        .where(eq(catalogConnections.id, servers.id));
    }
  });

  it('sends nothing on a yes given while the connection went elsewhere', async () => {
    const id = await w.publish(definition([shutDown('basalt', { action: 'restart' })]));
    const before = actions('basalt').length;
    const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId: id });
    // A yes for this attempt, as the card kept it, for where the connection went then.
    await w.services.db.execute(
      sql`update automation_run_steps set output = jsonb_build_object('approvalId', 'apr_elsewhere',
        'approvalAttempt', 0, 'approvedTarget', 'elsewhere') where run_id = ${runId as string} and step_id = 'off'`,
    );
    await w.settle();
    const off = step(await w.run(runId as string), 'off');
    expect(off.state).not.toBe('succeeded');
    expect(off.error).toMatch(/changed since you said yes/);
    expect(actions('basalt')).toHaveLength(before);
  });

  it('turns a light off through Home Assistant, and leaves one that is already off', async () => {
    home.states.set('light.porch', 'on');
    const step1 = {
      id: 'off',
      kind: 'run_action' as const,
      thing: `connection:${haId}`,
      thingName: 'Home Assistant',
      target: 'light.porch',
      targetName: 'Porch light',
      action: 'turn_off' as const,
    };
    const id = await w.publish(definition([step1, tell('{{steps.off.text}}')]));
    const run = await runNow(id);
    expect(run.status).toBe('succeeded');
    expect(home.calls.at(-1)).toEqual({
      path: '/api/services/light/turn_off',
      body: { entity_id: 'light.porch' },
    });
    expect(step(run, 'off').output).toMatchObject({ ran: true });

    home.states.set('light.porch', 'off');
    const calls = home.calls.length;
    const again = await runNow(id);
    expect(step(again, 'off').output).toMatchObject({ ran: false, noop: true });
    expect(home.calls).toHaveLength(calls);
  });
});

describe('after Whombat stopped mid-action', () => {
  it('does a light again, as twice comes out the same as once', async () => {
    home.states.set('light.porch', 'off');
    const id = await w.publish(
      definition([
        {
          id: 'act',
          kind: 'run_action' as const,
          thing: `connection:${haId}`,
          thingName: 'Home Assistant',
          target: 'light.porch',
          targetName: 'Porch light',
          action: 'turn_on' as const,
        },
      ]),
      { name: 'Porch on, cut short' },
    );
    const calls = home.calls.length;
    const run = await w.run(await cutShort(id));
    expect(step(run, 'act').state).toBe('succeeded');
    expect(home.calls.slice(calls).map((c) => c.path)).toEqual(['/api/services/light/turn_on']);
  });

  it('says a shutdown it was sending may have happened when the server is out of reach after the restart', async () => {
    const id = await w.publish(definition([shutDown('marble', { id: 'act' })]), {
      name: 'Marble off, cut short',
    });
    const run = await w.run(await cutShort(id));
    // Not a failure of the run, and not counted as a shutdown that happened: what is known is said.
    expect(run.status).toBe('succeeded');
    const act = step(run, 'act');
    expect(act.state).toBe('skipped');
    expect(act.output).toMatchObject({ ran: false, unconfirmed: true });
    const text = String((act.output as Json).text);
    expect(text).toContain('marble');
    expect(text).toMatch(/restarted/);
    expect(text).not.toMatch(/switching off/);
    expect(actions('marble')).toHaveLength(0);
  });

  it('doesn’t run a script again, which could do twice what is in it: a person checks', async () => {
    const id = await savedWithScript('Good night, cut short');
    const calls = home.calls.length;
    const run = await w.run(await cutShort(id));
    expect(run.status).toBe('needs_review');
    expect(step(run, 'act').state).toBe('uncertain');
    expect(step(run, 'act').error).toBeTruthy();
    expect(home.calls).toHaveLength(calls);
  });
});

describe('a UPS on battery', () => {
  async function powerCut(thing: string) {
    const signer = await serversPrincipal(w.services, w.burrowId);
    await w.ok(signer, incidentsPass, {
      opened: [
        {
          thing,
          kind: 'server',
          name: 'granite',
          nature: 'problem',
          words: 'Running on battery',
          check: UPS_ON_BATTERY_CHECK,
          subject: '',
          cause: null,
          startedAt: w.now().toISOString(),
        },
      ],
      changed: [],
      ended: [],
    });
    const [row] = await w.services.db
      .select()
      .from(incidents)
      .where(and(eq(incidents.thingId, thing), eq(incidents.startedAt, w.now())));
    if (!row) throw new Error('no incident');
    return row.id;
  }

  it('shuts the servers down through a quiet window, which only hushes news', async () => {
    const thing = 'server:granite';
    const triggers = [
      {
        kind: 'thing' as const,
        event: 'problem' as const,
        thing,
        name: 'granite',
        check: UPS_ON_BATTERY_CHECK,
      },
    ];
    const acts = await w.publish(definition([shutDown('granite'), tell('{{steps.off.text}}')], triggers));
    const news = await w.publish(definition([tell('The power is out at granite.')], triggers));
    await w.services.pipeline.transact(w.burrowId, async ({ tx }) => {
      await tx.insert(quietWindows).values({
        id: 'quiet_power_cut',
        ownerId: w.burrowId,
        thingId: thing,
        startsAt: w.now(),
        endsAt: new Date(w.now().getTime() + 60 * MINUTE),
        createdAt: w.now(),
      });
    });
    const before = actions('granite').length;
    await powerCut(thing);
    await w.settle();
    const [run] = await w.runs(acts);
    expect(run?.status).toBe('succeeded');
    expect(actions('granite')).toHaveLength(before + 1);
    // The automation that only tells you stays quiet with the server.
    expect(await w.runs(news)).toHaveLength(0);
  });
});

describe('Home Assistant and Protect starts', () => {
  it('waits until the state has held for its minutes, and starts nothing when it changed back', async () => {
    const id = await w.publish(
      definition(
        [tell('{{trigger.text}}')],
        [
          {
            kind: 'home_state',
            connectionId: haId,
            entity: 'binary_sensor.water_leak',
            entityName: 'Water leak',
            to: 'on',
            forMinutes: 10,
          },
        ],
      ),
    );
    const now = vi.spyOn(smartHomeTriggersFor(w.services), 'current');
    try {
      const change = (from: string, to: string, changedAt?: number) =>
        signSmartHome({
          connectionId: haId,
          changes: [
            {
              entity: 'binary_sensor.water_leak',
              name: 'Water leak',
              from,
              to,
              ...(changedAt ? { changedAt } : {}),
            },
          ],
        });
      await change('off', 'on');
      await w.settle();
      expect(await w.runs(id)).toHaveLength(0);
      const waits = await w.services.db
        .select()
        .from(automationWaits)
        .where(eq(automationWaits.automationId, id));
      expect(waits).toHaveLength(1);

      // Back to dry before its time: the wait ends, nothing starts.
      w.advance(5 * MINUTE);
      await change('on', 'off');
      await w.settle();
      w.advance(10 * MINUTE);
      await w.settle();
      expect(await w.runs(id)).toHaveLength(0);

      // Wet again, and wet ten minutes later, but from a later change Whombat didn't hear: it didn't hold.
      const wet = w.now().getTime() / 1000;
      await change('off', 'on', wet);
      await w.settle();
      w.advance(10 * MINUTE);
      now.mockReturnValue({ state: 'on', changedAt: wet + 240 });
      await w.settle();
      expect(await w.runs(id)).toHaveLength(0);

      // Wet again, and Home Assistant removed the sensor before its time: the wait ends, nothing starts.
      const removed = w.now().getTime() / 1000;
      await change('off', 'on', removed);
      await w.settle();
      w.advance(10 * MINUTE);
      now.mockReturnValue('gone');
      await w.settle();
      expect(await w.runs(id)).toHaveLength(0);
      expect(
        await w.services.db.select().from(automationWaits).where(eq(automationWaits.automationId, id)),
      ).toHaveLength(0);

      // Wet again, and still wet from that change ten minutes later: one run.
      const again = w.now().getTime() / 1000;
      await change('off', 'on', again);
      await w.settle();
      w.advance(10 * MINUTE);
      now.mockReturnValue({ state: 'on', changedAt: again });
      await w.settle();
      const runs = await w.runs(id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('succeeded');
    } finally {
      now.mockRestore();
    }
  });

  it('starts once for a doorbell pressed again within the cooldown, and again after it', async () => {
    const id = await w.publish(
      definition([tell('{{trigger.text}}')], [{ kind: 'protect', connectionId: protectId, event: 'ring' }]),
    );
    const ring = (n: number) =>
      signSmartHome({
        connectionId: protectId,
        detections: [
          { event: 'ring', camera: 'cam_front', cameraName: 'Front door', detection: `evt_ring_${n}` },
        ],
      });
    await ring(1);
    await w.settle();
    w.advance(MINUTE);
    await ring(2);
    await w.settle();
    expect(await w.runs(id)).toHaveLength(1);
    w.advance(11 * MINUTE);
    await ring(3);
    await w.settle();
    const runs = await w.runs(id);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true);
  });
});
