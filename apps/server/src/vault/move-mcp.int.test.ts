/**
 * The Vault's MCP entries move to Custom MCP server connections at start (docs/decisions/vault-simplify.md VLT-30):
 * address, sign-in, secret (sealed again for the connection) and tool switches; the entry goes. One that can't move — a
 * sign-in Custom MCP server lacks, the 50-connection limit — stays working and its read says “Move it to Connections”.
 * Running it again moves nothing twice. Postgres: the move is a commit through the pipeline.
 */
import { CONNECTIONS_MAX } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openConnectionSecret } from '../connections/crypto';
import { catalogConnections, connectionTools, events, vaultEntries, vaultTools } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { insertConnection } from '../test/connections';
import { useTestServer } from '../test/harness';
import { createVaultEntry, takeVaultKey } from './commands';
import { moveMcpEntries } from './move-mcp';
import { entryViews } from './store';

const t = useTestServer({ seed: true });
const TOKEN = 'ha-long-lived-token-7c1e';
const HEADER = 'gateway-key-41b9';

async function made(input: Record<string, unknown>): Promise<string> {
  const res = await t.commit(IDS.mara, createVaultEntry, input as never);
  if (res.status !== 'ok') throw new Error('entry not made');
  return res.result.entryId;
}

async function tools(entryId: string, list: { name: string; enabled: boolean }[]) {
  await t.services.db.insert(vaultTools).values(
    list.map((tool, position) => ({
      entryId,
      name: tool.name,
      description: `${tool.name} does a thing`,
      inputSchema: { type: 'object' },
      hash: `h-${tool.name}`,
      enabled: tool.enabled,
      isNew: false,
      mcpName: `vt_x__${tool.name}`,
      position,
    })),
  );
}

const entry = async (id: string) =>
  (await t.services.db.select().from(vaultEntries).where(eq(vaultEntries.id, id)))[0];
const connectionNamed = async (label: string) =>
  (
    await t.services.db
      .select()
      .from(catalogConnections)
      .where(and(eq(catalogConnections.burrowId, t.burrowId), eq(catalogConnections.label, label)))
  )[0];
const toolTiers = async (connectionId: string) =>
  (await t.services.db.select().from(connectionTools).where(eq(connectionTools.connectionId, connectionId)))
    .map((r) => [r.name, r.tier])
    .sort();

describe('moving MCP entries to Connections (VLT-30)', () => {
  let ha = '';
  let gateway = '';
  let open = '';
  let basic = '';

  it('moves each entry with its address, sign-in, secret and tool switches, and removes it', async () => {
    ha = await made({
      kind: 'mcp',
      name: 'House',
      url: 'https://ha.example.com/api/mcp',
      auth: { type: 'bearer' },
      secret: TOKEN,
    });
    await tools(ha, [
      { name: 'HassTurnOn', enabled: true },
      { name: 'HassUnlock', enabled: false },
    ]);
    gateway = await made({
      kind: 'mcp',
      name: 'Gateway',
      url: 'https://gw.example.com/mcp',
      auth: { type: 'header', name: 'X-Api-Key' },
      secret: HEADER,
    });
    await tools(gateway, [{ name: 'search', enabled: true }]);
    // Switched off for the agent: its tools move off.
    expect((await t.commit(IDS.mara, takeVaultKey, { entryId: gateway })).status).toBe('ok');
    open = await made({
      kind: 'mcp',
      name: 'Open server',
      url: 'https://open.example.com/mcp',
      auth: { type: 'none' },
    });
    basic = await made({
      kind: 'mcp',
      name: 'Old printer',
      url: 'https://printer.example.com/mcp',
      auth: { type: 'bearer' },
      secret: 'printer-pass',
    });
    // Basic auth, which only an older Whombat could save for an MCP server.
    await t.services.db
      .update(vaultEntries)
      .set({ auth: { type: 'basic', username: 'admin' } })
      .where(eq(vaultEntries.id, basic));

    const result = await moveMcpEntries(t.services, { readTools: false });
    expect(result.moved).toBeGreaterThanOrEqual(3);

    const house = await connectionNamed('House');
    expect(house).toMatchObject({
      catalogId: 'custom_mcp',
      signIn: 'token',
      auth: { type: 'bearer' },
      baseUrl: 'https://ha.example.com/api/mcp',
      fields: { url: 'https://ha.example.com/api/mcp' },
      connectedById: IDS.mara,
      access: 'manage',
    });
    expect(
      openConnectionSecret(t.services.custody, house?.id as string, 'secret', house?.secretEnc as string),
    ).toBe(TOKEN);
    expect(await toolTiers(house?.id as string)).toEqual([
      ['HassTurnOn', 'can'],
      ['HassUnlock', 'off'],
    ]);
    const gw = await connectionNamed('Gateway');
    expect(gw?.auth).toEqual({ type: 'header', name: 'X-Api-Key', template: '{secret}' });
    expect(
      openConnectionSecret(t.services.custody, gw?.id as string, 'secret', gw?.secretEnc as string),
    ).toBe(HEADER);
    expect(await toolTiers(gw?.id as string)).toEqual([['search', 'off']]);
    expect(await connectionNamed('Open server')).toMatchObject({
      signIn: 'none',
      auth: null,
      secretEnc: null,
    });

    // The entries are gone, signed; the one that couldn't move stays and says so.
    for (const id of [ha, gateway, open]) expect(await entry(id)).toBeUndefined();
    const removed = await t.services.db.select().from(events).where(eq(events.type, 'vault.entry.removed'));
    expect(removed.map((e) => (e.payload as { entryId: string }).entryId)).toEqual(
      expect.arrayContaining([ha, gateway, open]),
    );
    const added = await t.services.db.select().from(events).where(eq(events.type, 'connection.added'));
    expect(added.some((e) => (e.payload as { connectionId: string }).connectionId === house?.id)).toBe(true);
    const kept = await entry(basic);
    expect(kept).toBeTruthy();
    const [view] = await entryViews(t.services.db, [kept as NonNullable<typeof kept>]);
    expect(view?.moveToConnections).toBe(true);
    // No value in what was signed.
    for (const e of [...removed, ...added])
      expect(JSON.stringify(e)).not.toMatch(new RegExp(`${TOKEN}|${HEADER}`));
  });

  it('moves nothing twice', async () => {
    const before = (await t.services.db.select().from(catalogConnections)).length;
    expect(await moveMcpEntries(t.services, { readTools: false })).toMatchObject({ moved: 0 });
    expect((await t.services.db.select().from(catalogConnections)).length).toBe(before);
  });

  it('stays at the 50-connection limit, and moves once there is room', async () => {
    const full = await made({
      kind: 'mcp',
      name: 'Late server',
      url: 'https://late.example.com/mcp',
      auth: { type: 'bearer' },
      secret: 'late-token',
    });
    const have = (
      await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.burrowId, t.burrowId))
    ).length;
    const filler: string[] = [];
    for (let i = have; i < CONNECTIONS_MAX; i++)
      filler.push(
        await insertConnection(t.services, {
          catalogId: 'custom_mcp',
          burrowId: t.burrowId,
          label: `Filler ${i}`,
          handle: `filler-${i}`,
          signIn: 'none',
          auth: null,
          fields: { url: `https://filler-${i}.example.com/mcp` },
        }),
      );
    await moveMcpEntries(t.services, { readTools: false });
    expect(await entry(full)).toBeTruthy();
    expect(await connectionNamed('Late server')).toBeUndefined();
    await t.services.db.delete(catalogConnections).where(eq(catalogConnections.id, filler[0] as string));
    await moveMcpEntries(t.services, { readTools: false });
    expect(await entry(full)).toBeUndefined();
    expect(await connectionNamed('Late server')).toBeTruthy();
  });
});
