/**
 * (r) Hermes's browser and Vault logins in a turn on the managed stack (contracts ≥ 0.125.0, CT-1230, CT-1231,
 * CT-1233; Whombat hermes-engine.md HE-42, HE-S139, HE-S141, one-agent.md OA-05, one-person.md OP-07; IN-90, IN-408).
 * Hermes's browser drives a Chromium the runner starts for the turn, in the commands' network; what Whombat decides is
 * what a turn gets. Over the real client, relay and managed runtime; the harness acts as the runner (IN-64):
 *
 * 1. The Whombat's one agent holds “Use the browser” (`browser.use`, on by default): the person's turn has a browser
 *    with whatever the commands' network allows (`DispatchContext.browser`, `sites` null).
 * 2. A Vault login (an https sign-in page on this host's private address, its /32 and port on the home network list;
 *    nothing connects to it), switched on for the agent: the person's turn names it (`DispatchContext.logins`: entry,
 *    name, origin, username, no code), never its password; `runner.loginSecret` with the turn's lease gives the password
 *    for Hermes's credential vault — the one door it leaves by.
 * 3. Once that turn ended, its lease no longer fetches the password.
 * 4. Switched off for the agent: the person's next turn has no login, and the entry among those switched off.
 * 5. “Use the browser” off: the person's next turn has no browser; then on again as it was.
 * 6. The password is in no API answer, dispatch context, MCP answer, log file or database row (sealed columns hold
 *    ciphertext): only in `runner.loginSecret`'s answers.
 *
 * Browsing itself (Chromium, the CDP relay, the fill) is the runner's and Hermes's, and needs a live turn. It stops the
 * environment's runner while the harness acts as it, so it never runs against a public instance.
 */
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/dev/env.ts';
import { pgContainer } from '../src/dev/postgres.ts';
import { startService, stopService } from '../src/dev/restart.ts';
import { RUNTIME_DB } from '../src/dev/services.ts';
import { PG_USER, paths, publicUrls } from '../src/lib/paths.ts';
import { sleep } from '../src/lib/proc.ts';
import { contractsAtLeast } from '../src/manifest/version.ts';
import { type ClaimedTurn, type HarnessRunner, harnessRunner } from '../src/scenario-kit/agent-turn.ts';
import type { ApplianceSession, OperationResponse } from '../src/scenario-kit/app-client.ts';
import { pickPrivateIpv4 } from '../src/scenario-kit/fake-home-assistant.ts';
import { plaintextNeedles } from '../src/scenario-kit/feedback-site.ts';
import { blocked, note } from '../src/scenario-kit/report.ts';
import { needleHits, scanCommand, scanDir } from '../src/scenario-kit/secret-scan.ts';
import { ensureSlice, ownerSession } from '../src/scenario-kit/slice.ts';
import { type Agent, ensureWorkspace, type Workspace } from '../src/scenario-kit/work.ts';

/** Hermes's browser and logins in the dispatch (contracts 0.125). */
const enabled = contractsAtLeast('0.125.0');
const GAP = 'whombat-appliance/r-browser-environment';
/** The sign-in page's port: listed with the address, never listened on. */
const SITE_PORT = 8443;

const suffix = randomBytes(3).toString('hex');
/** The login's password: a unique canary that must never come back from anything but `runner.loginSecret`. */
const password = `pw-${randomBytes(12).toString('hex')}`;
const needles = plaintextNeedles('password', password);
const username = `ann-${suffix}@harness.whombat.local`;
const loginName = `Scenario site ${suffix}`;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface Input {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}
interface Grant {
  keyId: string;
  tier: string;
}

let skip: string | null = null;
let runtimeUrl = '';
let address = '';
let cidr = '';
let networkId: string | null = null;
let person: ApplianceSession;
let w: Workspace;
let agent: Agent;
let entryId: string | null = null;
/** The agent's grants before step 6 switched “Use the browser” off. */
let grantsBefore: Grant[] | null = null;
/** The turn of step 2, ended; step 3 tries its lease again. */
let loginTurn: ClaimedTurn | null = null;
let runner: HarnessRunner | null = null;
let runnerStopped = false;
const open: ClaimedTurn[] = [];
/** Every API answer, to look for the password in. */
const answers: string[] = [];

const inBurrow = (extra: Record<string, unknown> = {}) => ({ burrow: w.slug, ...extra });
const origin = () => `https://${address}:${SITE_PORT}`;

async function call(s: ApplianceSession, id: string, method: Method, input: Input = {}) {
  const r = await s.call(
    { id, method },
    { params: input.params ?? {}, query: input.query ?? {}, body: input.body },
  );
  answers.push(`${id} ${r.status} ${JSON.stringify(r.body ?? null)}`);
  return r;
}

async function ok<T>(s: ApplianceSession, id: string, method: Method, input: Input = {}): Promise<T> {
  const r = await call(s, id, method, input);
  if (r.status !== 200 && r.status !== 201)
    throw new Error(`${id}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body as T;
}

const errorOf = (r: OperationResponse) =>
  (r.body as { error?: { code?: string; message?: string } } | null)?.error;

function guard(ctx: Parameters<typeof blocked>[0]): void {
  if (skip) blocked(ctx, GAP, skip);
}

async function stand(): Promise<HarnessRunner> {
  if (!runnerStopped) {
    await stopService('runner');
    runnerStopped = true;
  }
  runner ??= harnessRunner(runtimeUrl);
  return runner;
}

/** The person's message in their Chat, and the harness claiming the agent's turn for it. */
async function turnFor(text: string, what: string): Promise<ClaimedTurn> {
  const r = await stand();
  const sent = await ok<{ message: { id: string } }>(person, 'messages.send', 'POST', {
    params: inBurrow({ conversationId: w.conversationId }),
    body: { text },
  });
  const turn = await r.claim(
    (c) =>
      c.dispatch.agentId === agent.id &&
      (c.dispatch.messageId === sent.message.id || c.dispatch.threadRootId === sent.message.id),
    what,
    90_000,
  );
  open.push(turn);
  return turn;
}

async function finish(turn: ClaimedTurn): Promise<void> {
  await turn.complete('done');
  open.splice(open.indexOf(turn), 1);
}

async function grants(): Promise<Grant[]> {
  return (await ok<{ grants: Grant[] }>(person, 'agent.get', 'GET', { params: inBurrow() })).grants;
}

async function setGrants(next: Grant[]): Promise<void> {
  await ok(person, 'agent.setKeys', 'PUT', {
    params: inBurrow(),
    body: { grants: next.map((g) => ({ keyId: g.keyId, tier: g.tier })) },
  });
}

beforeAll(async () => {
  if (!enabled) return;
  const state = loadEnv();
  if (!state?.runtime) throw new Error('no environment (dev/up)');
  runtimeUrl = state.runtime.url;
  if (publicUrls) {
    skip = `this environment is public (${publicUrls.web}); scenario r stops the runner while the harness acts as it`;
    return;
  }
  const picked = pickPrivateIpv4(networkInterfaces());
  if (!picked) {
    skip =
      'this host has no non-loopback private IPv4 address for the sign-in page; loopback is never a Vault destination';
    return;
  }
  address = picked.address;
  cidr = `${address}/32`;
  const slice = await ensureSlice();
  person = (await ownerSession(slice)).session;
  w = await ensureWorkspace(person, `Browser ${suffix}`);
  agent = w.agent;
}, 300_000);

afterAll(async () => {
  if (!enabled || skip) return;
  for (const t of [...open]) await t.complete('failed', 'scenario r: stopped early').catch(() => {});
  if (runnerStopped) await startService('runner').catch(() => {});
  if (grantsBefore && person) await setGrants(grantsBefore).catch(() => {});
  if (entryId && person)
    await call(person, 'vault.remove', 'DELETE', { params: inBurrow({ entryId }) }).catch(() => {});
  if (networkId && person)
    await call(person, 'vaultNetworks.remove', 'DELETE', { params: { networkId } }).catch(() => {});
  try {
    person?.close('closed');
  } catch {
    // already closed
  }
}, 180_000);

describe.skipIf(!enabled)('r browser', () => {
  it('1 the agent holds “Use the browser”: the person’s turn has a browser, wherever the commands’ network allows', async (ctx) => {
    guard(ctx);
    let had = await grants();
    // On by default (OA-05); switched off before, it comes back here (`agent.setKeys` replaces the grants).
    const byDefault = had.some((g) => g.keyId === 'browser.use' && g.tier === 'can');
    if (!byDefault) {
      await setGrants([
        ...had.filter((g) => g.keyId !== 'browser.use'),
        { keyId: 'browser.use', tier: 'can' },
      ]);
      had = await grants();
    }
    const turn = await turnFor('what does the scenario page say?', 'the person’s turn');
    note(ctx, 'the browser in the turn', {
      byDefault,
      grant: had.find((g) => g.keyId === 'browser.use') ?? null,
      browser: turn.ctx.browser ?? null,
    });
    expect(had).toContainEqual(expect.objectContaining({ keyId: 'browser.use', tier: 'can' }));
    expect(turn.ctx.browser).toEqual({ sites: null });
    await finish(turn);
  });

  it('2 a Vault login switched on: the person’s turn names it, never its password; the turn’s lease fetches it', async (ctx) => {
    guard(ctx);
    const listed = await ok<{ networks: { id: string; cidr: string }[] }>(
      person,
      'vaultNetworks.list',
      'GET',
    );
    // A /32 left by an interrupted run (another port) goes first.
    for (const n of listed.networks.filter((x) => x.cidr === cidr))
      await ok(person, 'vaultNetworks.remove', 'DELETE', { params: { networkId: n.id } });
    const added = await ok<{ networks: { id: string; cidr: string }[] }>(
      person,
      'vaultNetworks.add',
      'POST',
      {
        body: { cidr, ports: [SITE_PORT], note: 'Scenario r: a sign-in page' },
      },
    );
    networkId = added.networks.find((n) => n.cidr === cidr)?.id ?? null;
    const created = await call(person, 'vault.create', 'POST', {
      params: inBurrow(),
      body: {
        name: loginName,
        kind: 'login',
        url: `${origin()}/login`,
        auth: { type: 'form', username },
        secret: password,
      },
    });
    if (created.status !== 201 && created.status !== 200)
      throw new Error(`vault.create (login): ${created.status} ${errorOf(created)?.code}`);
    entryId = (created.body as { entry: { id: string } }).entry.id;
    await ok(person, 'vault.giveKey', 'PUT', { params: inBurrow({ entryId }), body: {} });
    const turn = await turnFor('sign in to the scenario site', 'the turn with the login');
    const login = turn.ctx.logins.find((l) => l.entryId === entryId);
    const secret = await turn.loginSecret(entryId);
    const told = JSON.stringify(turn.raw);
    note(ctx, 'the login in the turn', {
      logins: turn.ctx.logins.map((l) => ({ ...l, entryId: l.entryId === entryId ? 'this one' : l.entryId })),
      secret: {
        status: secret.status,
        code: secret.code,
        password: secret.secret?.password === password,
        otp: secret.secret?.otp ?? null,
      },
      passwordInTheContext: told.includes(password),
    });
    expect(turn.ctx.onBehalfOf?.person.id).toBe(w.mePrincipalId);
    expect(login).toEqual({ entryId, name: loginName, origin: origin(), username, otp: false });
    expect(told).not.toContain(password);
    expect(secret.status).toBe(200);
    expect(secret.secret).toEqual({ password, otp: null });
    await finish(turn);
    loginTurn = turn;
  });

  it('3 once the turn ended, its lease no longer fetches the password', async (ctx) => {
    guard(ctx);
    if (!loginTurn || !entryId) throw new Error('needs the turn of step 2');
    const late = await loginTurn.loginSecret(entryId);
    note(ctx, 'after the turn', { status: late.status, code: late.code });
    expect([404, 409]).toContain(late.status);
    expect(late.secret).toBeNull();
  });

  it('4 switched off for the agent: the person’s next turn has no login, and the entry among those switched off', async (ctx) => {
    guard(ctx);
    if (!entryId) throw new Error('needs the login of step 2');
    await ok(person, 'vault.takeKey', 'DELETE', { params: inBurrow({ entryId }) });
    const turn = await turnFor('sign in to the scenario site again', 'the turn after switching it off');
    const secret = await turn.loginSecret(entryId);
    note(ctx, 'switched off', {
      logins: turn.ctx.logins.length,
      unheld: turn.ctx.vault?.unheld.map((e) => `${e.name} (${e.kind})`) ?? null,
      secret: { status: secret.status, code: secret.code },
    });
    expect(turn.ctx.logins.some((l) => l.entryId === entryId)).toBe(false);
    expect(turn.ctx.vault?.unheld).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: entryId, name: loginName, kind: 'login' })]),
    );
    expect(secret.status).toBe(404);
    await finish(turn);
  });

  it('5 “Use the browser” off: the person’s next turn has no browser; on again after', async (ctx) => {
    guard(ctx);
    grantsBefore = await grants();
    await setGrants(grantsBefore.filter((g) => g.keyId !== 'browser.use'));
    const off = await grants();
    const turn = await turnFor('what does the scenario page say now?', 'the turn without the browser');
    const browser = turn.ctx.browser ?? null;
    await finish(turn);
    await setGrants(grantsBefore);
    const back = await grants();
    grantsBefore = null;
    note(ctx, 'without the browser', {
      grantOff: off.find((g) => g.keyId === 'browser.use') ?? null,
      browser,
      grantBack: back.find((g) => g.keyId === 'browser.use') ?? null,
    });
    expect(off.some((g) => g.keyId === 'browser.use' && g.tier === 'can')).toBe(false);
    expect(browser).toBeNull();
    expect(back).toContainEqual(expect.objectContaining({ keyId: 'browser.use', tier: 'can' }));
  });

  it('6 the password is only in runner.loginSecret’s answers: no API answer, context, MCP answer, log or database', async (ctx) => {
    guard(ctx);
    if (!runner) throw new Error('needs the turns of steps 1 to 5');
    if (runnerStopped) {
      await startService('runner');
      runnerStopped = false;
    }
    await sleep(1_000); // let services flush their logs
    const hits = [
      ...answers.flatMap((a, i) => needleHits(`answer ${i}`, a, needles)),
      ...runner.transcript.flatMap((t, i) => needleHits(`claim/MCP answer ${i}`, t, needles)),
    ];
    // The secrets asked for in steps 2 to 4, in order: only the live turn of step 2 got it.
    const inSecrets = runner.keys.map((k) => needleHits('secret', k, needles).length > 0);
    const logs = scanDir(paths.logs, needles);
    const db = await scanCommand(
      `${RUNTIME_DB} (pg_dump --data-only)`,
      'docker',
      ['exec', pgContainer(), 'pg_dump', '-U', PG_USER, '-d', RUNTIME_DB, '--data-only'],
      needles,
    );
    note(ctx, 'password search', {
      answers: answers.length,
      claimsAndMcp: runner.transcript.length,
      secrets: inSecrets,
      logs: { files: logs.files, bytes: logs.bytes },
      runtimeDb: { bytes: db.bytes, code: db.code },
      hits: [...hits, ...logs.hits, ...db.hits],
    });
    expect(db.code, db.stderr).toBe(0);
    expect(hits).toEqual([]);
    expect(logs.hits).toEqual([]);
    expect(db.hits).toEqual([]);
    expect(inSecrets).toEqual([true, false, false]);
  });
});
