/**
 * Agents using catalog connections through `/mcp` with real agent tokens (docs/decisions/connections-catalog.md
 * CX-03, CX-18, CX-20…CX-23, CX-30…CX-35): which agents see which connections and when the two tools are listed, tool
 * sync from a Home Assistant–like MCP server, reads at once, writes asking a person and running once after a yes,
 * sensitive calls and Off, the `request` tool's rules, the person's connections (in their turns, never an outsiders'
 * one; one-person.md OP-S51, OP-17),
 * a refreshed OAuth token after a 401, Nextcloud's files over WebDAV, and the instructions' one line per connection.
 *
 * Connections are inserted directly (the connect side's store is another stream); stubs stand behind home-network
 * addresses through the Vault's test seam.
 */
import type { DispatchContext } from '@whombat/core';
import { turnPrompt } from '@whombat/runner';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { startChat } from '../chats/commands';
import { decideApproval } from '../commands/approvals';
import {
  approvals,
  catalogConnections,
  connectionTools,
  dispatches,
  events,
  messages,
  notifications,
  vaultNetworks,
} from '../db/schema/index';
import { loadPrincipalRow } from '../read/principals';
import { approvalForViewer, approvalsForViewer } from '../read/work';
import { approvalList, inbox } from '../read/work-views';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { insertConnection, setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { accountOf, agentTokenFor, type TestDispatchOptions } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { signingOnlyAs } from './bound-targets';
import { callConnectionTool } from './call';
import { ConnectionChangedError, callTarget } from './call-target';
import { visibleConnections } from './context';
import { credentialFor } from './credentials';
import { sealConnectionSecret } from './crypto';
import { currentRow, signedConnectionFetch } from './http';
import { connectionsFor } from './pool';
import { refreshConnectionAccess } from './refresh';
import { syncTools } from './sync';
import {
  type DavStub,
  HOME_TOOLS,
  type HomeStub,
  type OAuthStub,
  stubDav,
  stubHome,
  stubOAuthMcp,
} from './testing/tool-stubs';

const t = useTestServer({ seed: true, listen: true });

const HA_TOKEN = 'ha-llat-Qm4Zx8Wc2Vb6Nn1Kd5Hf9';
const HOSTS: Record<string, string> = {
  'ha.home.test': '192.168.90.10',
  'ha2.home.test': '192.168.90.11',
  'oauth.home.test': '192.168.90.12',
  'cloud.home.test': '192.168.90.13',
  // Another address for the same stub: where a connection is repointed while a call bound to the first one waits.
  'oauth-other.home.test': '192.168.90.14',
};

let home: HomeStub;
let bare: HomeStub;
let oauth: OAuthStub;
let dav: DavStub;
let ha = '';
let mara = '';

async function turn(agentId: string, conversationId: string, options: TestDispatchOptions = {}) {
  // The person's turn unless a test says otherwise (one-person.md OP-S41).
  const d = await agentTokenFor(t.services, t.burrowId, agentId, conversationId, {
    onBehalfOfAccountId: mara,
    ...options,
  });
  return { ...d, mcp: await mcpClient(t.baseUrl, d.token) };
}

async function call(mcp: TestMcp, name: string, args: Record<string, unknown>) {
  const res = await mcp.client.callTool({ name, arguments: args });
  return { isError: res.isError === true, body: (res.structuredContent ?? {}) as Record<string, unknown> };
}

async function contextOf(dispatchId: string): Promise<DispatchContext> {
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!row) throw new Error('no dispatch');
  return buildDispatchContext(t.services, row);
}

const lastEvents = (type: string, n = 5) =>
  t.services.db.select().from(events).where(eq(events.type, type)).orderBy(desc(events.seq)).limit(n);

async function setTier(connectionId: string, tool: string, tier: 'can' | 'ask' | 'off') {
  await t.services.db
    .update(connectionTools)
    .set({ tier })
    .where(and(eq(connectionTools.connectionId, connectionId), eq(connectionTools.name, tool)));
}

beforeAll(async () => {
  home = await stubHome(HA_TOKEN);
  bare = await stubHome(HA_TOKEN, { mcpMissing: true });
  oauth = await stubOAuthMcp('fresh-token');
  dav = await stubDav('mara', 'app-pass-77Xq');
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      const address = HOSTS[host];
      if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address, family: 4 }];
    },
    dialAddress: (address) => (address.startsWith('192.168.90.') ? '127.0.0.1' : address),
    deadlineMs: 3000,
  });
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_connections_test',
    cidr: '192.168.90.0/24',
    ports: [home.port, bare.port, oauth.port, dav.port].sort((a, b) => a - b),
    note: 'Connection stubs',
    addedAt: t.services.clock(),
  });
  mara = await accountOf(t.services, IDS.mara);
  ha = await insertConnection(t.services, {
    catalogId: 'homeassistant',
    burrowId: t.burrowId,
    connectedById: IDS.mara,
    label: 'Home Assistant',
    fields: { url: `http://ha.home.test:${home.port}` },
    secret: HA_TOKEN,
  });
  await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'ask' });
  return async () => {
    await Promise.all([home.close(), bare.close(), oauth.close(), dav.close()]);
  };
});

describe('who sees which connections (CX-03, CX-30, CX-35)', () => {
  it('lists the two tools only while the agent holds a catalog key, never in a search answer', async () => {
    const held = await turn(IDS.dusty, IDS.billing, { onBehalfOfAccountId: mara });
    const names = (await held.mcp.client.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['connection_tools', 'connection_call']));
    await held.mcp.close();

    await setConnectionKeys(t.services, IDS.dusty, { read: 'cannot', write: 'cannot' });
    try {
      const none = await turn(IDS.dusty, IDS.billing);
      expect((await none.mcp.client.listTools()).tools.map((x) => x.name)).not.toContain('connection_call');
      // Not served, so not run either (outsiders-turns.md OT-07).
      const refused = await call(none.mcp, 'connection_tools', { connection: 'homeassistant' });
      expect(refused.body).toMatchObject({ error: { code: 'forbidden' } });
      await none.mcp.close();
    } finally {
      await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'ask' });
    }

    const answer = await turn(IDS.dusty, IDS.billing, { mode: 'answer' });
    expect((await answer.mcp.client.listTools()).tools.map((x) => x.name)).not.toContain('connection_tools');
    expect((await contextOf(answer.dispatchId)).connections).toBeUndefined();
    await answer.mcp.close();
  });

  it('names each connection on one line of the instructions', async () => {
    const dusty = await turn(IDS.dusty, IDS.billing);
    const ctx = await contextOf(dusty.dispatchId);
    expect(ctx.connections).toMatchObject([
      {
        handle: 'homeassistant',
        catalogId: 'homeassistant',
        name: 'Home Assistant',
        label: 'Home Assistant',
        status: 'active',
      },
    ]);
    expect(turnPrompt(ctx)).toContain('- homeassistant — Home Assistant');
    await dusty.mcp.close();
  });
});

describe('tools from the connection (CX-18, CX-30)', () => {
  it('syncs on first use: the server’s tools with access and tiers, and request next to them', async () => {
    const dusty = await turn(IDS.dusty, IDS.billing);
    const res = await call(dusty.mcp, 'connection_tools', { connection: 'homeassistant' });
    expect(res.body.status).toBe('ok');
    const tools = res.body.tools as { name: string; access: string; tier: string; sensitive: boolean }[];
    expect(tools.map((x) => [x.name, x.access, x.tier, x.sensitive])).toEqual([
      ['GetLiveContext', 'read', 'can', false],
      ['HassTurnOn', 'write', 'can', false],
      ['EraseEverything', 'write', 'can', true],
      ['request', 'write', 'can', false],
    ]);
    expect(String(res.body.guide)).toContain('Home Assistant’s REST API');
    // The token went as a bearer header, never anywhere an agent sees.
    expect(home.seen.some((s) => s.headers.authorization === `Bearer ${HA_TOKEN}`)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(HA_TOKEN);
    await dusty.mcp.close();
  });

  it('says how to add Home Assistant’s MCP integration when it is missing, and keeps request', async () => {
    const id = await insertConnection(t.services, {
      catalogId: 'homeassistant',
      burrowId: t.burrowId,
      label: 'Home Assistant · ha2',
      handle: 'homeassistant-2',
      fields: { url: `http://ha2.home.test:${bare.port}` },
      secret: HA_TOKEN,
    });
    const synced = await syncTools(t.services, id);
    expect(synced.count).toBe(1);
    expect(synced.checks).toEqual([
      {
        id: 'mcp',
        state: 'warning',
        message: expect.stringContaining('Model Context Protocol Server integration'),
      },
    ]);
  });

  it('turns Home Assistant’s MCP server on itself with an administrator’s token, and says why not otherwise', async () => {
    const id = await insertConnection(t.services, {
      catalogId: 'homeassistant',
      burrowId: t.burrowId,
      label: 'Home Assistant · ha2 setup',
      handle: 'homeassistant-3',
      fields: { url: `http://ha2.home.test:${bare.port}` },
      secret: HA_TOKEN,
    });
    try {
      bare.setup = 'user';
      const refused = await syncTools(t.services, id);
      expect(refused.count).toBe(1);
      expect(refused.checks).toEqual([
        {
          id: 'mcp',
          state: 'warning',
          message: expect.stringMatching(
            /^Whombat couldn’t add it: the token isn’t a Home Assistant administrator’s\. Add the Model Context Protocol Server integration/,
          ),
        },
      ]);
      expect(bare.mcpMissing).toBe(true);

      bare.setup = 'admin';
      const added = await syncTools(t.services, id);
      expect(bare.mcpMissing).toBe(false);
      expect(added.count).toBe(1 + HOME_TOOLS.length);
      // It works: the line says “Working” (CX-54b).
      expect(added.checks).toEqual([{ id: 'mcp', state: 'ok', message: null }]);
      // Every tool starts Allowed (CX-20a), and the server's first listing marks none New (CX-18a).
      const tiers = await t.services.db
        .select({ name: connectionTools.name, tier: connectionTools.tier, isNew: connectionTools.isNew })
        .from(connectionTools)
        .where(eq(connectionTools.connectionId, id));
      expect(new Set(tiers.map((r) => r.tier))).toEqual(new Set(['can']));
      expect(tiers.filter((r) => r.isNew)).toEqual([]);

      // Once it answers, the check says what agents see, and nothing is added again.
      const again = await syncTools(t.services, id);
      expect(again.checks).toEqual([{ id: 'mcp', state: 'ok', message: null }]);
    } finally {
      bare.mcpMissing = true;
      bare.setup = null;
      await t.services.db.delete(connectionTools).where(eq(connectionTools.connectionId, id));
      await t.services.db.delete(catalogConnections).where(eq(catalogConnections.id, id));
    }
  });
});

describe('calls and their tiers (CX-20, CX-21, CX-23, CX-31)', () => {
  it('runs a read at once and logs it without arguments or output', async () => {
    const dusty = await turn(IDS.dusty, IDS.billing);
    const res = await call(dusty.mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'GetLiveContext',
      arguments: { name: 'secret-kitchen' },
    });
    expect(res.body).toMatchObject({ status: 'ok', content: 'Kitchen light: on.', isError: false });
    const [finished] = await lastEvents('connection.tool_finished', 1);
    expect(finished?.text).toBe('Used GetLiveContext on Home Assistant · done');
    const [called] = await lastEvents('connection.tool_called', 1);
    expect(called?.payload).toMatchObject({ tool: 'GetLiveContext', access: 'read', tier: 'can' });
    expect(JSON.stringify([finished, called])).not.toContain('secret-kitchen');
    expect(JSON.stringify(finished)).not.toContain('Kitchen light');
    await dusty.mcp.close();
  });

  it('asks before a write, holds the arguments sealed, runs once after a yes and wakes the agent with the result', async () => {
    const dusty = await turn(IDS.dusty, IDS.billing);
    const res = await call(dusty.mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'HassTurnOn',
      arguments: { name: 'kitchen-lamp' },
    });
    expect(res.body.status).toBe('pending_approval');
    const number = Number(res.body.approvalNumber);
    const [row] = await t.services.db.select().from(approvals).where(eq(approvals.number, number));
    expect(row?.action).toMatchObject({
      type: 'connection_call',
      params: { handle: 'homeassistant', tool: 'HassTurnOn' },
    });
    expect(row?.keyId).toBe('connections.write');
    expect(JSON.stringify(row)).not.toContain('kitchen-lamp');
    // The deciders see the arguments (CX-21).
    if (!row) throw new Error('no approval');
    const seen = await approvalForViewer(t.services.db, IDS.mara, row);
    expect(seen.connection).toEqual({
      label: 'Home Assistant',
      catalogId: 'homeassistant',
      argumentsPreview: '{"name":"kitchen-lamp"}',
    });
    const calls = () =>
      home.seen.filter((s) => s.body.includes('"tools/call"') && s.body.includes('HassTurnOn')).length;
    expect(calls()).toBe(0);
    const decided = await t.commit(IDS.mara, decideApproval, { number, decision: 'approve' });
    expect(decided.status).toBe('ok');
    // The agent is woken where it asked with what the call returned, and says it in its own words (HR-04).
    await expect
      .poll(
        async () =>
          (
            await t.services.db
              .select({ id: dispatches.id })
              .from(dispatches)
              .where(and(eq(dispatches.approvalId, row.id), eq(dispatches.trigger, 'approval_granted')))
          )[0]?.id ?? null,
        { timeout: 10_000 },
      )
      .not.toBeNull();
    const [wake] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.approvalId, row.id), eq(dispatches.trigger, 'approval_granted')));
    expect(wake?.conversationId).toBe(IDS.billing);
    const context = await contextOf(wake?.id as string);
    expect(context.grantedResult).toMatchObject({ outcome: 'done', truncated: false });
    expect(context.grantedResult?.text).toContain('Turned on kitchen-lamp.');
    expect(context.grantedApproval?.id).toBe(row.id);
    // Nothing raw is posted as the agent, and the result is sealed on the approval.
    const posted = await t.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, IDS.billing), eq(messages.authorId, IDS.dusty)));
    expect(posted.some((m) => m.text.includes('kitchen-lamp'))).toBe(false);
    const [kept] = await t.services.db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(kept?.resultEnc).toBeTruthy();
    expect(kept?.resultEnc).not.toContain('kitchen-lamp');
    expect(calls()).toBe(1);
    await dusty.mcp.close();
  });

  describe('an approved call that doesn’t get through', () => {
    const seenFor = (name: string) =>
      home.seen.filter((s) => s.body.includes('"tools/call"') && s.body.includes(name)).length;
    const executionOf = async (id: string) =>
      (await t.services.db.select().from(approvals).where(eq(approvals.id, id)))[0]?.execution;
    const typesOf = async (id: string) =>
      (await t.services.db.select({ type: events.type }).from(events).where(eq(events.approvalId, id))).map(
        (e) => e.type,
      );

    async function askToTurnOn(name: string) {
      const dusty = await turn(IDS.dusty, IDS.billing);
      const res = await call(dusty.mcp, 'connection_call', {
        connection: 'homeassistant',
        tool: 'HassTurnOn',
        arguments: { name },
      });
      await dusty.mcp.close();
      expect(res.body.status).toBe('pending_approval');
      const [row] = await t.services.db
        .select()
        .from(approvals)
        .where(eq(approvals.number, Number(res.body.approvalNumber)));
      if (!row) throw new Error('no approval');
      return row;
    }

    it('fails the approval in plain words when the call breaks before it reaches the service', async () => {
      const row = await askToTurnOn('hall-lamp');
      const acquire = vi.spyOn(connectionsFor(t.services), 'acquire').mockImplementation(() => {
        throw new Error('injected before the remote call');
      });
      try {
        expect(
          (await t.commit(IDS.mara, decideApproval, { number: row.number, decision: 'approve' })).status,
        ).toBe('ok');
      } finally {
        acquire.mockRestore();
      }
      const execution = await executionOf(row.id);
      expect(execution?.state).toBe('failed');
      expect(execution?.error).toMatch(/nothing happened/i);
      expect(execution?.error).not.toContain('injected');
      const types = await typesOf(row.id);
      expect(types).toContain('approval.failed');
      expect(types).not.toContain('approval.executed');
      expect(seenFor('hall-lamp')).toBe(0);
    });

    it('sends nothing when the connection was signed in again after it asked, and wakes the agent to ask again', async () => {
      const row = await askToTurnOn('attic-lamp');
      // The person gives the connection a new token while the card waits: where its calls go, and as whom, changed.
      const [before] = await t.services.db
        .select()
        .from(catalogConnections)
        .where(eq(catalogConnections.id, ha));
      await t.services.db
        .update(catalogConnections)
        .set({ credentialVersion: (before?.credentialVersion ?? 1) + 1 })
        .where(eq(catalogConnections.id, ha));
      try {
        expect(
          (await t.commit(IDS.mara, decideApproval, { number: row.number, decision: 'approve' })).status,
        ).toBe('ok');
        await expect.poll(async () => (await executionOf(row.id))?.state, { timeout: 10_000 }).toBe('failed');
        expect((await executionOf(row.id))?.error).toContain('changed since you said yes');
        expect(seenFor('attic-lamp')).toBe(0);
        // The agent hears it, so it can ask again on a fresh card.
        await expect
          .poll(
            async () =>
              (
                await t.services.db
                  .select({ id: dispatches.id })
                  .from(dispatches)
                  .where(and(eq(dispatches.approvalId, row.id), eq(dispatches.trigger, 'approval_granted')))
              )[0]?.id ?? null,
            { timeout: 10_000 },
          )
          .not.toBeNull();
        const [wake] = await t.services.db
          .select()
          .from(dispatches)
          .where(and(eq(dispatches.approvalId, row.id), eq(dispatches.trigger, 'approval_granted')));
        const context = await contextOf(wake?.id as string);
        expect(context.grantedResult).toMatchObject({ outcome: 'failed' });
        expect(context.grantedResult?.text).toContain('changed since you said yes');
        // Asked again, the call is bound to the connection as it is now and runs after the yes.
        const again = await askToTurnOn('attic-lamp');
        expect(
          (await t.commit(IDS.mara, decideApproval, { number: again.number, decision: 'approve' })).status,
        ).toBe('ok');
        await expect
          .poll(async () => (await executionOf(again.id))?.state, { timeout: 10_000 })
          .toBe('succeeded');
        expect(seenFor('attic-lamp')).toBe(1);
      } finally {
        await t.services.db
          .update(catalogConnections)
          .set({ credentialVersion: before?.credentialVersion ?? 1 })
          .where(eq(catalogConnections.id, ha));
      }
    });

    /** The person pastes another account's token on the same Home Assistant; returns what puts the first back. */
    async function replaceToken(token: string) {
      const before = await currentRow(t.services, ha);
      if (!before) throw new Error('no connection');
      await t.services.db
        .update(catalogConnections)
        .set({
          secretEnc: sealConnectionSecret(t.services.custody, ha, 'secret', token),
          credentialVersion: before.credentialVersion + 1,
        })
        .where(eq(catalogConnections.id, ha));
      return async () => {
        await t.services.db
          .update(catalogConnections)
          .set({ secretEnc: before.secretEnc, credentialVersion: before.credentialVersion })
          .where(eq(catalogConnections.id, ha));
        await connectionsFor(t.services).evict(ha);
      };
    }
    const signedWith = (token: string) =>
      home.seen.filter((s) => s.headers.authorization === `Bearer ${token}`).length;

    it('sends nothing when the token is replaced after the approved call was checked, and drops the session opened before', async () => {
      const service = connectionsFor(t.services);
      // A session is open already, from a call made before the token changes.
      const first = await askToTurnOn('stair-lamp');
      await t.commit(IDS.mara, decideApproval, { number: first.number, decision: 'approve' });
      await expect
        .poll(async () => (await executionOf(first.id))?.state, { timeout: 10_000 })
        .toBe('succeeded');
      expect(service.pool.size).toBe(1);

      const row = await askToTurnOn('cellar-lamp');
      const other = 'ha-llat-Other7Account2Rp4';
      let restore: (() => Promise<void>) | null = null;
      const pooled = service.pool.call.bind(service.pool);
      // Between the call's check of the connection and its signing, the token is replaced (no eviction yet).
      const race = vi.spyOn(service.pool, 'call').mockImplementationOnce(async (target, tool, args) => {
        restore = await replaceToken(other);
        return pooled(target, tool, args);
      });
      try {
        await t.commit(IDS.mara, decideApproval, { number: row.number, decision: 'approve' });
        await expect.poll(async () => (await executionOf(row.id))?.state, { timeout: 10_000 }).toBe('failed');
        expect((await executionOf(row.id))?.error).toContain('changed since you said yes');
        expect(seenFor('cellar-lamp')).toBe(0);
        expect(signedWith(other)).toBe(0);
        // The session opened as the token before is closed: the next call opens its own.
        expect(service.pool.size).toBe(0);
      } finally {
        race.mockRestore();
        await (restore as (() => Promise<void>) | null)?.();
      }
    });

    it('never signs a request with a connection that changed since its call was checked', async () => {
      const row = await currentRow(t.services, ha);
      if (!row) throw new Error('no connection');
      const checked = callTarget(row);
      const url = `http://ha.home.test:${home.port}/api/`;
      // While it is the same, the request goes.
      expect(
        (await signedConnectionFetch(t.services, row, { method: 'GET', url }, { target: checked })).status,
      ).toBe(200);
      const other = 'ha-llat-Other7Account2Rp5';
      const restore = await replaceToken(other);
      try {
        const sent = home.seen.length;
        // The row it was checked on, or the row as it is now: neither is signed while the stored one differs.
        await expect(
          signedConnectionFetch(t.services, row, { method: 'GET', url }, { target: checked }),
        ).rejects.toBeInstanceOf(ConnectionChangedError);
        const now = await currentRow(t.services, ha);
        if (!now) throw new Error('no connection');
        await expect(
          signedConnectionFetch(t.services, now, { method: 'GET', url }, { target: checked }),
        ).rejects.toBeInstanceOf(ConnectionChangedError);
        // A pooled MCP session made for the connection as it was sends nothing either.
        const service = connectionsFor(t.services);
        await expect(
          service.pool.call(service.target(row, `http://ha.home.test:${home.port}/api/mcp`), 'HassTurnOn', {
            name: 'shed-lamp',
          }),
        ).rejects.toBeInstanceOf(ConnectionChangedError);
        expect(home.seen.length).toBe(sent);
      } finally {
        await restore();
      }
    });

    it('asks nothing when the connection changes between the call’s read and its card', async () => {
      const dusty = await turn(IDS.dusty, IDS.billing);
      const count = async () =>
        (await t.services.db.select({ n: sql<number>`count(*)::int` }).from(approvals))[0]?.n ?? 0;
      const asked = await count();
      const commit = t.services.pipeline.commit.bind(t.services.pipeline);
      let restore: (() => Promise<void>) | null = null;
      // The token is replaced after the call read the connection and just before its card is saved.
      const race = vi.spyOn(t.services.pipeline, 'commit').mockImplementation(async (def, input, options) => {
        if (def === callConnectionTool && !restore) restore = await replaceToken('ha-llat-Other7Account2Rp6');
        return commit(def, input, options);
      });
      try {
        const res = await call(dusty.mcp, 'connection_call', {
          connection: 'homeassistant',
          tool: 'HassTurnOn',
          arguments: { name: 'loft-lamp' },
        });
        expect(res.body).toMatchObject({ status: 'failed', reason: 'destination_refused' });
        expect(String(res.body.message)).toContain('changed while this call started');
        expect(await count()).toBe(asked);
        expect(seenFor('loft-lamp')).toBe(0);
      } finally {
        race.mockRestore();
        await (restore as (() => Promise<void>) | null)?.();
        await dusty.mcp.close();
      }
    });

    it('runs a call a crash stopped before it was recorded once on recovery', async () => {
      const row = await askToTurnOn('porch-lamp');
      // The yes and the start committed, then the process stopped before the call's own commit.
      await t.services.db
        .update(approvals)
        .set({
          state: 'approved',
          decidedById: IDS.mara,
          decidedAt: t.services.clock(),
          execution: { ...row.execution, state: 'running', startedAt: '2020-01-01T00:00:00.000Z' },
        })
        .where(eq(approvals.id, row.id));
      await t.services.approvals.recover();
      expect((await executionOf(row.id))?.state).toBe('succeeded');
      expect(seenFor('porch-lamp')).toBe(1);
    });

    it('never runs a recorded call again on recovery, and settles it from what was recorded', async () => {
      const row = await askToTurnOn('garden-lamp');
      const commit = t.services.pipeline.commit.bind(t.services.pipeline);
      // The call went out, then the process stopped before the approval's outcome was saved.
      const crash = vi.spyOn(t.services.pipeline, 'commit').mockImplementation((command, input, options) => {
        if (typeof command !== 'string' && command.name === 'approval.complete_execution')
          return Promise.reject(new Error('stopped'));
        return commit(command, input, options);
      });
      try {
        await t.commit(IDS.mara, decideApproval, { number: row.number, decision: 'approve' });
      } finally {
        crash.mockRestore();
      }
      expect((await executionOf(row.id))?.state).toBe('running');
      expect(seenFor('garden-lamp')).toBe(1);
      const real = t.services.clock;
      t.services.clock = () => new Date(real().getTime() + 20 * 60_000);
      try {
        await t.services.approvals.recover();
      } finally {
        t.services.clock = real;
      }
      expect((await executionOf(row.id))?.state).toBe('succeeded');
      expect(seenFor('garden-lamp')).toBe(1);
    });
  });

  it('resolves a page of approval previews with bounded reads and keeps the viewer checks', async () => {
    const db = t.services.db;
    const [source] = await db
      .select()
      .from(approvals)
      .where(sql`${approvals.action}->>'type' = 'connection_call'`)
      // The first one asked for (the kitchen lamp): without an order Postgres may hand back a later one.
      .orderBy(approvals.number)
      .limit(1);
    const viewer = await loadPrincipalRow(db, IDS.mara);
    if (!source || !viewer) throw new Error('no connection approval or viewer');
    const copies = Array.from({ length: 4 }, (_, index) => ({
      ...source,
      id: `apr_batch_${index}`,
      number: 9000 + index,
      state: 'pending' as const,
    }));
    const ids = copies.map((a) => a.id);
    await db.insert(approvals).values(copies);
    await db.insert(notifications).values(
      copies.map((a) => ({
        id: `ntf_${a.id}`,
        burrowId: a.burrowId,
        principalId: IDS.mara,
        kind: 'needs_you' as const,
        actorId: IDS.dusty,
        text: 'An action needs your approval',
        link: { type: 'approval' as const, number: a.number },
        approvalId: a.id,
        createdAt: a.createdAt,
      })),
    );
    try {
      const expected = await approvalForViewer(db, IDS.mara, source);
      expect(expected.connection?.argumentsPreview).toContain('kitchen-lamp');
      const selects = vi.spyOn(db, 'select');
      try {
        const listed = await approvalList(db, viewer, t.burrowId, { state: 'pending', limit: 100 });
        expect(selects).toHaveBeenCalledTimes(4);
        for (const id of ids)
          expect(listed.approvals.find((a) => a.id === id)?.connection).toEqual(expected.connection);
        selects.mockClear();
        const listedInbox = await inbox(db, IDS.mara, 'all');
        expect(selects).toHaveBeenCalledTimes(5);
        const items = listedInbox.sections.flatMap((s) => s.items);
        for (const id of ids)
          expect(items.find((i) => i.approvalId === id)?.approval?.connection).toEqual(expected.connection);
      } finally {
        selects.mockRestore();
      }
      const denied = await approvalsForViewer(db, 'prn_absent', copies);
      expect(denied.every((a) => !a.connection)).toBe(true);
    } finally {
      await db.delete(notifications).where(inArray(notifications.approvalId, ids));
      await db.delete(approvals).where(inArray(approvals.id, ids));
    }
  });

  it('asks for a sensitive call whatever the tiers, refuses Off without signing, Blocks without the key', async () => {
    await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'can' });
    await setTier(ha, 'HassTurnOn', 'can');
    const dusty = await turn(IDS.dusty, IDS.billing);
    const plain = await call(dusty.mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'HassTurnOn',
      arguments: { name: 'hall' },
    });
    expect(plain.body).toMatchObject({ status: 'ok', content: 'Turned on hall.' });
    const lock = await call(dusty.mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'HassTurnOn',
      arguments: { name: 'lock.front_door' },
    });
    expect(lock.body.status).toBe('pending_approval');
    await setTier(ha, 'EraseEverything', 'can');
    const erase = await call(dusty.mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'EraseEverything',
      arguments: {},
    });
    expect(erase.body.status).toBe('pending_approval');

    await setTier(ha, 'HassTurnOn', 'off');
    const off = await call(dusty.mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'HassTurnOn',
      arguments: { name: 'hall' },
    });
    expect(off.body).toEqual({
      status: 'blocked',
      eventId: null,
      message: 'HassTurnOn is turned off for Home Assistant.',
    });
    await setTier(ha, 'HassTurnOn', 'can');
    await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'cannot' });
    const blocked = await call(dusty.mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'HassTurnOn',
      arguments: { name: 'hall' },
    });
    expect(blocked.body.status).toBe('blocked');
    expect(blocked.body.eventId).toEqual(expect.any(String));
    await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'ask' });
    await dusty.mcp.close();
  });
});

describe('the request tool (CX-33)', () => {
  it('reads at once, asks for sensitive paths however they are spelled, and stays under the prefixes', async () => {
    await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'can' });
    await setTier(ha, 'request', 'can');
    const dusty = await turn(IDS.dusty, IDS.billing);
    const req = (args: Record<string, unknown>) =>
      call(dusty.mcp, 'connection_call', { connection: 'homeassistant', tool: 'request', arguments: args });
    const states = await req({ method: 'get', path: '/api/states' });
    expect(states.body).toMatchObject({ status: 'ok', httpStatus: 200, isError: false });
    expect(String(states.body.content)).toMatch(
      /^HTTP 200\nContent-Type: application\/json\n\n\[\{"entity_id":"light.kitchen"/,
    );
    // A query rides along: the address rule reads scheme, host and port only (CX-40a).
    expect((await req({ method: 'GET', path: '/api/states', query: { per_page: '50' } })).body).toMatchObject(
      {
        status: 'ok',
        httpStatus: 200,
      },
    );
    const light = await req({
      method: 'POST',
      path: '/api/services/light/turn_on',
      body: { entity_id: 'light.kitchen' },
    });
    expect(String(light.body.content)).toContain('"called":"/api/services/light/turn_on"');
    expect((await req({ method: 'POST', path: '/api/services/lock/unlock', body: {} })).body.status).toBe(
      'pending_approval',
    );
    expect((await req({ method: 'POST', path: '/api/services/%6Cock/unlock', body: {} })).body.status).toBe(
      'pending_approval',
    );
    expect((await req({ method: 'GET', path: '/auth/token' })).body).toMatchObject({
      status: 'failed',
      reason: 'invalid_arguments',
    });
    expect((await req({ method: 'GET', path: '/api/../auth' })).body).toMatchObject({
      reason: 'invalid_arguments',
    });
    expect(
      (await req({ method: 'GET', path: '/api/states', headers: { Authorization: 'Bearer x' } })).body,
    ).toMatchObject({
      reason: 'invalid_arguments',
    });
    // A redirect comes back as it is; Whombat never follows it.
    const moved = await req({ method: 'GET', path: '/api/redirect' });
    expect(moved.body).toMatchObject({ status: 'ok', httpStatus: 302 });
    expect(String(moved.body.content)).toContain('Location: elsewhere');
    await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'ask' });
    await dusty.mcp.close();
  });

  it('withholds an answer that shows the token whole, and the connection stays the agent’s to use', async () => {
    await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'can' });
    await setTier(ha, 'request', 'can');
    const dusty = await turn(IDS.dusty, IDS.billing);
    const req = (args: Record<string, unknown>) =>
      call(dusty.mcp, 'connection_call', { connection: 'homeassistant', tool: 'request', arguments: args });
    // The stub answers a service call with what it was sent: here, the token.
    const echoed = await req({
      method: 'POST',
      path: '/api/services/light/turn_on',
      body: { entity_id: HA_TOKEN },
    });
    expect(echoed.body).toMatchObject({ status: 'failed', reason: 'service_error' });
    expect(String(echoed.body.message)).toContain('held it back');
    expect(JSON.stringify(echoed.body)).not.toContain(HA_TOKEN);
    // Nothing is taken back: the next call goes through as before.
    const after = await req({ method: 'GET', path: '/api/states' });
    expect(after.body).toMatchObject({ status: 'ok', httpStatus: 200 });
    await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'ask' });
    await dusty.mcp.close();
  });
});

describe('the person’s connections (CX-21, CX-23; one-person.md OP-S51, OP-17)', () => {
  beforeAll(async () => {
    await insertConnection(t.services, {
      catalogId: 'nextcloud',
      burrowId: t.burrowId,
      label: 'Nextcloud',
      fields: { url: `http://cloud.home.test:${dav.port}`, username: 'mara' },
      auth: { type: 'basic', usernameField: 'username' },
      secret: 'app-pass-77Xq',
    });
  });

  it('is seen in the person’s turns, never in one an outsider starts (OP-17)', async () => {
    const own = await turn(IDS.dusty, IDS.dmDusty, { onBehalfOfAccountId: mara });
    expect((await call(own.mcp, 'connection_tools', { connection: 'nextcloud' })).body.status).toBe('ok');
    await own.mcp.close();
    // (Building the context issues the turn a new token: after the calls.)
    const ctx = await contextOf(own.dispatchId);
    const nextcloud = ctx.connections?.find((c) => c.handle === 'nextcloud');
    expect(nextcloud).toMatchObject({ catalogId: 'nextcloud', status: 'active' });
    const outsiders = await turn(IDS.dusty, IDS.billing, { onBehalfOfAccountId: null });
    const refused = (await call(outsiders.mcp, 'connection_tools', { connection: 'nextcloud' })).body;
    expect(refused).toMatchObject({ error: { code: 'forbidden' } });
    expect(JSON.stringify(refused)).not.toContain('nextcloud');
    expect((await outsiders.mcp.client.listTools()).tools.map((x) => x.name)).not.toContain(
      'connection_call',
    );
    await outsiders.mcp.close();
    const [row] = await t.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, outsiders.dispatchId));
    if (!row) throw new Error('no dispatch');
    expect(await visibleConnections(t.services.db, IDS.dusty, row)).toEqual([]);
  });

  it('works with the files over WebDAV; a write asks the person where it was asked and the log names it', async () => {
    const own = await turn(IDS.dusty, IDS.dmDusty, { onBehalfOfAccountId: mara });
    dav.files.set('/Notes/', '');
    dav.files.set('/Notes/todo.md', 'Buy milk');
    const listed = await call(own.mcp, 'connection_call', {
      connection: 'nextcloud',
      tool: 'files_list',
      arguments: { path: '/Notes' },
    });
    expect(JSON.parse(String(listed.body.content))).toEqual({
      path: '/Notes',
      entries: [{ name: 'todo.md', path: '/Notes/todo.md', folder: false, size: 8 }],
    });
    const write = await call(own.mcp, 'connection_call', {
      connection: 'nextcloud',
      tool: 'files_write',
      arguments: { path: '/Notes/plan.md', content: 'private plan' },
    });
    expect(write.body.status).toBe('pending_approval');
    const [row] = await t.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.number, Number(write.body.approvalNumber)));
    if (!row) throw new Error('no approval');
    expect(row.conversationId).toBe(IDS.dmDusty);
    expect((await approvalForViewer(t.services.db, IDS.mara, row)).connection?.argumentsPreview).toContain(
      'private plan',
    );
    expect(
      (await t.commit(IDS.mara, decideApproval, { number: row.number, decision: 'approve' })).status,
    ).toBe('ok');
    await expect.poll(() => dav.files.get('/Notes/plan.md'), { timeout: 10_000 }).toBe('private plan');
    // The agent is woken where it asked with the result (HR-04).
    await expect
      .poll(
        async () =>
          (
            await t.services.db
              .select({ conversationId: dispatches.conversationId })
              .from(dispatches)
              .where(and(eq(dispatches.approvalId, row.id), eq(dispatches.trigger, 'approval_granted')))
          )[0]?.conversationId ?? null,
        { timeout: 10_000 },
      )
      .toBe(IDS.dmDusty);
    const [finished] = await lastEvents('connection.tool_finished', 1);
    expect(finished?.payload).toMatchObject({ tool: 'files_write', handle: 'nextcloud', outcome: 'done' });
    await own.mcp.close();
  });

  it('asks in the person’s own chat where it was asked, and is woken there after the yes (CA-01)', async () => {
    const started = await t.commit(IDS.mara, startChat, { text: 'Turn the kitchen lamp on' });
    if (started.status !== 'ok') throw new Error(started.status);
    const chatId = started.result.conversationId;
    const own = await turn(IDS.dusty, chatId, { onBehalfOfAccountId: mara });
    const res = await call(own.mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'HassTurnOn',
      arguments: { name: 'kitchen-lamp' },
    });
    await own.mcp.close();
    expect(res.body.status).toBe('pending_approval');
    const [row] = await t.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.number, Number(res.body.approvalNumber)));
    if (!row?.messageId) throw new Error('no approval');
    expect(row.conversationId).toBe(chatId);
    const [card] = await t.services.db.select().from(messages).where(eq(messages.id, row.messageId));
    expect(card?.conversationId).toBe(chatId);
    expect(
      (await t.commit(IDS.mara, decideApproval, { number: row.number, decision: 'approve' })).status,
    ).toBe('ok');
    // The turn carrying on after the yes is in the chat (the chat's queued turn takes the wake over).
    await expect
      .poll(
        async () =>
          (
            await t.services.db
              .select({ conversationId: dispatches.conversationId })
              .from(dispatches)
              .where(eq(dispatches.approvalId, row.id))
          )[0]?.conversationId ?? null,
        { timeout: 10_000 },
      )
      .toBe(chatId);
  });
});

describe('OAuth connections (CX-12…CX-15, CX-32)', () => {
  it('refreshes once after a 401 and goes on with the new token', async () => {
    await insertConnection(t.services, {
      catalogId: 'custom_mcp',
      burrowId: t.burrowId,
      label: 'Docs',
      handle: 'docs',
      signIn: 'mcp_oauth',
      auth: null,
      fields: { url: `http://oauth.home.test:${oauth.port}/mcp` },
      accessToken: 'stale-token',
      accessExpiresAt: new Date(t.services.clock().getTime() + 3600_000),
      refreshToken: 'refresh-1',
      issuer: `http://oauth.home.test:${oauth.port}`,
      clientId: 'https://whombat.test/api/v1/connections/oauth/client.json',
      resource: `http://oauth.home.test:${oauth.port}/mcp`,
    });
    const dusty = await turn(IDS.dusty, IDS.billing);
    const tools = await call(dusty.mcp, 'connection_tools', { connection: 'docs' });
    expect((tools.body.tools as { name: string }[]).map((x) => x.name)).toEqual(['search']);
    expect(oauth.refused).toBeGreaterThan(0);
    // The real refresh (connect side's refresh.ts): once, single-flight, the new token stored for the next call.
    expect(oauth.refreshes).toBe(1);
    const found = await call(dusty.mcp, 'connection_call', {
      connection: 'docs',
      tool: 'search',
      arguments: {},
    });
    expect(found.body).toMatchObject({ status: 'ok', content: 'Found 2 pages.' });
    await dusty.mcp.close();
  });
});

describe('a sign-in for a call bound to where its connection went', () => {
  it('reaches nothing, and writes nothing, once the connection was given another address', async () => {
    const id = await insertConnection(t.services, {
      catalogId: 'custom_mcp',
      burrowId: t.burrowId,
      label: 'Notes',
      handle: 'notes',
      signIn: 'mcp_oauth',
      auth: null,
      fields: { url: `http://oauth.home.test:${oauth.port}/mcp` },
      accessToken: 'stale-token',
      // Due: the next credential asks the authorization server for a new token.
      accessExpiresAt: new Date(t.services.clock().getTime() - 1000),
      refreshToken: 'refresh-1',
      issuer: `http://oauth.home.test:${oauth.port}`,
      clientId: 'https://whombat.test/api/v1/connections/oauth/client.json',
      resource: `http://oauth.home.test:${oauth.port}/mcp`,
    });
    const asked = await currentRow(t.services, id);
    if (!asked) throw new Error('no connection');
    const checked = callTarget(asked);
    // Signed in again at another address while a call bound to the first waits.
    const other = `http://oauth-other.home.test:${oauth.port}`;
    await t.services.db
      .update(catalogConnections)
      .set({
        baseUrl: `${other}/mcp`,
        fields: { url: `${other}/mcp` },
        issuer: other,
        resource: `${other}/mcp`,
        credentialVersion: asked.credentialVersion + 1,
      })
      .where(eq(catalogConnections.id, id));
    const moved = await currentRow(t.services, id);
    if (!moved) throw new Error('no connection');
    const sent = oauth.seen.length;
    const refreshes = oauth.refreshes;
    // The row it was asked with or the row as it is now: neither refreshes, discovers or signs anything.
    for (const row of [asked, moved])
      await expect(
        signingOnlyAs({ [id]: checked }, () => credentialFor(t.services, row)),
      ).rejects.toBeInstanceOf(ConnectionChangedError);
    // The refresh itself reads the connection again and refuses before it asks.
    await expect(
      signingOnlyAs({ [id]: checked }, () => refreshConnectionAccess(t.services, asked, { force: true })),
    ).rejects.toBeInstanceOf(ConnectionChangedError);
    expect(oauth.seen.length).toBe(sent);
    expect(oauth.refreshes).toBe(refreshes);
    expect(await currentRow(t.services, id)).toMatchObject({
      status: 'active',
      accessTokenEnc: moved.accessTokenEnc,
      refreshTokenEnc: moved.refreshTokenEnc,
    });
    // Not bound to the old address, the connection refreshes where it goes now.
    await credentialFor(t.services, moved);
    expect(oauth.refreshes).toBe(refreshes + 1);
    expect(oauth.seen.slice(sent).every((s) => s.headers.host?.startsWith('oauth-other.home.test'))).toBe(
      true,
    );
  });
});

describe('a refused token at call time (CX-15)', () => {
  it('marks the connection needs_reauth once the entry’s check is refused too', async () => {
    const id = await insertConnection(t.services, {
      catalogId: 'homeassistant',
      burrowId: t.burrowId,
      label: 'Old house',
      handle: 'oldhouse',
      fields: { url: `http://ha.home.test:${home.port}` },
      secret: 'a-token-that-was-revoked',
    });
    await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'can' });
    await syncTools(t.services, id);
    await setTier(id, 'request', 'can');
    const dusty = await turn(IDS.dusty, IDS.billing);
    const res = await call(dusty.mcp, 'connection_call', {
      connection: 'oldhouse',
      tool: 'request',
      arguments: { method: 'GET', path: '/api/states' },
    });
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(String(res.body.content)).toMatch(/^HTTP 401/);
    await t.services.guides.settle();
    const [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
    expect(row).toMatchObject({ status: 'needs_reauth', reauthReason: 'token_invalid' });
    const [marked] = await lastEvents('connection.needs_reauth', 1);
    expect(marked?.payload).toMatchObject({ connectionId: id });
    await dusty.mcp.close();
  });
});
