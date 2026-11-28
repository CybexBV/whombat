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
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { updatePreferences } from '../commands/account';
import { decideApproval } from '../commands/approvals';
import { syncTools } from '../connections/sync';
import { approvals, automationWaits, incidents, quietWindows, vaultNetworks } from '../db/schema/index';
import { serversPrincipal } from '../hosts/principal';
import { ensureServersConnection } from '../hosts/provision';
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

/** A fake Home Assistant on this machine: the states it holds, and the service calls it was asked for. */
const home = { states: new Map<string, string>(), calls: [] as { path: string; body: Json }[], port: 0 };
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
      return now
        ? answer(200, { entity_id: state[1], state: now })
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

beforeAll(async () => {
  await fake.start();
  // The Servers connection, as the box makes it once the hosts service answers.
  for (let i = 0; !(await ensureServersConnection(w.services).catch(() => null)); i++) {
    if (i > 100) throw new Error('no Servers connection');
    await new Promise((r) => setTimeout(r, 50));
  }
  // basalt's owner allowed restarting the machine itself (granite's fixture has no switches: everything goes).
  const basalt = fake.details.basalt?.server as Json | undefined;
  const switches = basalt?.remote_control as Json | undefined;
  if (!switches) throw new Error('basalt has no switches');
  switches.host_power = true;
  switches.agent_host_power = true;

  await new Promise<void>((r) => haServer.listen(0, '127.0.0.1', r));
  home.port = (haServer.address() as AddressInfo).port;
  // Home Assistant on the home network, as the person allowed it.
  useVaultNetForTests(w.services, {
    resolve: async (host) => {
      if (host === 'homeassistant.example.com') return [{ address: '10.100.92.20', family: 4 }];
      throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
    dialAddress: (address) => (address === '10.100.92.20' ? '127.0.0.1' : address),
    deadlineMs: 3000,
  });
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

  it('leaves a server that is already off alone, with a line that says so', async () => {
    const id = await w.publish(definition([shutDown('marble'), tell('{{steps.off.text}}')]));
    const run = await runNow(id);
    expect(run.status).toBe('succeeded');
    expect(step(run, 'off').output).toMatchObject({ ran: false, noop: true });
    expect(String((step(run, 'off').output as Json).text)).toContain('marble');
    expect(actions('marble')).toHaveLength(0);
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
      expect(text).toContain('niets gedaan');
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
    const [approval] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, waiting.approvalId as string));
    if (!approval) throw new Error('no approval');
    await w.ok(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
    await w.settle();
    run = await w.run(runId as string);
    expect(step(run, 'off').state).toBe('succeeded');
    expect(actions('basalt').at(-1)?.body).toMatchObject({ action: 'host_reboot' });
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
      const change = (from: string, to: string) =>
        signSmartHome({
          connectionId: haId,
          changes: [{ entity: 'binary_sensor.water_leak', name: 'Water leak', from, to }],
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

      // Wet again, and still wet ten minutes later: one run.
      await change('off', 'on');
      await w.settle();
      w.advance(10 * MINUTE);
      now.mockReturnValue('on');
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
