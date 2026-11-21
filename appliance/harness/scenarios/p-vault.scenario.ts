/**
 * (p) The Vault on the managed stack (contracts ≥ 0.125.0; Whombat vault.md VT-80, VT-83, hermes-engine.md HE-21,
 * HE-43, HE-S152…HE-S156, one-person.md OP-01; contracts CT-1240…CT-1244; IN-63…IN-67, IN-408). Over the real client,
 * relay and managed runtime, with an in-process fake Home Assistant (MCP over streamable HTTP at `/api/mcp`, a bearer
 * token):
 *
 * 1. The person puts this host's private address (a /32, never loopback, VT-12) and the fake's port on the home
 *    network list.
 * 2. They add an MCP entry for the fake (bearer, a unique canary token) and check it: reached, its two tools on, and
 *    the fake saw the token. A loopback address is refused.
 * 3. The entry is on for the Whombat's one agent from the moment it was saved (Whombat vault-self-serve.md VS-01): the
 *    list says so and the audit log has `vault.key.given` for it; switching it on again (`vault.giveKey`) changes
 *    nothing and signs nothing.
 * 4. They ask the agent in their Chat. The harness acts as the runner (IN-64): the turn's Vault context names the entry
 *    and its MCP server (`vault_<entry key>`), and its keys (`runner.turnKeys`) bring that server to Hermes
 *    (`mcpServers`: the fake's URL, the token in its headers, the tools that are on, CT-1241); nobody is asked. The
 *    harness, as Hermes, calls the fake with them.
 * 5. RECENT USE has that turn's use (CT-1244); the audit log has the use with the entry's detail (list, get, CSV).
 * 6. Switched off (`vault.takeKey`): the next turn has it among the entries switched off, by name, and its keys no
 *    server and no token.
 * 7. Removing the network refuses the entry (“not allowed”, nothing reaches the fake); removing the entry drops its
 *    detail from the audit log and keeps the lines.
 * 8. The canary is in no API answer, realtime frame, dispatch context, MCP answer, audit page or CSV, log file of the
 *    environment, or row of the runtime's or control's database (sealed columns hold ciphertext): only in the turn's
 *    keys, the one door it leaves by (HE-S156).
 *
 * It stops the environment's runner while the harness acts as the runner, so it never runs against a public instance.
 */
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { vaultEntryKey } from '@whombat/core/vault';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/dev/env.ts';
import { pgContainer } from '../src/dev/postgres.ts';
import { startService, stopService } from '../src/dev/restart.ts';
import { CONTROL_DB, RUNTIME_DB } from '../src/dev/services.ts';
import { PG_USER, paths, publicUrls } from '../src/lib/paths.ts';
import { sleep } from '../src/lib/proc.ts';
import { contractsAtLeast } from '../src/manifest/version.ts';
import {
  agentMcp,
  type ClaimedTurn,
  type HarnessRunner,
  harnessRunner,
  type TurnKeys,
} from '../src/scenario-kit/agent-turn.ts';
import type { ApplianceSession, OperationResponse } from '../src/scenario-kit/app-client.ts';
import {
  type FakeHomeAssistant,
  pickPrivateIpv4,
  startFakeHomeAssistant,
} from '../src/scenario-kit/fake-home-assistant.ts';
import { plaintextNeedles } from '../src/scenario-kit/feedback-site.ts';
import { blocked, note } from '../src/scenario-kit/report.ts';
import { needleHits, scanCommand, scanDir } from '../src/scenario-kit/secret-scan.ts';
import { ensureSlice, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import {
  CallFailed,
  type Collected,
  collect,
  ensureWorkspace,
  eventType,
  type Workspace,
} from '../src/scenario-kit/work.ts';

/** The Vault without Ask, passes and relays: an entry's keys reach the person's turns (contracts 0.125). */
const enabled = contractsAtLeast('0.125.0');
const GAP = 'whombat-appliance/p-vault-environment';
const TOOLS = ['HassTurnOn', 'GetLiveContext'];

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
interface Input {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}
/** The fields of the Vault's answers this scenario reads. */
interface Network {
  id: string;
  cidr: string;
  ports: number[];
}
interface NetworksAnswer {
  networks: Network[];
}
interface EntryDetail {
  id: string;
  name: string;
  kind: string;
  url: string | null;
  auth: { type: string };
  secret: { set: boolean };
  check: { status: string };
  tools: { name: string; enabled: boolean; isNew: boolean }[];
  key: { givenAt: string } | null;
  recentUses: { id: string }[];
  lastUsedAt: string | null;
}
interface EntryRow {
  id: string;
  agentOn: boolean;
}
interface CheckResult {
  outcome: string;
  toolCount?: number;
}
interface WriteAnswer {
  entry: EntryDetail;
  eventId: string | null;
}
interface Use {
  id: string;
  entryId: string;
  agentId: string;
  dispatchId: string | null;
  outcome: string;
}
interface AuditRow {
  id: string;
  type: string;
  text: string | null;
  vault?: { entryId: string; entryName: string; outcome?: string | null } | null;
}
interface AuditPage {
  events: AuditRow[];
}

/** A long-lived token only this run knows; it must never come back from anywhere but the turn's keys. */
const canary = `ha${randomBytes(20).toString('hex')}`;
const needles = plaintextNeedles('canary', canary);
const suffix = randomBytes(3).toString('hex');
const entryName = `Home Assistant ${suffix}`;
const entryDescription = 'The house: lights, heating and sensors.';

let skip: string | null = null;
let slice: SliceState;
let person: ApplianceSession;
let w: Workspace;
let fake: FakeHomeAssistant;
let cidr = '';
let networkId: string | null = null;
let entryId = '';
/** The turn whose keys held the entry (steps 4 and 5). */
let usedDispatchId = '';
let runner: HarnessRunner | null = null;
let runnerStopped = false;
const open: ClaimedTurn[] = [];
let events: Collected | null = null;
/** Every answer the person's session got, as text. */
const answers: string[] = [];
/** What the fake answered the harness acting as Hermes (step 4). */
const hermesGot: string[] = [];

const serverName = () => `vault_${vaultEntryKey(entryId)}`;

function bodyText(body: unknown): string {
  if (typeof body === 'string') return body;
  const file = body as { kind?: string; bytes?: Uint8Array } | null;
  if (file?.kind === 'file' && file.bytes instanceof Uint8Array)
    return Buffer.from(file.bytes).toString('utf8');
  return JSON.stringify(body) ?? '';
}

async function call(
  s: ApplianceSession,
  id: string,
  method: Method,
  input: Input = {},
): Promise<OperationResponse> {
  const r = await s.call(
    { id, method },
    { params: input.params ?? {}, query: input.query ?? {}, body: input.body },
  );
  answers.push(`${id} ${r.status} ${bodyText(r.body)}`);
  return r;
}

async function ok<T>(s: ApplianceSession, id: string, method: Method, input: Input = {}): Promise<T> {
  const r = await call(s, id, method, input);
  if (r.status !== 200 && r.status !== 201) throw new CallFailed(id, r);
  return r.body as T;
}

const errorOf = (r: OperationResponse) =>
  (r.body as { error?: { code?: string; message?: string; details?: { code?: string } } } | null)?.error;

/** What a turn's keys hold, for a report note: a leaked canary is named, never written out. */
const keysNote = (k: TurnKeys | null) =>
  k && {
    files: k.files.map((f) => f.path),
    env: k.env.map((e) => e.name),
    mcpServers: k.mcpServers.map((m) => ({
      name: m.name,
      url: m.url,
      headers: m.headers.map((h) => h.name),
      tools: m.tools,
    })),
    entries: k.entries.map((e) => e.name),
  };

const inBurrow = (extra: Record<string, unknown> = {}) => ({ burrow: w.slug, ...extra });

function guard(ctx: Parameters<typeof blocked>[0]): void {
  if (skip) blocked(ctx, GAP, skip);
}

/** The harness takes the runner's place: the runtime gives a dispatch to whichever runner claims first. */
async function stand(): Promise<HarnessRunner> {
  const state = loadEnv();
  if (!state?.runtime) throw new Error('no environment');
  if (!runnerStopped && state.services.runner?.status === 'running') {
    await stopService('runner');
    runnerStopped = true;
  }
  runner ??= harnessRunner(state.runtime.url);
  return runner;
}

/** The person's message in their Chat, and the harness claiming the agent's turn for it. */
async function turnFor(what: string): Promise<ClaimedTurn> {
  const r = await stand();
  const sent = await ok<{ message: { id: string }; dispatches: { dispatchId: string }[] }>(
    person,
    'messages.send',
    'POST',
    {
      params: inBurrow({ conversationId: w.conversationId }),
      body: { text: 'Turn on the kitchen light, please' },
    },
  );
  const dispatchId = sent.dispatches[0]?.dispatchId ?? '';
  if (!dispatchId) throw new Error(`${what}: the message reached no agent`);
  const turn = await r.claim((c) => c.dispatch.id === dispatchId, what);
  open.push(turn);
  return turn;
}

async function finish(turn: ClaimedTurn): Promise<void> {
  await turn.complete('done');
  open.splice(open.indexOf(turn), 1);
}

async function startOwnRunner(): Promise<void> {
  if (!runnerStopped) return;
  await startService('runner');
  runnerStopped = false;
}

/** Approvals of this burrow that are about the entry (none: nobody is asked for a Vault entry since 0.125). */
async function approvalsAboutTheEntry(): Promise<{ action: unknown }[]> {
  const all = await ok<{ approvals: { action: unknown }[] }>(person, 'approvals.list', 'GET', {
    params: inBurrow(),
    query: { limit: 100 },
  });
  return all.approvals.filter((a) => JSON.stringify(a.action).includes(entryId));
}

beforeAll(async () => {
  if (!enabled) return;
  const state = loadEnv();
  if (!state?.runtime) throw new Error('no environment (dev/up)');
  if (publicUrls) {
    skip = `this environment is public (${publicUrls.web}); scenario p stops the runner while the harness acts as it, run it in a harness environment of its own`;
    return;
  }
  const picked = pickPrivateIpv4(networkInterfaces());
  if (!picked) {
    skip =
      'this host has no non-loopback private IPv4 address (10/8, 172.16/12, 192.168/16) for the fake Home Assistant; loopback is never a Vault destination (VT-12)';
    return;
  }
  fake = await startFakeHomeAssistant(picked.address, canary);
  cidr = `${picked.address}/32`;
  slice = await ensureSlice();
  person = (await ownerSession(slice)).session;
  w = await ensureWorkspace(person, `Vault ${suffix}`);
  events = collect(person, [`me:${w.mePrincipalId}`, `burrow:${w.burrowId}`, `conv:${w.conversationId}`]);
}, 300_000);

afterAll(async () => {
  if (!enabled || skip) return;
  // Leave the environment as it was: no turn of ours open, its runner running, the network off the list.
  for (const t of [...open]) await t.complete('failed', 'scenario p: stopped early').catch(() => {});
  await startOwnRunner().catch((err) =>
    process.stderr.write(`[p-vault] runner restart failed: ${String(err)}\n`),
  );
  if (networkId && person)
    await call(person, 'vaultNetworks.remove', 'DELETE', { params: { networkId } }).catch(() => {});
  events?.close();
  try {
    person?.close('closed');
  } catch {
    // already closed
  }
  await fake?.close();
}, 180_000);

describe.skipIf(!enabled)('p vault', () => {
  it('1 the person lists this host’s private address and the fake’s port on the home network list', async (ctx) => {
    guard(ctx);
    const first = await call(person, 'vaultNetworks.list', 'GET');
    if (first.status === 404 || errorOf(first)?.code === 'unknown_op')
      blocked(
        ctx,
        'whombat-runtime/vault',
        `vaultNetworks.list answered ${first.status} ${errorOf(first)?.code}`,
      );
    // A /32 left by an interrupted run (another port) goes first.
    for (const n of (first.body as NetworksAnswer).networks.filter((x) => x.cidr === cidr))
      await ok(person, 'vaultNetworks.remove', 'DELETE', { params: { networkId: n.id } });
    const added = await ok<NetworksAnswer>(person, 'vaultNetworks.add', 'POST', {
      body: { cidr, ports: [fake.port], note: 'Scenario p: a fake Home Assistant' },
    });
    const listed = added.networks.find((n) => n.cidr === cidr);
    networkId = listed?.id ?? null;
    const again = await ok<NetworksAnswer>(person, 'vaultNetworks.list', 'GET');
    note(ctx, 'home network list', {
      cidr,
      port: fake.port,
      listed: listed && { cidr: listed.cidr, ports: listed.ports },
    });
    expect(listed?.ports).toEqual([fake.port]);
    expect(again.networks.some((n) => n.id === networkId && n.cidr === cidr)).toBe(true);
  });

  it('2 the person adds an MCP entry for the fake and checks it: reached, its tools on, the fake saw the token', async (ctx) => {
    guard(ctx);
    if (!networkId) throw new Error('needs the network of step 1');
    // Loopback is never a destination, whatever the list says (VT-12).
    const loopback = await call(person, 'vault.create', 'POST', {
      params: inBurrow(),
      body: {
        name: `Loopback ${suffix}`,
        kind: 'mcp',
        url: `http://127.0.0.1:${fake.port}/api/mcp`,
        auth: { type: 'bearer' },
        secret: canary,
      },
    });
    const created = await ok<WriteAnswer>(person, 'vault.create', 'POST', {
      params: inBurrow(),
      body: {
        name: entryName,
        description: entryDescription,
        kind: 'mcp',
        url: fake.url,
        auth: { type: 'bearer' },
        secret: canary,
      },
    });
    entryId = created.entry.id;
    const checked = await ok<{ entry: EntryDetail; result: CheckResult }>(person, 'vault.check', 'POST', {
      params: inBurrow({ entryId }),
    });
    note(ctx, 'entry', {
      loopback: { status: loopback.status, code: errorOf(loopback)?.details?.code },
      created: {
        id: entryId,
        secret: created.entry.secret,
        check: created.entry.check.status,
        event: created.eventId,
      },
      check: checked.result,
      tools: checked.entry.tools.map((t) => `${t.name} ${t.enabled ? 'on' : 'off'}${t.isNew ? ' new' : ''}`),
      fake: fake.requests.map((r) => `${r.httpMethod} ${r.rpc.join(',')} ${r.status} bearer=${r.bearerOk}`),
    });
    expect(loopback.status).toBe(403);
    expect(errorOf(loopback)?.details?.code).toBe('address_not_allowed');
    expect(created.entry).toMatchObject({
      name: entryName,
      kind: 'mcp',
      url: fake.url,
      auth: { type: 'bearer' },
    });
    expect(created.entry.secret.set).toBe(true);
    expect(created.eventId).toBeTruthy();
    expect(checked.result).toMatchObject({ outcome: 'reached', toolCount: TOOLS.length });
    expect(checked.entry.tools.map((t) => [t.name, t.enabled, t.isNew])).toEqual(
      TOOLS.map((t) => [t, true, false]),
    );
    expect(fake.requests.some((r) => r.rpc.includes('tools/list'))).toBe(true);
    expect(fake.requests.filter((r) => r.httpMethod === 'POST').every((r) => r.bearerOk)).toBe(true);
    expect(fake.requests.some((r) => r.rpc.includes('tools/call'))).toBe(false);
    await events?.waitFor(
      (e) => eventType(e) === 'vault.updated' && e.topic === `me:${w.mePrincipalId}`,
      15_000,
      'vault.updated on the person’s me topic',
    );
  });

  it('3 the entry is on for the agent from the moment it was saved; switching it on again changes nothing', async (ctx) => {
    guard(ctx);
    if (!entryId) throw new Error('needs the entry of step 2');
    const list = await ok<{ entries: EntryRow[] }>(person, 'vault.list', 'GET', { params: inBurrow() });
    const page = await ok<AuditPage>(person, 'audit.list', 'GET', {
      params: inBurrow(),
      query: { kind: 'vault' },
    });
    const given = await ok<WriteAnswer>(person, 'vault.giveKey', 'PUT', {
      params: inBurrow({ entryId }),
      body: {},
    });
    const keyGiven = page.events.filter((e) => e.type === 'vault.key.given' && e.vault?.entryId === entryId);
    note(ctx, 'the agent’s switch', {
      agentOn: list.entries.find((e) => e.id === entryId)?.agentOn ?? null,
      keyGiven: keyGiven.length,
      given: given.entry.key,
      event: given.eventId,
    });
    expect(list.entries.find((e) => e.id === entryId)?.agentOn).toBe(true);
    expect(keyGiven).toHaveLength(1);
    expect(given.entry.key?.givenAt).toBeTruthy();
    expect(given.eventId).toBeNull();
  });

  it('4 the person asks the agent in their Chat: the turn’s keys bring the entry’s MCP server to Hermes; nobody is asked', async (ctx) => {
    guard(ctx);
    if (!entryId) throw new Error('needs the entry and its switch');
    const turn = await turnFor('the turn with the entry');
    usedDispatchId = turn.ctx.dispatch.id;
    const entry = turn.ctx.vault?.entries.find((e) => e.id === entryId);
    const keys = await turn.turnKeys();
    const server = keys.keys?.mcpServers.find((m) => m.name === serverName());
    // As Hermes does with an MCP server of the turn: the server's URL, its headers, only the tools that are on.
    let called: { text: string; error: string | null } = { text: '', error: 'no server in the turn’s keys' };
    if (server)
      try {
        const mcp = await agentMcp(
          server.url,
          Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
          hermesGot,
        );
        const r = await mcp.callTool('HassTurnOn', { name: 'Kitchen light' });
        called = { text: r.content?.[0]?.text ?? '', error: r.isError ? 'tool error' : null };
      } catch (err) {
        called = { text: '', error: String(err) };
      }
    const asked = await approvalsAboutTheEntry();
    const calls = fake.requests.filter((r) => r.rpc.includes('tools/call'));
    note(ctx, 'the turn', {
      dispatch: usedDispatchId,
      onBehalfOf: turn.ctx.onBehalfOf?.person.id ?? null,
      entry: entry ?? null,
      keys: { status: keys.status, code: keys.code, ...keysNote(keys.keys) },
      bearerInHeaders: server?.headers.some((h) => h.value === `Bearer ${canary}`) ?? false,
      called,
      fake: calls.map((r) => `${r.tools.join(',')} ${r.status} bearer=${r.bearerOk}`),
      approvalsAboutTheEntry: asked.length,
      foreign: runner?.foreign ?? [],
    });
    expect(turn.ctx.dispatch.agentId).toBe(w.agent.id);
    expect(turn.ctx.onBehalfOf?.person.id).toBe(w.mePrincipalId);
    expect(entry).toMatchObject({
      id: entryId,
      name: entryName,
      kind: 'mcp',
      url: fake.url,
      mcpServer: serverName(),
    });
    expect(keys.status).toBe(200);
    expect(server).toMatchObject({ name: serverName(), url: fake.url, tools: TOOLS });
    expect(
      server?.headers.some((h) => h.name.toLowerCase() === 'authorization' && h.value === `Bearer ${canary}`),
    ).toBe(true);
    expect(keys.keys?.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ entryId, name: entryName })]),
    );
    expect(called).toEqual({ text: 'Turned on Kitchen light.', error: null });
    expect(calls.map((r) => r.tools.join(','))).toEqual(['HassTurnOn']);
    expect(calls.every((r) => r.bearerOk)).toBe(true);
    // No Ask level, no passes: nobody is asked for an entry that is switched on (HE-S153).
    expect(asked).toEqual([]);
    await finish(turn);
  });

  it('5 RECENT USE has the turn; the audit log has the use with the entry (list, get, CSV)', async (ctx) => {
    guard(ctx);
    if (!usedDispatchId) throw new Error('needs the turn of step 4');
    const uses = await ok<{ uses: Use[] }>(person, 'vault.uses', 'GET', { params: inBurrow({ entryId }) });
    const detail = await ok<{ entry: EntryDetail }>(person, 'vault.get', 'GET', {
      params: inBurrow({ entryId }),
    });
    const page = await ok<AuditPage>(person, 'audit.list', 'GET', {
      params: inBurrow(),
      query: { kind: 'vault' },
    });
    const use = uses.uses.find((u) => u.dispatchId === usedDispatchId);
    const used = page.events.find((e) => e.type === 'vault.used' && e.vault?.entryId === entryId);
    const one = used
      ? await ok<{ event: AuditRow }>(person, 'audit.get', 'GET', { params: inBurrow({ eventId: used.id }) })
      : null;
    const csv = bodyText(
      (await call(person, 'audit.export', 'GET', { params: inBurrow(), query: { kind: 'vault' } })).body,
    );
    const types = page.events.map((e) => e.type);
    note(ctx, 'uses and audit', {
      uses: uses.uses.map(
        (u) => `${u.outcome} ${u.dispatchId === usedDispatchId ? 'this turn' : u.dispatchId}`,
      ),
      audit: page.events.map(
        (e) => `${e.type}${e.vault ? ` [${e.vault.entryName} ${e.vault.outcome ?? ''}]` : ''}`,
      ),
      csvLines: csv.split(/\r?\n/).length,
    });
    // One use per turn the entry reached the agent in (CT-1244).
    expect(use).toMatchObject({ entryId, agentId: w.agent.id, outcome: 'done' });
    expect(detail.entry.recentUses.some((u) => u.id === use?.id)).toBe(true);
    expect(detail.entry.lastUsedAt).toBeTruthy();
    expect(used?.vault).toMatchObject({ entryId, entryName, outcome: 'done' });
    expect(types).toEqual(expect.arrayContaining(['vault.entry.added', 'vault.key.given', 'vault.used']));
    expect(one?.event.vault?.entryName).toBe(entryName);
    expect(csv).toContain(entryName);
  });

  it('6 switched off: the next turn has it among the entries switched off, and no server or token in its keys', async (ctx) => {
    guard(ctx);
    if (!entryId) throw new Error('needs the entry');
    const taken = await ok<WriteAnswer>(person, 'vault.takeKey', 'DELETE', { params: inBurrow({ entryId }) });
    const turn = await turnFor('the turn after switching it off');
    const keys = await turn.turnKeys();
    note(ctx, 'switched off', {
      key: taken.entry.key,
      event: taken.eventId,
      held: turn.ctx.vault?.entries.map((e) => e.name) ?? null,
      unheld: turn.ctx.vault?.unheld.map((e) => `${e.name} (${e.kind})`) ?? null,
      keys: { status: keys.status, code: keys.code, ...keysNote(keys.keys) },
    });
    expect(taken.entry.key).toBeNull();
    expect(taken.eventId).toBeTruthy();
    expect(turn.ctx.vault?.entries.some((e) => e.id === entryId) ?? false).toBe(false);
    expect(turn.ctx.vault?.unheld).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: entryId, name: entryName, kind: 'mcp' })]),
    );
    expect(keys.status).toBe(200);
    expect(keys.keys?.mcpServers.some((m) => m.name === serverName())).toBe(false);
    await finish(turn);
    await startOwnRunner();
    const page = await ok<AuditPage>(person, 'audit.list', 'GET', {
      params: inBurrow(),
      query: { kind: 'vault' },
    });
    expect(page.events.map((e) => e.type)).toContain('vault.key.taken');
  });

  it('7 a removed network refuses the entry; removing the entry drops its detail and keeps the lines', async (ctx) => {
    guard(ctx);
    if (!networkId || !entryId) throw new Error('needs the network and the entry');
    const before = fake.requests.length;
    await ok(person, 'vaultNetworks.remove', 'DELETE', { params: { networkId } });
    networkId = null;
    const checked = await ok<{ result: CheckResult }>(person, 'vault.check', 'POST', {
      params: inBurrow({ entryId }),
    });
    const reachedFake = fake.requests.length - before;
    const removed = await ok<{ ok: true; eventId: string }>(person, 'vault.remove', 'DELETE', {
      params: inBurrow({ entryId }),
    });
    const gone = await call(person, 'vault.get', 'GET', { params: inBurrow({ entryId }) });
    const page = await ok<AuditPage>(person, 'audit.list', 'GET', {
      params: inBurrow(),
      query: { kind: 'vault' },
    });
    note(ctx, 'removed', {
      check: checked.result,
      requestsAfterRemoval: reachedFake,
      removedEvent: removed.eventId,
      get: gone.status,
      audit: page.events.map((e) => `${e.type}${e.vault ? ' [DETAIL]' : ''}`),
    });
    expect(checked.result.outcome).toBe('not_allowed');
    expect(reachedFake).toBe(0);
    expect(removed.eventId).toBeTruthy();
    expect(gone.status).toBe(404);
    expect(page.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['vault.used', 'vault.entry.removed']),
    );
    expect(page.events.some((e) => e.vault?.entryId === entryId)).toBe(false);
  });

  it('8 the canary is only in the turn’s keys: no answer, frame, context, MCP answer, audit, log or database', async (ctx) => {
    guard(ctx);
    if (!runner) throw new Error('needs the turns of steps 4 and 6');
    await sleep(1_000); // let services flush their logs
    const hits = [
      ...answers.flatMap((a, i) => needleHits(`answer ${i}`, a, needles)),
      ...needleHits('frames', JSON.stringify(events?.events ?? []), needles),
      ...runner.transcript.flatMap((t, i) => needleHits(`claim/MCP answer ${i}`, t, needles)),
      ...hermesGot.flatMap((t, i) => needleHits(`the fake's answer ${i}`, t, needles)),
    ];
    // The keys of steps 4 and 6 in order: only the turn with the entry switched on holds it.
    const inKeys = runner.keys.map((k) => needleHits('keys', k, needles).length > 0);
    const logs = scanDir(paths.logs, needles);
    const dump = (db: string) =>
      scanCommand(
        `${db} (pg_dump --data-only)`,
        'docker',
        ['exec', pgContainer(), 'pg_dump', '-U', PG_USER, '-d', db, '--data-only'],
        needles,
      );
    const runtimeDb = await dump(RUNTIME_DB);
    const controlDb = await dump(CONTROL_DB);
    note(ctx, 'canary search', {
      answers: answers.length,
      frames: events?.events.length ?? 0,
      claimsAndMcp: runner.transcript.length,
      keysAnswers: inKeys,
      logs: { files: logs.files, bytes: logs.bytes },
      runtimeDb: { bytes: runtimeDb.bytes, code: runtimeDb.code },
      controlDb: { bytes: controlDb.bytes, code: controlDb.code },
      hits: [...hits, ...logs.hits, ...runtimeDb.hits, ...controlDb.hits],
    });
    expect(runtimeDb.code, runtimeDb.stderr).toBe(0);
    expect(controlDb.code, controlDb.stderr).toBe(0);
    expect(runtimeDb.bytes).toBeGreaterThan(0);
    expect(hits).toEqual([]);
    expect(logs.hits).toEqual([]);
    expect(runtimeDb.hits).toEqual([]);
    expect(controlDb.hits).toEqual([]);
    expect(inKeys).toEqual([true, false]);
  });
});
