/**
 * (k) Live agents (IN-38, IN-403; Whombat SUB-01…SUB-31, HE-01, contracts CT-69…CT-74) against an environment started
 * with `WB_MGD_AGENTS=live` — the image's Hermes runs every turn — and a client channel the latest tested job published
 * (docs/runbooks/client-latest-tested.md):
 *
 * - K1 the manager installs the real Claude Code from the signed channel; the runtime's `clients.list` shows it
 *   installed and nothing else: ChatGPT runs on Hermes's own provider with no client, and installing Codex is refused
 *   (IN-432; Whombat HN-A01);
 * - K2 a Claude sign-in console starts on the appliance (`signins.consoleStart`, `claude auth login --claudeai` in the
 *   runner's sign-in executor) and shows Claude's own login URL (`signins.consoleRead`); it is cancelled, never
 *   completed;
 * - K3 a ChatGPT sign-in (`signins.loginStart`, Hermes's own device-code login, Whombat HN-C03) answers with OpenAI's
 *   device code; cancelled, never completed;
 * - K4 the Whombat's agent runs on the person's own sign-in (Whombat one-person.md OP-09, contracts CT-1503: no
 *   requester or organisation sources): a turn while they have no Claude sign-in fails with `provider.not_signed_in`
 *   and the agent says why;
 * - K6 the same agent put on ChatGPT (`codex`, `agent.update`, as an owner does in Settings → Agent), ready with
 *   Hermes and nothing installed: its turn is claimed and refused for a person without a ChatGPT sign-in; then back on
 *   Claude;
 * - K5 a turn on a planted, empty Claude subscription home runs Hermes, in that person's own profile, and the installed
 *   Claude Code in the sandbox up to Claude Code's own login check.
 *
 * Nothing signs in and no model is called: no real account is used. Blocked (not failed) in a scripted environment,
 * without the real manager's clients configuration, or without a published channel.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envPath } from '../src/dev/env.ts';
import { psql } from '../src/dev/postgres.ts';
import { persistLayout, RUNTIME_DB, unixJson } from '../src/dev/services.ts';
import { paths } from '../src/lib/paths.ts';
import { sleep } from '../src/lib/proc.ts';
import type { ApplianceSession } from '../src/scenario-kit/app-client.ts';
import { blocked, gap, note } from '../src/scenario-kit/report.ts';
import { ensureSlice, ownerSession } from '../src/scenario-kit/slice.ts';
import { type Agent, api, collect, ensureWorkspace, eventType, theAgent } from '../src/scenario-kit/work.ts';
import { env } from '../src/scenario-kit/world.ts';

type Provider = 'claude' | 'codex';
interface ManagerClient {
  provider: Provider;
  state: string;
  installed: { version: string; executable: { path: string; sha256: string } } | null;
  latest: { version: string } | null;
  error: { code: string; message: string } | null;
}
interface ClientStatus {
  provider: Provider;
  state: string;
  installed: { version: string; source: string } | null;
  latest: { version: string } | null;
}
interface Console {
  consoleId: string;
  state: string;
  exitCode: number | null;
  error: { code: string; message: string } | null;
}
interface Login {
  loginId: string;
  state: string;
  device: { verificationUri: string; userCode: string; expiresAt: string } | null;
  error: { code: string; message: string } | null;
}

let owner: ApplianceSession | null = null;
let why = '';
/** The burrow (its owner may install clients, CT-72) and its agent: Claude, on each requester's sign-in. */
let w: { burrowId: string; slug: string; conversationId: string; agent: Agent } | null = null;

async function managerClients(): Promise<ManagerClient[]> {
  const r = await unixJson(env().appliance?.managerSocket ?? '', 'GET', '/v1/clients');
  if (r.status !== 200) throw new Error(`GET /v1/clients: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { clients: ManagerClient[] }).clients;
}

async function runtimeClients(): Promise<ClientStatus[]> {
  if (!owner) return [];
  return (await api<{ clients: ClientStatus[] }>(owner, 'clients.list', 'GET')).clients;
}

/** The terminal's text without escape sequences (what a person reads in the console). */
function plain(bytes: string): string {
  return (
    bytes
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
      .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
      .replace(/\u001b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
      .replace(/\u001b[()][0-9A-B]|\u001b[=>78]/g, '')
      .replace(/\r/g, '')
  );
}

beforeAll(async () => {
  const e = env();
  if ((e.agents ?? 'scripted') !== 'live') {
    why = 'the environment runs scripted agents (start it with WB_MGD_AGENTS=live)';
    return;
  }
  if (e.manager?.kind !== 'real') {
    why = 'dev/up ran the stand-in manager';
    return;
  }
  const cfg = envPath('manager', 'manager.json');
  if (!existsSync(cfg) || !(JSON.parse(readFileSync(cfg, 'utf8')) as { clients?: unknown }).clients) {
    why =
      'the manager has no clients configuration (a manager before MG-33, or no plain clients root: IN-37)';
    return;
  }
  // The manager sees a new channel after its next TUF refresh and channel check (20 s and 60 s in dev). Claude Code is
  // the only client (IN-432).
  const offered = async () => {
    const clients = await managerClients();
    return (['claude'] as const).filter((p) => !clients.find((c) => c.provider === p)?.latest);
  };
  let missing = await offered();
  for (
    const deadline = Date.now() + 150_000;
    missing.length && Date.now() < deadline;
    missing = await offered()
  )
    await sleep(3000);
  if (missing.length) {
    why = `the client channel offers no ${missing.join(' or ')} (run the latest tested job into this environment's repository)`;
    return;
  }
  owner = (await ownerSession(await ensureSlice())).session;
  // “Set up your AI” picked Claude; managed onboarding gives the agent the requester source (CT-69).
  w = await ensureWorkspace(owner, `Live ${randomBytes(3).toString('hex')}`, { provider: 'claude' });
}, 360_000);

afterAll(() => {
  owner?.close('closed');
});

describe('k live agents: the real clients, the sign-in flows and the requester refusal', () => {
  it('K1 the manager installs Claude Code from the channel; clients.list shows it, and no Codex', async (ctx) => {
    if (why) blocked(ctx, 'whombat-appliance/live-agents', why);
    const s = owner as ApplianceSession;
    await api(s, 'clients.install', 'POST', { params: { provider: 'claude' } }, { expect: [200, 202] });
    // ChatGPT needs nothing installed (Whombat HN-A01): the runtime refuses a Codex install.
    await api(s, 'clients.install', 'POST', { params: { provider: 'codex' } }, { expect: [400] });
    const deadline = Date.now() + 600_000;
    let seen: ClientStatus[] = [];
    while (Date.now() < deadline) {
      seen = await runtimeClients();
      if (seen.find((c) => c.provider === 'claude')?.state === 'installed') break;
      await sleep(2000);
    }
    const m = await managerClients();
    note(ctx, 'installed', {
      manager: m.map((c) => ({
        p: c.provider,
        state: c.state,
        v: c.installed?.version,
        exe: c.installed?.executable.path,
      })),
      runtime: seen,
    });
    const c = seen.find((x) => x.provider === 'claude');
    expect(c?.state, 'claude in clients.list').toBe('installed');
    expect(c?.installed?.version).toBe(m.find((x) => x.provider === 'claude')?.latest?.version);
    expect(seen.map((x) => x.provider)).toEqual(['claude']);
    expect(m.find((x) => x.provider === 'codex')?.installed ?? null).toBeNull();
  }, 660_000);

  it('K2 a Claude sign-in console starts and shows Claude’s own login URL (cancelled, not completed)', async (ctx) => {
    if (why) blocked(ctx, 'whombat-appliance/live-agents', why);
    const s = owner as ApplianceSession;
    const started = await api<Console>(s, 'signins.consoleStart', 'POST', {
      body: { provider: 'claude', authMode: 'subscription_cli', cols: 200, rows: 50 },
    });
    expect(started.state).toBe('running');
    let cursor = 0;
    let text = '';
    let url: string | null = null;
    let last: Console = started;
    const deadline = Date.now() + 90_000;
    while (!url && Date.now() < deadline) {
      const r = await api<{ console: Console; data: string; next: number; more: boolean }>(
        s,
        'signins.consoleRead',
        'GET',
        { params: { consoleId: started.consoleId }, query: { cursor, waitMs: 10_000 } },
        { deadlineMs: 30_000 },
      );
      last = r.console;
      cursor = r.next;
      text += Buffer.from(r.data, 'base64').toString('utf8');
      // The URL may wrap over lines in the terminal: join what follows it until a blank line.
      const flat = plain(text).replace(/\n(?=[^\s])/g, '');
      url =
        /https:\/\/(?:claude\.ai|claude\.com|[a-z.]*anthropic\.com)\/[^\s"']*oauth[^\s"']*/.exec(flat)?.[0] ??
        null;
      if (last.state !== 'running' && !r.more) break;
    }
    const cancelled = await api<Console>(s, 'signins.consoleCancel', 'POST', {
      params: { consoleId: started.consoleId },
    });
    note(ctx, 'console', {
      consoleId: started.consoleId,
      url: url ? `${url.slice(0, 80)}…` : null,
      stateWhileReading: last.state,
      afterCancel: cancelled.state,
      screen: plain(text)
        .split('\n')
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .slice(0, 20),
    });
    expect(
      url,
      `Claude's login URL in the console (last state ${last.state}: ${JSON.stringify(last.error)})`,
    ).toBeTruthy();
    expect(cancelled.state).toBe('cancelled');
  }, 180_000);

  it('K3 a ChatGPT sign-in answers with a device code (cancelled, not completed)', async (ctx) => {
    if (why) blocked(ctx, 'whombat-appliance/live-agents', why);
    const s = owner as ApplianceSession;
    let login = await api<Login>(s, 'signins.loginStart', 'POST', {
      body: { provider: 'codex', authMode: 'chatgpt' },
    });
    const deadline = Date.now() + 60_000;
    while (!login.device && login.state === 'awaiting_user' && Date.now() < deadline) {
      await sleep(1000);
      login = await api<Login>(s, 'signins.loginStatus', 'GET', { params: { loginId: login.loginId } });
    }
    const cancelled = await api<Login>(s, 'signins.loginCancel', 'POST', {
      params: { loginId: login.loginId },
    });
    note(ctx, 'device code', {
      state: login.state,
      verificationUri: login.device?.verificationUri,
      userCode: login.device ? `${login.device.userCode.slice(0, 2)}…` : null,
      error: login.error,
      afterCancel: cancelled.state,
    });
    expect(login.state, JSON.stringify(login.error)).toBe('awaiting_user');
    expect(login.device?.verificationUri).toMatch(/^https:\/\/[a-z.]*openai\.com\//);
    expect(login.device?.userCode).toMatch(/^[A-Z0-9]{3,}-?[A-Z0-9]{3,}$/);
    expect(cancelled.state).toBe('cancelled');
  }, 120_000);

  it('K4 the agent on the person’s own sign-in refuses a turn while they have none: provider.not_signed_in', async (ctx) => {
    if (why) blocked(ctx, 'whombat-appliance/live-agents', why);
    const s = owner as ApplianceSession;
    const signIns = await api<{ signIns: { provider: string }[] }>(s, 'signins.list', 'GET');
    expect(signIns.signIns.filter((x) => x.provider === 'claude')).toEqual([]);
    const { slug, agent } = w as NonNullable<typeof w>;
    expect(agent.runtime?.provider).toBe('claude');
    const events = collect(s, [`burrow:${w?.burrowId}`, `conv:${w?.conversationId}`]);
    await events.waitFor((e) => e.topic.startsWith('conv:'), 3000).catch(() => null);
    const marker = `live-${randomBytes(4).toString('hex')}`;
    await api(s, 'messages.send', 'POST', {
      params: { burrow: slug, conversationId: w?.conversationId },
      body: { text: `@${agent.name} say hello (${marker})`, clientId: marker },
    });
    const reply = (await events.waitFor(
      (e) => {
        const m = (e.event as { message?: { author?: { id: string }; authorId?: string; text?: string } })
          .message;
        return eventType(e) === 'message.created' && (m?.author?.id ?? m?.authorId) === agent.id ? m : null;
      },
      120_000,
      'the agent’s reply',
    )) as { text?: string };
    events.close();
    const row = await psql(
      `select state || '|' || coalesce(error, '') from dispatches where agent_id = '${agent.id}' order by created_at desc limit 1`,
      RUNTIME_DB,
    );
    const [state, error] = row.stdout.trim().split('|');
    note(ctx, 'refusal', {
      agent: { name: agent.name, runtime: agent.runtime },
      dispatch: { state, error },
      reply: reply.text,
    });
    // The person's own sign-in is missing: the agent names the provider and where to sign in.
    expect(reply.text ?? '').toMatch(/haven’t signed in to Claude/);
    expect(state).toBe('failed');
    expect(error).toBe('provider.not_signed_in');
  }, 240_000);

  it('K6 the agent on ChatGPT: its turn is claimed with Hermes ready, nothing installed (refused for a person without a ChatGPT sign-in)', async (ctx) => {
    if (why) blocked(ctx, 'whombat-appliance/live-agents', why);
    const s = owner as ApplianceSession;
    // ChatGPT is ready whenever Hermes is (Whombat HN-C07): the runner says so with Hermes's version, no client.
    const codexReady = /\[runner\] provider codex: Hermes /;
    const readySince = Date.now();
    while (
      !readFileSync(join(paths.logs, 'runner.log'), 'utf8')
        .split('\n')
        .some((l) => codexReady.test(l))
    ) {
      if (Date.now() - readySince > 60_000) throw new Error('the runner never reported ChatGPT ready (60 s)');
      await sleep(500);
    }
    note(ctx, 'chatgpt ready on the runner', { afterMs: Date.now() - readySince });
    // One agent per Whombat (OA-01): the owner puts it on ChatGPT, as in Settings → Agent, and back on Claude after.
    const { slug, burrowId, conversationId } = w as NonNullable<typeof w>;
    await api(s, 'agent.update', 'PATCH', {
      params: { burrow: slug },
      body: { runtime: { provider: 'codex' } },
    });
    const agent = await theAgent(s, slug);
    const events = collect(s, [`burrow:${burrowId}`, `conv:${conversationId}`]);
    await events.waitFor((e) => e.topic.startsWith('conv:'), 3000).catch(() => null);
    const marker = `codex-${randomBytes(4).toString('hex')}`;
    await api(s, 'messages.send', 'POST', {
      params: { burrow: slug, conversationId },
      body: { text: `@${agent.name} say hello (${marker})`, clientId: marker },
    });
    const reply = (await events
      .waitFor(
        (e) => {
          const m = (e.event as { message?: { author?: { id: string }; authorId?: string; text?: string } })
            .message;
          return eventType(e) === 'message.created' && (m?.author?.id ?? m?.authorId) === agent.id ? m : null;
        },
        120_000,
        'the agent’s reply on ChatGPT',
      )
      .catch(() => null)) as { text?: string } | null;
    events.close();
    await api(s, 'agent.update', 'PATCH', {
      params: { burrow: slug },
      body: { runtime: { provider: 'claude' } },
    });
    const row = await psql(
      `select state || '|' || coalesce(error, '') from dispatches where agent_id = '${agent.id}' order by created_at desc limit 1`,
      RUNTIME_DB,
    );
    const [state, error] = row.stdout.trim().split('|');
    const log = readFileSync(join(paths.logs, 'runner.log'), 'utf8').split('\n');
    note(ctx, 'codex turn', {
      agent: { name: agent.name, runtime: agent.runtime },
      dispatch: { state, error },
      reply: reply?.text ?? null,
      runnerCodex: log.filter((l) => l.includes('provider codex')).slice(-2),
    });
    if (error === 'unrunnable:provider' || (!reply && state === 'queued'))
      gap(
        ctx,
        'Whombat/runner',
        `the ChatGPT dispatch is ${state} ${error} although the runner reported ChatGPT ready: the server learns a runner's providers from its claims only (Whombat SUB-53)`,
      );
    // ChatGPT runs on Hermes's own provider (Whombat HN-04) with the person's own ChatGPT sign-in, which is missing.
    expect(reply?.text ?? '', `dispatch ${state} ${error}`).toMatch(/haven’t signed in to ChatGPT/);
    expect(error).toBe('provider.not_signed_in');
  }, 240_000);

  it('K5 a turn on a (planted, empty) Claude subscription home runs Hermes in the person’s profile and the installed Claude Code up to its own login check', async (ctx) => {
    if (why) blocked(ctx, 'whombat-appliance/live-agents', why);
    const s = owner as ApplianceSession;
    const { slug, agent } = w as NonNullable<typeof w>;
    // A test-only stand-in for a completed sign-in: Whombat's own record and an empty config/ (no login in it), so the
    // turn gets past the credential check and Claude Code itself says it isn't logged in. No account, no model call.
    // The person's one Claude home (Whombat one-person.md OP-09: `<credentials root>/claude`), as a sign-in leaves it.
    const root = persistLayout().credentials;
    const home = join(root, 'claude');
    mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    chmodSync(home, 0o700);
    const meta = {
      v: 1,
      provider: 'claude',
      authMode: 'subscription_cli',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      verified: 'valid',
      verifiedAt: new Date().toISOString(),
      creatorAttested: false,
      login: null,
      signal: null,
    };
    writeFileSync(join(home, 'whombat-credential.json'), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
    try {
      const events = collect(s, [`burrow:${w?.burrowId}`, `conv:${w?.conversationId}`]);
      await events.waitFor((e) => e.topic.startsWith('conv:'), 3000).catch(() => null);
      const marker = `planted-${randomBytes(4).toString('hex')}`;
      await api(s, 'messages.send', 'POST', {
        params: { burrow: slug, conversationId: w?.conversationId },
        body: { text: `@${agent.name} say hello (${marker})`, clientId: marker },
      });
      const reply = (await events.waitFor(
        (e) => {
          const m = (e.event as { message?: { author?: { id: string }; authorId?: string; text?: string } })
            .message;
          return eventType(e) === 'message.created' &&
            (m?.author?.id ?? m?.authorId) === agent.id &&
            !/haven’t signed in/.test(m?.text ?? '')
            ? m
            : null;
        },
        180_000,
        'the agent’s reply',
      )) as { text?: string };
      events.close();
      const row = await psql(
        `select state || '|' || coalesce(error, '') || '|' || coalesce(access::text, '') from dispatches where agent_id = '${agent.id}' order by created_at desc limit 1`,
        RUNTIME_DB,
      );
      const [state, error, access] = row.stdout.trim().split('|');
      const log = readFileSync(join(paths.logs, 'runner.log'), 'utf8').split('\n');
      note(ctx, 'planted home', {
        dispatch: { state, error, access },
        reply: reply.text,
        runner: log.filter((l) => l.includes(agent.name)).slice(-6),
      });
      expect(error ?? '').not.toMatch(/sandbox_unavailable|client\.|version_drift|provider_missing/);
      expect(reply.text ?? '').not.toMatch(/sandbox can’t start|shell sandbox cannot run/);
      // The turn went through Hermes, in the person's profile: Hermes's default profile, the root itself (Whombat
      // one-person.md OP-08), where the runner writes its config before every turn.
      expect(existsSync(join(persistLayout().hermes, 'config.yaml'))).toBe(true);
      expect(log.some((l) => /hermes · on Claude/.test(l))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});
