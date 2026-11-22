/**
 * Devices Whombat doesn't support yet, end to end (docs/decisions/one-whombat.md ONE-16…ONE-19; one-whombat-devices.md):
 * a heat pump on a fake Modbus server behind a home-network address. Whombat probes it read-only, proposes a skill (the
 * card in the person's Chat, Home's “learning” thing and Needs you item), the person switches it on with limits, then a
 * write within the limits goes through and one outside them is refused before anything is signed; Ask and Off hold;
 * Undo puts the old value back as a new call; the person narrows the limits through REST.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { agentDefaultGrants, type DeviceProfileInput, type DeviceSkillCard } from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { ConnectionChangedError } from '../connections/call-target';
import {
  approvals,
  catalogConnections,
  changes,
  connectionTools,
  deviceSkills,
  events,
  messages,
  principals,
  vaultNetworks,
} from '../db/schema/index';
import { undoChange } from '../home/changes';
import { openChange } from '../home/registry';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { addPersonalAgent } from '../test/personal';
import { agentTokenFor, sessionFor } from '../test/tokens';
import { useVaultNetForTests, vaultNetOf } from '../vault/net';
import {
  deviceNeedsYou,
  deviceThings,
  deviceWatch,
  readDevicesNow,
  startDeviceReader,
  stopDeviceReader,
} from './home';
import { runDeviceTool } from './run';
import { type FakeModbus, startFakeModbus } from './testing/fake-modbus';
import { undoDeviceChange } from './undo';

const t = useTestServer({ seed: true, listen: true });

const HOST = 'heatpump.home.test';
const ADDRESS = '192.168.91.42';
const INVERTER = 'inverter.home.test';

let fake: FakeModbus;
/** A solar inverter with a local JSON API: its status and the export limit it was last sent. */
let inverter: Server;
let inverterPort = 0;
const inverterSeen: { method: string; url: string; body: string }[] = [];
let whombat = { agentId: '', dmId: '' };

/** The Daikin-like heat pump of the mock (convo.png): nine readings, three actions. */
const PROFILE: DeviceProfileInput = {
  name: 'Daikin Altherma heat pump',
  vendor: 'Daikin',
  model: 'Altherma',
  driver: 'modbus_tcp',
  readings: [
    {
      key: 'room',
      label: 'Room',
      unit: '°C',
      modbus: { table: 'input', address: 0, type: 's16', scale: 0.1 },
    },
    {
      key: 'flow',
      label: 'Water to radiators',
      unit: '°C',
      modbus: { table: 'input', address: 1, type: 'u16' },
    },
    { key: 'hot_water', label: 'Hot water', unit: '°C', modbus: { table: 'input', address: 2, type: 'u16' } },
    {
      key: 'outside',
      label: 'Outside',
      unit: '°C',
      modbus: { table: 'input', address: 3, type: 's16', scale: 0.1 },
    },
    { key: 'power', label: 'Using', unit: 'kW', modbus: { table: 'input', address: 4, type: 'f32' } },
    { key: 'mode', label: 'Mode', modbus: { table: 'input', address: 6, type: 'u16' } },
    {
      key: 'hours',
      label: 'Compressor hours',
      unit: 'h',
      modbus: { table: 'input', address: 7, type: 'u32' },
    },
    { key: 'error', label: 'Error code', modbus: { table: 'input', address: 9, type: 'u16' } },
    { key: 'defrost', label: 'Defrosting', modbus: { table: 'discrete', address: 0, type: 'bool' } },
    {
      key: 'room_setpoint',
      label: 'Room set to',
      unit: '°C',
      modbus: { table: 'holding', address: 100, type: 's16', scale: 0.1 },
    },
  ],
  actions: [
    {
      key: 'room_setpoint',
      label: 'Room temperature',
      description: 'The temperature the room is heated to.',
      modbus: { table: 'holding', address: 100, type: 's16', scale: 0.1 },
      valueType: 'number',
      min: 12,
      max: 28,
      step: 0.5,
    },
    {
      key: 'hot_water_boost',
      label: 'Hot water boost',
      description: 'Heats the hot water once, now.',
      modbus: { table: 'coil', address: 0, type: 'bool' },
      valueType: 'boolean',
    },
    {
      key: 'heating_curve',
      label: 'Heating curve',
      description: 'The installer’s setting, change with care.',
      modbus: { table: 'holding', address: 101, type: 'u16' },
      valueType: 'number',
      min: 1,
      max: 20,
      sensitive: true,
    },
    {
      key: 'mode',
      label: 'Mode',
      description: 'Heating or cooling.',
      modbus: { table: 'holding', address: 102, type: 'u16' },
      valueType: 'choice',
      choices: [
        { value: 1, label: 'Heating' },
        { value: 2, label: 'Cooling' },
      ],
    },
  ],
  source: { title: 'Installer manual', note: 'Register map on page 41' },
};

async function turn(
  agentId: string,
  conversationId: string,
  options: { outside?: boolean } = {},
): Promise<{ mcp: TestMcp; dispatchId: string }> {
  const d = await agentTokenFor(
    t.services,
    t.burrowId,
    agentId,
    conversationId,
    options.outside ? { onBehalfOfAccountId: null } : {},
  );
  return { mcp: await mcpClient(t.baseUrl, d.token), dispatchId: d.dispatchId };
}

async function rest(method: 'POST', path: string, personId: string, payload?: unknown) {
  const { cookie } = await sessionFor(t.services, personId);
  const res = await t.api.inject({
    method,
    url: `/api/v1/burrows/burrow-hq${path}`,
    headers: { cookie, 'content-type': 'application/json' },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

const writes = () => fake.requests.filter((r) => [5, 6, 15, 16].includes(r.fc));

beforeAll(async () => {
  fake = await startFakeModbus();
  inverter = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
    });
    req.on('end', () => {
      inverterSeen.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.writeHead(req.url === '/api/status' || req.url === '/api/limit' ? 200 : 404, {
        'content-type': 'application/json',
      });
      res.end(
        req.url === '/api/status'
          ? JSON.stringify({ pv: { power: 1234.5 }, grid: { exporting: true, limit: 5000 }, mode: 'auto' })
          : '{}',
      );
    });
  });
  await new Promise<void>((resolve) => inverter.listen(0, '127.0.0.1', resolve));
  inverterPort = (inverter.address() as AddressInfo).port;
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      if (host === HOST) return [{ address: ADDRESS, family: 4 }];
      if (host === INVERTER) return [{ address: '192.168.91.50', family: 4 }];
      if (host === 'pump.example.com') return [{ address: '93.184.216.34', family: 4 }];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
    dialAddress: (address) => (address.startsWith('192.168.91.') ? '127.0.0.1' : address),
    deadlineMs: 3000,
  });
  // Self-hosted tests keep the local network closed (LN-04): the home network list opens the heat pump's port.
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_devices_test',
    cidr: '192.168.91.0/24',
    ports: [fake.port, inverterPort].sort((a, b) => a - b),
    note: 'The heat pump and the inverter',
    addedAt: t.services.clock(),
  });
  // The agent with the keys a new Whombat's agent has (one-agent.md OA-S04): reading connections at Allowed.
  const made = await addPersonalAgent(t.services, t.burrowId, IDS.mara, {
    grants: agentDefaultGrants(IDS.dusty),
    services: null,
  });
  whombat = { agentId: made.agentId, dmId: made.dmId };
  startDeviceReader(t.services);
  return async () => {
    stopDeviceReader(t.services);
    await fake.close();
    await new Promise<void>((resolve) => inverter.close(() => resolve()));
  };
});

let proposalId = '';
let connectionId = '';
let slug = '';

describe('learning a device (ONE-17)', () => {
  it('lists the device tools in a person’s turn, not in an outsiders’ turn', async () => {
    const mine = await turn(whombat.agentId, whombat.dmId);
    const names = (await mine.mcp.client.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['device_probe', 'propose_device_skill']));
    await mine.mcp.close();
    const nobody = await turn(IDS.dusty, IDS.billing, { outside: true });
    const shared = (await nobody.mcp.client.listTools()).tools.map((x) => x.name);
    expect(shared).not.toContain('device_probe');
    await nobody.mcp.close();
  });

  it('device_probe reads the unit, never writes, and says which value failed', async () => {
    const { mcp } = await turn(whombat.agentId, whombat.dmId);
    const res = await mcp.call('device_probe', {
      driver: 'modbus_tcp',
      host: HOST,
      port: fake.port,
      readings: [
        {
          key: 'room',
          label: 'Room',
          unit: '°C',
          modbus: { table: 'input', address: 0, type: 's16', scale: 0.1 },
        },
        {
          key: 'setpoint',
          label: 'Setpoint',
          modbus: { table: 'holding', address: 100, type: 's16', scale: 0.1 },
        },
        { key: 'nowhere', label: 'Nowhere', modbus: { table: 'holding', address: 2000, type: 'u16' } },
      ],
    });
    expect(res.isError).toBe(false);
    const readings = res.body.readings as { key: string; value: unknown; raw?: string; error?: string }[];
    expect(readings.find((r) => r.key === 'room')).toMatchObject({ value: 21, raw: '210' });
    expect(readings.find((r) => r.key === 'setpoint')).toMatchObject({ value: 20 });
    expect(readings.find((r) => r.key === 'nowhere')?.error).toMatch(/that address doesn’t exist/);
    expect(writes()).toHaveLength(0);
    await mcp.close();
  });

  it('refuses a device on the internet and a host that doesn’t resolve', async () => {
    const { mcp } = await turn(whombat.agentId, whombat.dmId);
    const reading = [{ key: 'room', label: 'Room', modbus: { table: 'input', address: 0, type: 's16' } }];
    const internet = await mcp.call('device_probe', {
      driver: 'modbus_tcp',
      host: 'pump.example.com',
      readings: reading,
    });
    expect(internet.isError).toBe(true);
    expect(JSON.stringify(internet.body)).toMatch(/local network only/);
    const nowhere = await mcp.call('device_probe', {
      driver: 'modbus_tcp',
      host: 'gone.home.test',
      readings: reading,
    });
    expect(JSON.stringify(nowhere.body)).toMatch(/doesn’t resolve/);
    await mcp.close();
  });

  it('refuses to propose a profile that doesn’t read cleanly on the unit', async () => {
    const { mcp } = await turn(whombat.agentId, whombat.dmId);
    const res = await mcp.call('propose_device_skill', {
      profile: {
        ...PROFILE,
        readings: [
          ...PROFILE.readings,
          { key: 'ghost', label: 'Ghost', modbus: { table: 'input', address: 1500, type: 'u16' } },
        ],
      },
      host: HOST,
      port: fake.port,
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.body)).toMatch(/Reading “ghost”/);
    expect(await t.services.db.select().from(deviceSkills)).toHaveLength(0);
    await mcp.close();
  });

  it('proposes the skill: a card with the tested values, Home’s learning thing and Needs you', async () => {
    const { mcp } = await turn(whombat.agentId, whombat.dmId);
    const res = await mcp.call('propose_device_skill', { profile: PROFILE, host: HOST, port: fake.port });
    expect(res.isError).toBe(false);
    expect(res.body.status).toBe('ok');
    proposalId = res.body.proposalId as string;
    expect(proposalId).toMatch(/^dvp_/);
    await mcp.close();
    expect(writes()).toHaveLength(0);

    const [row] = await t.services.db.select().from(deviceSkills).where(eq(deviceSkills.id, proposalId));
    expect(row?.status).toBe('proposed');
    expect(row?.name).toBe('Heat pump');
    const [message] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, row?.messageId ?? ''));
    expect(message?.conversationId).toBe(whombat.dmId);
    expect(message?.text).toBe('I can read it now. Pick what I’m allowed to change before I switch that on.');
    const card = message?.card as DeviceSkillCard;
    expect(card.kind).toBe('device_skill');
    expect(card.readings.map((r) => [r.label, r.value, r.unit])).toEqual([
      ['Room', '21.0', '°C'],
      ['Water to radiators', '34', '°C'],
      ['Hot water', '48', '°C'],
      ['Outside', '9.0', '°C'],
      ['Using', '1.2', 'kW'],
      ['Mode', 'Heating', undefined],
    ]);
    expect(card.moreReadings).toBe(4);
    expect(card.actions.map((a) => [a.key, a.proposed.tier, a.proposed.limits ?? null])).toEqual([
      ['room_setpoint', 'ask', { min: 12, max: 28, step: 0.5 }],
      ['hot_water_boost', 'ask', null],
      ['heating_curve', 'off', { min: 1, max: 20 }],
      ['mode', 'ask', { choices: [1, 2] }],
    ]);
    expect(card.status).toBe('proposed');

    const ctx = { db: t.services.db, burrowId: t.burrowId, personId: IDS.mara, now: t.services.clock() };
    const things = await deviceThings(ctx);
    expect(things).toEqual([
      expect.objectContaining({
        id: `device:${proposalId}`,
        kind: 'device',
        status: 'learning',
        name: 'Heat pump',
      }),
    ]);
    const needs = await deviceNeedsYou(ctx);
    expect(needs[0]).toMatchObject({ kind: 'device_skill', title: 'What may I change on the heat pump?' });
  });
});

describe('switching it on (ONE-18)', () => {
  it('switches it on only with choices that fit the device', async () => {
    const wrong = await rest('POST', `/device-skills/${proposalId}/decide`, IDS.mara, {
      actions: { hot_water_boost: { tier: 'can', limits: { min: 1, max: 3 } } },
      switchOn: true,
    });
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(wrong.body)).toMatch(/Hot water boost has no range/);
    expect(
      await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.catalogId, 'device')),
    ).toHaveLength(0);
  });

  it('Switch on makes the device connection with the person’s tiers and limits', async () => {
    const res = await rest('POST', `/device-skills/${proposalId}/decide`, IDS.mara, {
      actions: {
        room_setpoint: { tier: 'can', limits: { min: 16, max: 24 } },
        hot_water_boost: { tier: 'ask' },
        heating_curve: { tier: 'can' },
      },
      switchOn: true,
    });
    expect(res.status).toBe(200);
    const card = res.body.card as DeviceSkillCard;
    expect(card.status).toBe('on');
    expect(card.decided?.mode).toEqual({ tier: 'off' });
    connectionId = res.body.connectionId as string;
    const [conn] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    expect(conn).toMatchObject({
      catalogId: 'device',
      label: 'Heat pump',
      handle: 'heat-pump',
    });
    slug = conn?.fields.slug ?? '';
    expect(slug).toBe('heat_pump');
    const tools = await t.services.db
      .select()
      .from(connectionTools)
      .where(eq(connectionTools.connectionId, connectionId))
      .orderBy(connectionTools.position);
    expect(tools.map((x) => [x.name, x.access, x.tier, x.origin, x.limits])).toEqual([
      [`${slug}_read`, 'read', 'can', 'device', null],
      [`${slug}_room_setpoint`, 'write', 'can', 'device', { args: { '/value': { min: 16, max: 24 } } }],
      [`${slug}_hot_water_boost`, 'write', 'ask', 'device', null],
      [`${slug}_heating_curve`, 'write', 'can', 'device-sensitive', null],
      [`${slug}_mode`, 'write', 'off', 'device', null],
    ]);
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'device_skill.switched_on'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(event?.text).toBe(
      'Switched on the heat pump: room temperature Allowed (only between 16 and 24 °C) · hot water boost Ask me · heating curve Allowed · mode Off',
    );
    expect(writes()).toHaveLength(0);
  });
});

describe('using it within the limits', () => {
  let changeId = '';

  it('a write within the limits goes through and records a change with Undo', async () => {
    const { mcp } = await turn(whombat.agentId, whombat.dmId);
    const res = await mcp.call('connection_call', {
      connection: 'heat-pump',
      tool: `${slug}_room_setpoint`,
      arguments: { value: 21.5 },
    });
    expect(res.body).toMatchObject({
      status: 'ok',
      isError: false,
      content: 'Set the heat pump’s room temperature to 21.5 °C.',
    });
    expect(fake.tables.holding[100]).toBe(215);
    const [change] = await t.services.db.select().from(changes).where(eq(changes.kind, 'device.action'));
    expect(change).toMatchObject({
      title: 'Set the heat pump’s room temperature to 21.5 °C',
      detail: '20.0 °C → 21.5 °C',
      agentId: whombat.agentId,
      subjectKind: 'device',
      subjectId: connectionId,
      undoKind: 'device.set',
    });
    changeId = change?.id ?? '';
    await mcp.close();
  });

  it('a write never goes to another device than the one its connection was checked for', async () => {
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    if (!row) throw new Error('no connection');
    const before = writes().length;
    // The connection as a call checked it before another skill (another device at that address) was switched on, or
    // before the device was given another address: the skill read again now isn't that one, so nothing is sent.
    const since: Record<string, string>[] = [
      { skillId: 'dsk_switched_since' },
      { host: '192.168.91.43' },
      { port: '5020' },
    ];
    for (const fields of since) {
      await expect(
        runDeviceTool(
          t.services,
          { ...row, fields: { ...row.fields, ...fields } },
          { name: `${slug}_room_setpoint` },
          {
            value: 21,
          },
          {
            burrowId: t.burrowId,
            agentId: whombat.agentId,
            callId: `call_device_changed_${Object.keys(fields)[0]}`,
          },
        ),
      ).rejects.toBeInstanceOf(ConnectionChangedError);
    }
    expect(writes()).toHaveLength(before);
    expect(fake.tables.holding[100]).toBe(215);
  });

  it('a write outside the limits is refused before anything is signed or sent', async () => {
    const before = writes().length;
    const signed = (await t.services.db.select().from(events)).length;
    const { mcp } = await turn(whombat.agentId, whombat.dmId);
    const res = await mcp.call('connection_call', {
      connection: 'heat-pump',
      tool: `${slug}_room_setpoint`,
      arguments: { value: 26 },
    });
    expect(res.body).toEqual({
      status: 'blocked',
      eventId: null,
      message: 'Room temperature is limited to 16–24 °C, so 26 °C wasn’t sent.',
    });
    expect(writes()).toHaveLength(before);
    expect((await t.services.db.select().from(events)).length).toBe(signed);
    expect(fake.tables.holding[100]).toBe(215);
    await mcp.close();
  });

  it('reads the device, asks for Ask me, refuses Off, and a sensitive action always asks', async () => {
    const { mcp } = await turn(whombat.agentId, whombat.dmId);
    const read = await mcp.call('connection_call', {
      connection: 'heat-pump',
      tool: `${slug}_read`,
      arguments: {},
    });
    expect(read.body.status).toBe('ok');
    expect((read.body.structured as { values: Record<string, unknown> }).values).toMatchObject({
      room: 21,
      flow: 34,
      mode: 1,
      defrost: false,
    });
    expect(read.body.content).toMatch(/Mode: Heating/);

    const boost = await mcp.call('connection_call', {
      connection: 'heat-pump',
      tool: `${slug}_hot_water_boost`,
      arguments: { value: true },
    });
    expect(boost.body.status).toBe('pending_approval');
    const curve = await mcp.call('connection_call', {
      connection: 'heat-pump',
      tool: `${slug}_heating_curve`,
      arguments: { value: 9 },
    });
    expect(curve.body.status).toBe('pending_approval');
    const mode = await mcp.call('connection_call', {
      connection: 'heat-pump',
      tool: `${slug}_mode`,
      arguments: { value: 2 },
    });
    expect(mode.body.status).toBe('blocked');
    expect(fake.tables.coil[0]).toBe(false);
    expect(fake.tables.holding[101]).toBe(7);
    const pending = await t.services.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.burrowId, t.burrowId), eq(approvals.state, 'pending')));
    expect(
      pending.filter((a) => (a.action as { type?: string }).type === 'connection_call').length,
    ).toBeGreaterThanOrEqual(2);
    await mcp.close();
  });

  it('keeps the last reading for Home: the thing is ok with its facts', async () => {
    expect(await readDevicesNow(t.services, t.burrowId)).toBe(1);
    const things = await deviceThings({
      db: t.services.db,
      burrowId: t.burrowId,
      personId: IDS.mara,
      now: t.services.clock(),
    });
    expect(things).toEqual([
      expect.objectContaining({
        id: `device:${connectionId}`,
        status: 'ok',
        line: '21.0 °C · 34 °C',
        facts: [
          { label: 'Room', value: '21.0', unit: '°C' },
          { label: 'Water to radiators', value: '34', unit: '°C' },
          { label: 'Hot water', value: '48', unit: '°C' },
          { label: 'Outside', value: '9.0', unit: '°C' },
        ],
      }),
    ]);
    // When it last worked (home-redesign.md HR-45): the newer of this reading and the write through it before.
    const [skill] = await t.services.db
      .select()
      .from(deviceSkills)
      .where(eq(deviceSkills.connectionId, connectionId));
    const [device] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    expect(device?.lastWorkedAt).toBeInstanceOf(Date);
    expect(skill?.lastReadAt?.getTime()).toBeGreaterThanOrEqual(device?.lastWorkedAt?.getTime() ?? 0);
    expect(things[0]).toMatchObject({ usedAt: skill?.lastReadAt?.toISOString() });
  });

  it('a device that stops answering shows on Watch until it answers again', async () => {
    fake.knobs.silent = true;
    // The silent device runs out a short deadline instead of the 3 s one (TS-S10).
    const net = vaultNetOf(t.services);
    useVaultNetForTests(t.services, { ...net, deviceTimeoutMs: 300 });
    try {
      expect(await readDevicesNow(t.services, t.burrowId)).toBe(0);
    } finally {
      fake.knobs.silent = false;
      useVaultNetForTests(t.services, net);
    }
    const ctx = { db: t.services.db, burrowId: t.burrowId, personId: IDS.mara, now: t.services.clock() };
    expect(await deviceWatch(ctx)).toEqual([
      expect.objectContaining({
        id: `device:${connectionId}`,
        severity: 'bad',
        title: 'The heat pump isn’t answering',
        body: 'The device didn’t answer in time.',
      }),
    ]);
    expect((await deviceThings(ctx))[0]).toMatchObject({ status: 'offline', line: 'Not answering' });
    expect(await readDevicesNow(t.services, t.burrowId)).toBe(1);
    expect(await deviceWatch(ctx)).toEqual([]);
  });

  it('Undo puts the old value back as a new call and marks the change undone', async () => {
    const [row] = await t.services.db.select().from(changes).where(eq(changes.id, changeId));
    const change = row ? openChange(t.services.custody, row) : null;
    expect(change?.undo.payload).toMatchObject({ value: 20, setTo: 21.5 });
    if (!change) throw new Error('no change');
    await undoDeviceChange(t.services, change, IDS.mara);
    expect(fake.tables.holding[100]).toBe(200);
    const [after] = await t.services.db.select().from(changes).where(eq(changes.id, changeId));
    expect(after?.undoneAt).not.toBeNull();
    expect(after?.undoneById).toBe(IDS.mara);
  });

  it('Undo leaves a value someone changed since, and says so', async () => {
    const { mcp } = await turn(whombat.agentId, whombat.dmId);
    await mcp.call('connection_call', {
      connection: 'heat-pump',
      tool: `${slug}_room_setpoint`,
      arguments: { value: 22 },
    });
    await mcp.close();
    const [row] = await t.services.db
      .select()
      .from(changes)
      .where(eq(changes.title, 'Set the heat pump’s room temperature to 22.0 °C'));
    const change = row ? openChange(t.services.custody, row) : null;
    if (!change) throw new Error('no change');
    fake.tables.holding[100] = 230; // someone turned it up at the unit
    await undoDeviceChange(t.services, change, IDS.mara);
    expect(fake.tables.holding[100]).toBe(230);
    const [said] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, whombat.dmId))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    expect(said?.text).toBe(
      'The heat pump’s room temperature was changed again since, so I left it as it is.',
    );
  });

  it('Undo puts the old value back only where the change went', async () => {
    fake.tables.holding[100] = 200;
    const { mcp } = await turn(whombat.agentId, whombat.dmId);
    await mcp.call('connection_call', {
      connection: 'heat-pump',
      tool: `${slug}_room_setpoint`,
      arguments: { value: 23 },
    });
    await mcp.close();
    expect(fake.tables.holding[100]).toBe(230);
    const [row] = await t.services.db
      .select()
      .from(changes)
      .where(eq(changes.title, 'Set the heat pump’s room temperature to 23.0 °C'));
    const change = row ? openChange(t.services.custody, row) : null;
    if (!row || !change) throw new Error('no change');
    expect(change.undo.payload).toMatchObject({ connectionId, destination: expect.any(String) });
    const [conn] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    if (!conn) throw new Error('no connection');
    // The connection goes elsewhere since (another address, another device's skill): Undo refuses, nothing is sent.
    await t.services.db
      .update(catalogConnections)
      .set({ baseUrl: `${conn.baseUrl}/elsewhere` })
      .where(eq(catalogConnections.id, connectionId));
    try {
      const sent = writes().length;
      const [mara] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
      if (!mara) throw new Error('no person');
      await expect(undoChange(t.services, mara, row.id)).rejects.toMatchObject({
        code: 'conflict',
        message: expect.stringContaining('changed since, so this can’t be undone here'),
      });
      // The Undo already under way when it changed says so in the chat, and sends nothing either.
      await undoDeviceChange(t.services, change, IDS.mara);
      const [said] = await t.services.db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, whombat.dmId))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      expect(said?.text).toContain('changed since, so this can’t be undone here');
      expect(writes()).toHaveLength(sent);
      expect(fake.tables.holding[100]).toBe(230);
    } finally {
      await t.services.db
        .update(catalogConnections)
        .set({ baseUrl: conn.baseUrl })
        .where(eq(catalogConnections.id, connectionId));
    }
  });

  it('the person narrows the limits through REST, and the next call keeps to them', async () => {
    const res = await rest(
      'POST',
      `/connections/${connectionId}/tools/${slug}_room_setpoint/limits`,
      IDS.mara,
      {
        limits: { args: { '/value': { min: 18, max: 22, step: 0.5 } } },
      },
    );
    expect(res.status).toBe(200);
    const view = (res.body.tools as { name: string; limits?: unknown }[]).find(
      (x) => x.name === `${slug}_room_setpoint`,
    );
    expect(view?.limits).toEqual({ args: { '/value': { min: 18, max: 22, step: 0.5 } } });
    const { mcp } = await turn(whombat.agentId, whombat.dmId);
    const res2 = await mcp.call('connection_call', {
      connection: 'heat-pump',
      tool: `${slug}_room_setpoint`,
      arguments: { value: 23 },
    });
    expect(res2.body.message).toBe('Room temperature is limited to 18–22 °C, so 23 °C wasn’t sent.');
    await mcp.close();
  });
});

describe('a rewritten profile starts again (ONE-18)', () => {
  it('a new proposal for the same device leaves the live one until it is switched on, keeping the connection', async () => {
    const { mcp } = await turn(whombat.agentId, whombat.dmId);
    const res = await mcp.call('propose_device_skill', {
      profile: { ...PROFILE, actions: PROFILE.actions?.slice(0, 2) },
      host: HOST,
      port: fake.port,
    });
    await mcp.close();
    const second = res.body.proposalId as string;
    const [proposed] = await t.services.db.select().from(deviceSkills).where(eq(deviceSkills.id, second));
    const [message] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, proposed?.messageId ?? ''));
    expect((message?.card as DeviceSkillCard | undefined)?.actions.map((a) => a.proposed.tier)).toEqual([
      'ask',
      'ask',
    ]);
    // The live skill stays on until the new one is switched on.
    const [live] = await t.services.db.select().from(deviceSkills).where(eq(deviceSkills.id, proposalId));
    expect(live?.status).toBe('on');
    const on = await rest('POST', `/device-skills/${second}/decide`, IDS.mara, {
      actions: { room_setpoint: { tier: 'ask' } },
      switchOn: true,
    });
    expect(on.body.connectionId).toBe(connectionId);
    const [old] = await t.services.db.select().from(deviceSkills).where(eq(deviceSkills.id, proposalId));
    expect(old?.status).toBe('replaced');
    const tools = await t.services.db
      .select()
      .from(connectionTools)
      .where(eq(connectionTools.connectionId, connectionId));
    expect(tools.map((x) => x.name).sort()).toEqual([
      `${slug}_hot_water_boost`,
      `${slug}_read`,
      `${slug}_room_setpoint`,
    ]);
    expect(tools.find((x) => x.name === `${slug}_room_setpoint`)).toMatchObject({
      tier: 'ask',
      limits: null,
    });
  });
});

describe('a local HTTP/JSON device', () => {
  const profile: DeviceProfileInput = {
    name: 'Solar inverter',
    driver: 'http_json',
    readings: [
      {
        key: 'power',
        label: 'Solar',
        unit: 'W',
        http: { method: 'GET', path: '/api/status', pointer: '/pv/power' },
      },
      { key: 'mode', label: 'Mode', http: { method: 'GET', path: '/api/status', pointer: '/mode' } },
      {
        key: 'exporting',
        label: 'Exporting',
        http: { method: 'GET', path: '/api/status', pointer: '/grid/exporting' },
      },
      // The action's current value (and its unit: contracts 0.80 give an action none).
      {
        key: 'export_limit',
        label: 'Export limit',
        unit: 'W',
        http: { method: 'GET', path: '/api/status', pointer: '/grid/limit' },
      },
    ],
    actions: [
      {
        key: 'export_limit',
        label: 'Export limit',
        description: 'The most power it sends to the grid.',
        http: { method: 'POST', path: '/api/limit', body: { unit: 'W' }, valuePointer: '/limit' },
        valueType: 'number',
        min: 0,
        max: 5000,
      },
    ],
  };

  it('reads it with one request per path, proposes it, and writes within the limits only', async () => {
    const { mcp } = await turn(whombat.agentId, whombat.dmId);
    const probe = await mcp.call('device_probe', {
      driver: 'http_json',
      host: INVERTER,
      port: inverterPort,
      readings: profile.readings,
    });
    expect((probe.body.readings as { key: string; value: unknown }[]).map((r) => [r.key, r.value])).toEqual([
      ['power', 1234.5],
      ['mode', 'auto'],
      ['exporting', true],
      ['export_limit', 5000],
    ]);
    expect(inverterSeen.filter((r) => r.url === '/api/status')).toHaveLength(1);
    const proposed = await mcp.call('propose_device_skill', { profile, host: INVERTER, port: inverterPort });
    expect(proposed.body.status).toBe('ok');
    await mcp.close();
    const id = proposed.body.proposalId as string;
    const [row] = await t.services.db.select().from(deviceSkills).where(eq(deviceSkills.id, id));
    const [message] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, row?.messageId ?? ''));
    expect(
      (message?.card as DeviceSkillCard | undefined)?.readings.map((r) => [r.label, r.value, r.unit]),
    ).toEqual([
      ['Solar', '1234.5', 'W'],
      ['Mode', 'auto', undefined],
      ['Exporting', 'On', undefined],
      ['Export limit', '5000', 'W'],
    ]);
    const on = await rest('POST', `/device-skills/${id}/decide`, IDS.mara, {
      actions: { export_limit: { tier: 'can', limits: { max: 3000 } } },
      switchOn: true,
    });
    expect(on.status).toBe(200);
    expect(inverterSeen.some((r) => r.method === 'POST')).toBe(false);

    const again = await turn(whombat.agentId, whombat.dmId);
    const ok = await again.mcp.call('connection_call', {
      connection: 'solar-inverter',
      tool: 'solar_inverter_export_limit',
      arguments: { value: 2500 },
    });
    expect(ok.body).toMatchObject({
      status: 'ok',
      content: 'Set the solar inverter’s export limit to 2500 W.',
    });
    expect(inverterSeen.filter((r) => r.method === 'POST').map((r) => [r.url, JSON.parse(r.body)])).toEqual([
      ['/api/limit', { unit: 'W', limit: 2500 }],
    ]);
    const over = await again.mcp.call('connection_call', {
      connection: 'solar-inverter',
      tool: 'solar_inverter_export_limit',
      arguments: { value: 4000 },
    });
    expect(over.body.message).toBe('Export limit is limited to 3000 W or less, so 4000 W wasn’t sent.');
    expect(inverterSeen.filter((r) => r.method === 'POST')).toHaveLength(1);
    await again.mcp.close();
  });
});

describe('removing a device', () => {
  it('turns its skill off and stops reading it', async () => {
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const res = await t.api.inject({
      method: 'DELETE',
      url: `/api/v1/burrows/burrow-hq/connections/${connectionId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const live = await t.services.db
      .select()
      .from(deviceSkills)
      .where(and(eq(deviceSkills.burrowId, t.burrowId), eq(deviceSkills.host, HOST)));
    expect(live.every((r) => r.status !== 'on')).toBe(true);
    const things = await deviceThings({
      db: t.services.db,
      burrowId: t.burrowId,
      personId: IDS.mara,
      now: t.services.clock(),
    });
    expect(things.map((x) => x.name)).toEqual(['Solar inverter']);
  });
});
