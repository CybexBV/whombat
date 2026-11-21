/**
 * The Vault over REST against a real Postgres (docs/decisions/vault.md): entries, secrets, checks and tools, keys,
 * RECENT USE, the home network list and its file for the appliance, the destination rules at save time, and the audit
 * log.
 */
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { burrows, events, vaultEntries, vaultTools } from '../db/schema/index';
import { useTestServer } from '../test/harness';
import { HA_TOKEN, HOSTS, useVaultWorld } from './testing/world';

const NETWORKS_FILE = join(tmpdir(), `whombat-vault-networks-${process.pid}-${Date.now()}.json`);
// The local network closed (`off`): only the home network list opens private addresses, unless a case opens it.
const t = useTestServer({
  seed: true,
  app: true,
  env: { WHOMBAT_VAULT_NETWORKS_FILE: NETWORKS_FILE, WHOMBAT_LOCAL_NETWORK: 'off' },
});
const w = useVaultWorld(t);

let haId = '';
let apiId = '';

afterAll(() => rmSync(NETWORKS_FILE, { force: true }));

describe('the home network list (VT-12, VT-59)', () => {
  it('is read and changed by the person, and written to the appliance file', async () => {
    await w.listHomeNetwork();
    const seen = await w.call(api.vaultNetworks.list, {}, undefined, 'mara');
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({
      max: 32,
      networks: [{ cidr: '192.168.77.0/24', note: 'The fakes', addedBy: 'Mara Okafor' }],
    });
    const file = JSON.parse(readFileSync(NETWORKS_FILE, 'utf8'));
    expect(file).toEqual({
      version: 1,
      networks: [{ cidr: '192.168.77.0/24', ports: [w.ha.port, w.api.port].sort((a, b) => a - b) }],
    });
    // Not a signed burrow event (it belongs to no burrow).
    const signed = await t.services.db.select().from(events).where(eq(events.burrowId, t.burrowId));
    expect(JSON.stringify(signed)).not.toContain('192.168.77.0');
  });

  it('refuses every never-listable range, too-wide networks and duplicates', async () => {
    for (const cidr of [
      '127.0.0.0/8',
      '127.0.0.1',
      '169.254.0.0/16',
      '169.254.169.254',
      '100.100.0.0/16',
      '10.0.0.0/8',
      '8.8.8.0/24',
      '224.0.0.0/24',
      '0.0.0.0',
      '192.0.2.0/24',
      '::1',
      'fe80::/64',
      'fd00:ec2::/48',
      'fc00::/6',
      '::ffff:192.168.1.0/120',
      'not a network',
    ]) {
      const res = await w.call(api.vaultNetworks.add, {}, { cidr, ports: [443] }, 'mara');
      expect(res.status, cidr).toBe(400);
    }
    const ports = await w.call(api.vaultNetworks.add, {}, { cidr: '192.168.9.0/24', ports: [0] }, 'mara');
    expect(ports.status).toBe(400);
    const again = await w.call(
      api.vaultNetworks.add,
      {},
      { cidr: '192.168.77.7/24', ports: [w.ha.port] },
      'mara',
    );
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { details: { code: 'network_listed' } } });
  });

  it('removes a network and rewrites the file', async () => {
    await w.call(api.vaultNetworks.add, {}, { cidr: '10.20.0.0/16', ports: [80, 22] }, 'mara');
    const listed = await w.call(api.vaultNetworks.list, {}, undefined, 'mara');
    const net = (listed.body.networks as { id: string; cidr: string; ports: number[] }[]).find(
      (n) => n.cidr === '10.20.0.0/16',
    );
    expect(net?.ports).toEqual([22, 80]);
    expect(
      JSON.parse(readFileSync(NETWORKS_FILE, 'utf8')).networks.map((n: { cidr: string }) => n.cidr),
    ).toEqual(['10.20.0.0/16', '192.168.77.0/24']);
    expect(
      (await w.call(api.vaultNetworks.remove, { networkId: net?.id ?? '' }, undefined, 'mara')).status,
    ).toBe(200);
    expect(JSON.parse(readFileSync(NETWORKS_FILE, 'utf8')).networks).toHaveLength(1);
  });
});

describe('entries (VT-01…VT-04, VT-13)', () => {
  it('adds an MCP entry: sealed, never returned, a neutral signed event', async () => {
    const res = await w.call(
      api.vault.create,
      {},
      {
        name: 'Home Assistant',
        description: 'The house: lights and heating.',
        kind: 'mcp',
        url: w.haUrl(),
        auth: { type: 'bearer' },
        secret: HA_TOKEN,
      },
    );
    expect(res.status).toBe(201);
    expect(res.raw).not.toContain(HA_TOKEN);
    const entry = res.body.entry as Record<string, unknown>;
    haId = String(entry.id);
    expect(entry).toMatchObject({
      name: 'Home Assistant',
      kind: 'mcp',
      secret: { set: true },
      check: { status: 'unchecked' },
      // Switched on for the agent the moment it is saved (vault-self-serve.md VS-01, one-agent.md OA-09).
      agentOn: true,
      key: expect.objectContaining({ envName: null }),
      tools: [],
    });
    const [row] = await t.services.db.select().from(vaultEntries).where(eq(vaultEntries.id, haId));
    expect(row?.sealed).toBeTruthy();
    expect(row?.sealed).not.toContain(HA_TOKEN);
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.id, String(res.body.eventId)));
    expect(event).toMatchObject({
      type: 'vault.entry.added',
      kind: 'Vault',
      text: 'Added a private Vault entry',
    });
    expect(JSON.stringify(event)).not.toContain('Home Assistant');
    expect(Object.keys(event?.payload ?? {}).sort()).toEqual(['detail', 'entryId']);
  });

  it('reaches the whole local network where it is open (LN-01); the burrow’s switch closes it', async () => {
    const printer = {
      name: 'Printer',
      kind: 'http',
      url: 'http://printer.home.test:631',
      auth: { type: 'bearer' },
      secret: 's',
    } as const;
    const config = t.services.config;
    expect(config.WHOMBAT_LOCAL_NETWORK).toBe('off');
    // Off: only the list opens private addresses.
    expect((await w.call(api.vault.create, {}, printer)).status).toBe(403);
    config.WHOMBAT_LOCAL_NETWORK = 'on';
    try {
      const open = await w.call(api.vault.create, {}, printer);
      expect(open.status).toBe(201);
      await w.call(api.vault.remove, { entryId: String((open.body.entry as { id: string }).id) }, undefined);
      // Loopback and metadata stay closed.
      const loop = await w.call(
        api.vault.create,
        {},
        { ...printer, url: `http://loop.home.test:${w.api.port}` },
      );
      expect(loop.body).toMatchObject({ error: { details: { problem: 'never' } } });
      await t.services.db.update(burrows).set({ agentsReachLan: false }).where(eq(burrows.id, t.burrowId));
      const closed = await w.call(api.vault.create, {}, printer);
      expect(closed.body).toMatchObject({ error: { details: { problem: 'not_listed' } } });
    } finally {
      config.WHOMBAT_LOCAL_NETWORK = 'off';
      await t.services.db.update(burrows).set({ agentsReachLan: null }).where(eq(burrows.id, t.burrowId));
    }
  });

  it('adds an API entry, and refuses addresses the rules don’t allow, with the reason', async () => {
    const ok = await w.call(
      api.vault.create,
      {},
      {
        name: 'Energy API',
        kind: 'http',
        url: w.apiUrl(),
        auth: { type: 'bearer' },
        secret: 'energy-secret-1',
      },
    );
    expect(ok.status).toBe(201);
    apiId = String((ok.body.entry as { id: string }).id);

    const unlisted = await w.call(
      api.vault.create,
      {},
      {
        name: 'Printer',
        kind: 'http',
        url: 'http://printer.home.test:631',
        auth: { type: 'bearer' },
        secret: 's',
      },
    );
    expect(unlisted.status).toBe(403);
    expect(unlisted.body).toMatchObject({
      error: {
        details: {
          code: 'address_not_allowed',
          problem: 'not_listed',
          suggestion: { cidr: '192.168.78.0/24', port: 631 },
        },
      },
    });
    const cases: [string, string][] = [
      ['http://public.example/v1', 'http_public'],
      [`http://loop.home.test:${w.api.port}`, 'never'],
      [`http://meta.home.test:${w.api.port}`, 'never'],
      [`http://mixed.example:${w.api.port}`, 'mixed'],
      [`http://127.0.0.1:${w.api.port}`, 'never'],
      [`http://[::1]:${w.api.port}`, 'never'],
      ['https://nowhere.invalid', 'unresolved'],
    ];
    for (const [url, problem] of cases) {
      const res = await w.call(
        api.vault.create,
        {},
        { name: 'x', kind: 'http', url, auth: { type: 'bearer' }, secret: 's' },
      );
      expect(res.status, url).toBe(403);
      expect(res.body, url).toMatchObject({ error: { details: { code: 'address_not_allowed', problem } } });
    }
    // Not even an address: a validation error.
    const bad = await w.call(
      api.vault.create,
      {},
      {
        name: 'x',
        kind: 'http',
        url: 'http://user:pw@api.home.test/',
        auth: { type: 'bearer' },
        secret: 's',
      },
    );
    expect(bad.status).toBe(400);
  });

  it('checks an MCP entry: every tool on at first; a changed or new tool comes back off with “New”', async () => {
    const first = await w.call(api.vault.check, { entryId: haId }, undefined);
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({
      outcome: 'reached',
      status: 'reached',
      summary: 'Reached · 5 tools',
    });
    const tools = (first.body.entry as { tools: { name: string; enabled: boolean; isNew: boolean }[] }).tools;
    expect(tools.map((x) => [x.name, x.enabled, x.isNew])).toEqual([
      ['HassTurnOn', true, false],
      ['HassTurnOff', true, false],
      ['GetLiveContext', true, false],
      ['EchoRequest', true, false],
      ['Broken', true, false],
    ]);
    expect(first.raw).not.toContain(HA_TOKEN);

    // The person turns one off; the server changes another's definition and adds a new one.
    await w.call(api.vault.setTool, { entryId: haId, tool: 'HassTurnOff' }, { enabled: false });
    const before = [...w.ha.tools];
    w.ha.tools = before.map((x) =>
      x.name === 'GetLiveContext' ? { ...x, description: 'Now also returns the cameras.' } : x,
    );
    w.ha.tools.push({ name: 'HassCancelAllTimers', description: 'Cancels every timer.' });
    const second = await w.call(api.vault.check, { entryId: haId }, undefined);
    const after = (second.body.entry as { tools: { name: string; enabled: boolean; isNew: boolean }[] })
      .tools;
    const byName = Object.fromEntries(after.map((x) => [x.name, [x.enabled, x.isNew]]));
    expect(byName).toEqual({
      HassTurnOn: [true, false],
      HassTurnOff: [false, false],
      GetLiveContext: [false, true],
      EchoRequest: [true, false],
      Broken: [true, false],
      HassCancelAllTimers: [false, true],
    });
    // Turning a “New” tool on clears the badge; a tool the server no longer lists goes.
    const on = await w.call(api.vault.setTool, { entryId: haId, tool: 'GetLiveContext' }, { enabled: true });
    expect(on.body.eventId).toBeTruthy();
    w.ha.tools = before;
    const third = await w.call(api.vault.check, { entryId: haId }, undefined);
    const names = (third.body.entry as { tools: { name: string }[] }).tools.map((x) => x.name);
    expect(names).not.toContain('HassCancelAllTimers');
    // GetLiveContext's definition changed back: a changed tool never inherits “on”.
    const rows = await t.services.db.select().from(vaultTools).where(eq(vaultTools.entryId, haId));
    expect(rows.find((r) => r.name === 'GetLiveContext')).toMatchObject({ enabled: false, isNew: true });
    await w.call(api.vault.setTool, { entryId: haId, tool: 'GetLiveContext' }, { enabled: true });
  });

  it('checks an API entry by its answer, and reports a rejected secret without quoting it', async () => {
    const reached = await w.call(api.vault.check, { entryId: apiId }, undefined);
    // The fake wants API_TOKEN: this entry's secret is wrong.
    expect(reached.body.result).toMatchObject({
      outcome: 'rejected',
      status: 'failing',
      summary: 'The server rejected the secret (401).',
      httpStatus: 401,
    });
    expect(reached.raw).not.toContain('energy-secret-1');
    const replaced = await w.call(
      api.vault.setSecret,
      { entryId: apiId },
      { value: 'api-token-Zq8Wm3Rt5Yv7Ux9Np2Kd4Hf6' },
    );
    expect(replaced.status).toBe(200);
    expect(replaced.raw).not.toContain('api-token-Zq8Wm3Rt5Yv7Ux9Np2Kd4Hf6');
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.id, String(replaced.body.eventId)));
    expect(event?.text).toBe('Replaced the secret of a private Vault entry');
    const ok = await w.call(api.vault.check, { entryId: apiId }, undefined);
    expect(ok.body.result).toMatchObject({
      outcome: 'reached',
      summary: 'Reached · answered 200',
      httpStatus: 200,
    });
  });

  it('refuses a new address that isn’t allowed, and resets the check when it changes', async () => {
    const refused = await w.call(
      api.vault.update,
      { entryId: apiId },
      { url: 'http://printer.home.test:631/v1' },
    );
    expect(refused.status).toBe(403);
    const renamed = await w.call(
      api.vault.update,
      { entryId: apiId },
      { name: 'Energy', description: 'kWh per day' },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.entry).toMatchObject({ name: 'Energy', check: { status: 'reached' } });
    const same = await w.call(api.vault.update, { entryId: apiId }, { name: 'Energy' });
    expect(same.body.eventId).toBeNull();
    const moved = await w.call(api.vault.update, { entryId: apiId }, { url: w.apiUrl('/v1/') });
    expect(moved.body.entry).toMatchObject({ check: { status: 'unchecked', summary: '' } });
  });
});

describe('keys (VT-20, VT-21)', () => {
  it('takes a key back once; a pass from before stays where it was, counting for nothing (HE-43, HE-45)', async () => {
    await w.call(api.vault.giveKey, { entryId: haId, agent: 'dusty' }, {});
    const taken = await w.call(api.vault.takeKey, { entryId: haId, agent: 'dusty' }, undefined);
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.id, String(taken.body.eventId)));
    expect(event?.text).toContain('Switched off a private Vault entry');
    expect(
      (await w.call(api.vault.takeKey, { entryId: haId, agent: 'dusty' }, undefined)).body.eventId,
    ).toBeNull();
  });
});

describe('the audit log (VT-51, VT-52)', () => {
  it('the audit log signs neutral lines and tells the person which entry (VT-51, VT-52, OP-S61)', async () => {
    const list = await w.call(api.audit.list, {}, undefined, 'mara', { kind: 'vault', limit: 50 });
    const listed = list.body.events as {
      id: string;
      type: string;
      text: string;
      vault?: { entryName: string };
    }[];
    expect(listed.length).toBeGreaterThan(3);
    const added = listed.find((e) => e.type === 'vault.entry.added');
    expect(added?.vault?.entryName).toBeTruthy();
    expect(added?.text).not.toContain(added?.vault?.entryName ?? '');
    expect((list.body.counts as { vault: number }).vault).toBeGreaterThan(3);
    const get = await w.call(api.audit.get, { eventId: String(added?.id) }, undefined, 'mara');
    expect(get.raw).toContain('"vault":{');
    const csv = await w.call(api.audit.export, {}, undefined, 'mara', { kind: 'vault' });
    expect(csv.raw).toContain('Home Assistant');
  });
});

describe('removing (VT-06)', () => {
  it('removes an entry with its keys and tools; the neutral line stays', async () => {
    const extra = await w.call(
      api.vault.create,
      {},
      { name: 'Scratch', kind: 'mcp', url: w.haUrl(), auth: { type: 'none' } },
    );
    const id = String((extra.body.entry as { id: string }).id);
    await w.call(api.vault.check, { entryId: id }, undefined);
    await w.call(api.vault.giveKey, { entryId: id, agent: 'dusty' }, {});
    const removed = await w.call(api.vault.remove, { entryId: id }, undefined);
    expect(removed.body).toMatchObject({ ok: true });
    expect(await t.services.db.select().from(vaultEntries).where(eq(vaultEntries.id, id))).toEqual([]);
    expect(await t.services.db.select().from(vaultTools).where(eq(vaultTools.entryId, id))).toEqual([]);
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.id, String(removed.body.eventId)));
    expect(event?.text).toBe('Removed a private Vault entry');
    expect(HOSTS['ha.home.test']).toEqual(['192.168.77.10']);
  });
});
