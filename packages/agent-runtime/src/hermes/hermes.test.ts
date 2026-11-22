import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DispatchContext } from '@whombat/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_ACP_AGENT } from '../acp/testing/index';
import type { ToolAsk, TurnEvent, TurnInput, TurnSteer, TurnSteering } from '../contract';
import { base } from '../testing/contexts';
import { expectAllDead, readPids } from '../testing/pids';
import { type StubMcpServer, startStubMcpServer } from '../testing/stub-mcp-server';
import { hermesAssessmentConfig } from './assessment';
import { checkHermes, isScriptedHermes } from './check';
import { hermesConfig } from './config';
import { hermesFeedbackProfile, hermesPersonProfile, lockHermesProfile } from './profile';
import {
  CHATGPT_LEND_RETRY,
  CHATGPT_LEND_UNAVAILABLE,
  CHATGPT_SIGN_IN_AGAIN,
  HERMES_SESSION_PREFIX,
  HermesProvider,
  type HermesProviderOptions,
  lostTurns,
} from './provider';
import { scriptedHermesLauncher } from './testing/index';

const ACCOUNT = 'acc_mara00000000000000000001';
const FAKE_CHATGPT_STEPS = fileURLToPath(
  new URL('../providers/testing/fake-chatgpt-steps.mjs', import.meta.url),
);
const scratch = () => mkdtempSync(join(tmpdir(), 'wb-hermes-test-'));

function context(over: { account?: string | null; session?: string | null } = {}) {
  const account = over.account === undefined ? ACCOUNT : over.account;
  return DispatchContext.parse(
    base({
      dispatch: { ...base().dispatch, trigger: 'dm', providerSessionId: over.session ?? null },
      outside: account === null,
      onBehalfOf: account
        ? {
            person: { id: 'prn_mara', kind: 'person', name: 'Mara', handle: 'mara', title: null },
            accountId: account,
            connections: [],
          }
        : null,
      credential: { v: 1, provider: 'codex', authMode: 'subscription' },
    }),
  );
}

function setup(
  mode: string,
  options: Partial<HermesProviderOptions> = {},
  extraEnv: Record<string, string> = {},
) {
  const dir = scratch();
  const root = join(dir, 'hermes');
  const log = join(dir, 'log.jsonl');
  const pids = join(dir, 'pids.json');
  const provider = new HermesProvider({
    kind: 'codex',
    bin: process.execPath,
    args: [FAKE_ACP_AGENT],
    root,
    env: {
      ...process.env,
      // The fake's own settings reach it the way an operator lists a variable for the providers.
      WHOMBAT_PROVIDER_ENV: 'FAKE_ACP_MODE,FAKE_ACP_LOG,FAKE_ACP_PIDS,FAKE_ACP_WORK_MS,FAKE_ACP_REVIEW_MS',
      FAKE_ACP_MODE: `hermes,${mode}`,
      FAKE_ACP_LOG: log,
      FAKE_ACP_PIDS: pids,
      RUNNER_TOKEN: 'runner-secret',
      DATABASE_URL: 'postgres://whombat:whombat@db/whombat',
      GH_TOKEN: 'gh-secret',
      ...extraEnv,
    },
    killGraceMs: 300,
    cancelGraceMs: 1500,
    ...options,
  });
  const entries = (): Record<string, unknown>[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const received = (method: string) =>
    entries().filter((e) => e.kind === 'recv' && e.method === method) as {
      params: Record<string, unknown>;
    }[];
  const profile = hermesPersonProfile(root);
  // ChatGPT's login is Hermes's own, in the person's profile (HN-03): a stand-in, which only the real Hermes would read.
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  writeFileSync(join(profile, 'auth.json'), '{}', { mode: 0o600 });
  return { dir, root, profile, provider, entries, received, pids };
}

function input(dir: string, extra: Partial<TurnInput> = {}): TurnInput {
  return {
    context: context(),

    prompt: 'What is on my calendar?',
    mcp: { url: 'http://127.0.0.1:1/mcp', token: 'agent-token-123' },
    cwd: dir,
    sandbox: 'workspace-write',
    network: false,
    model: 'gpt-6.1-sol',
    ...extra,
  };
}

async function collect(
  iterable: AsyncIterable<TurnEvent>,
  onEvent?: (e: TurnEvent) => void,
): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of iterable) {
    out.push(e);
    onEvent?.(e);
  }
  return out;
}

const finals = (events: TurnEvent[]) =>
  events.filter((e): e is Extract<TurnEvent, { type: 'final' }> => e.type === 'final').map((e) => e.text);
const error = (events: TurnEvent[]) =>
  events.find((e) => e.type === 'error') as Extract<TurnEvent, { type: 'error' }> | undefined;

/** Follow-ups handed over once the provider opens (the runner's `TurnFollowUps`, in short). */
function steering(items: TurnSteer[], when: () => boolean = () => true) {
  let take: ((s: TurnSteer) => boolean) | null = null;
  const s: TurnSteering & { hand(): void } = {
    open(t) {
      take = t;
    },
    close() {
      take = null;
    },
    hand() {
      if (take && items.length && when()) for (const item of items.splice(0)) take(item);
    },
  };
  return s;
}

describe('Hermes profile config (HE-04, HE-10; the plugin’s config/*.yaml)', () => {
  it('ChatGPT: Hermes’s own openai-codex provider on its loop, review and compression on the same model (HN-02)', () => {
    const c = hermesConfig({ runtime: 'openai_codex', model: 'gpt-6.1-sol', effort: 'high', fast: true });
    expect(c).toMatchObject({
      model: { provider: 'openai-codex', default: 'gpt-6.1-sol' },
      agent: { reasoning_effort: 'high', service_tier: 'fast' },
      plugins: { enabled: ['whombat'] },
      terminal: { backend: 'whombat_commands' },
      // The agent's Chromium is Whombat's (OP-S113): Hermes's browser never follows the terminal into the wrapper.
      bot_desktop: { placement: 'gateway' },
      auth: { adopt_external_logins: false },
      approvals: { mode: 'manual' },
      compression: { enabled: true },
      auxiliary: {
        title_generation: { enabled: false },
        compression: { provider: 'openai-codex', model: 'gpt-6.1-sol' },
        background_review: { enabled: true },
      },
      tools: { tool_search: { enabled: 'off' } },
      updates: { check: false },
      model_catalog: { enabled: false },
      gateway: { standalone: true },
    });
    // Codex mode is gone: no app-server runtime, no launcher, no Codex binary.
    expect(JSON.stringify(c)).not.toMatch(/openai_runtime|codex_bin|codex_app_server/);
    expect(
      hermesConfig({ runtime: 'openai_codex', model: 'gpt-5.5', effort: null, fast: false }).agent,
    ).toEqual({ disabled_toolsets: ['browser-use', 'browser'], service_tier: 'normal' });
    // Absent: Hermes's own default; never on Claude.
    expect(hermesConfig({ runtime: 'openai_codex', model: 'gpt-5.5', effort: null }).agent).toEqual({
      disabled_toolsets: ['browser-use', 'browser'],
    });
    expect(
      hermesConfig({ runtime: 'claude_directsdk', model: 'opus', effort: null, fast: true }).agent,
    ).toEqual({
      disabled_toolsets: ['browser-use', 'browser'],
    });
  });

  it('Claude subscriptions use DirectSDK with Hermes tools, compression and the same provider for upkeep', () => {
    const c = hermesConfig({ runtime: 'claude_directsdk', model: 'opus', effort: null });
    const provider = 'claude-subscription-directsdk-experimental';
    expect(c).toMatchObject({
      model: { provider, default: 'opus' },
      plugins: {
        enabled: ['whombat', provider],
        entries: { [provider]: { settings: { claude_code_telemetry: false } } },
      },
      terminal: { backend: 'whombat_commands' },
      compression: { enabled: true },
      auxiliary: { compression: { provider, model: 'opus' }, background_review: { enabled: true } },
    });
    expect(c.agent).toEqual({ disabled_toolsets: ['browser-use', 'browser'] });
    expect(JSON.stringify(c)).not.toMatch(/claude_bin|claude-cli|turn_timeout/);
  });

  it('every profile lets Whombat’s plugin wrap browser_vault, in both of Hermes’s grant keys', () => {
    const profiles = [
      hermesConfig({ runtime: 'openai_codex', model: 'gpt-5.5', effort: null }),
      hermesConfig({ runtime: 'claude_directsdk', model: null, effort: null }),
      hermesConfig({ runtime: 'openai_codex', model: 'gpt-5.5', effort: null, pod: true }),
    ];
    for (const c of profiles) {
      const whombat = (c.plugins as { entries: Record<string, Record<string, unknown>> }).entries.whombat;
      expect(whombat?.granted_capabilities).toContain('tools.override');
      expect(whombat?.allow_tool_override).toBe(true);
    }
  });

  it('a turn with a browser: the plugin’s tools on the relay, never browser_exec, no password manager (HE-S300)', () => {
    const browser = { cdpUrl: 'http://127.0.0.1:47105', sites: null };
    const c = hermesConfig({ runtime: 'claude_directsdk', model: null, effort: 'high', browser });
    expect(c.browser).toEqual({ cdp_url: 'http://127.0.0.1:47105', allow_private_urls: true });
    expect(c.agent).toEqual({ reasoning_effort: 'high', disabled_toolsets: ['browser-use'] });
    // Whombat's logins are the plugin's login backend; password managers stay off (VLT-20). Not in an outsiders' profile.
    expect(c.vault).toEqual({
      wb: { enabled: true },
      onepassword: { enabled: false },
      bitwarden: { enabled: false },
    });
    expect((c.plugins as { entries: Record<string, unknown> }).entries.whombat).toEqual({
      granted_capabilities: ['tools.override'],
      allow_tool_override: true,
    });
    const outsiders = hermesConfig({
      runtime: 'claude_directsdk',
      model: null,
      effort: null,
      browser,
      outside: true,
    });
    expect((outsiders.vault as { wb: { enabled: boolean } }).wb.enabled).toBe(false);
    // An assessment that may look keeps only Hermes's browser toolset (HE-S140); one that may not, nothing.
    const looking = hermesAssessmentConfig(c, 'claude_directsdk', { browser: true });
    expect(looking.platform_toolsets).toEqual({ acp: ['browser'] });
    expect((looking.agent as { disabled_toolsets: string[] }).disabled_toolsets).not.toContain('browser');
    expect((looking.agent as { disabled_toolsets: string[] }).disabled_toolsets).toContain('terminal');
    expect((looking.agent as { disabled_toolsets: string[] }).disabled_toolsets).toContain('browser-use');
    const blind = hermesAssessmentConfig(c, 'claude_directsdk');
    expect(blind.platform_toolsets).toEqual({ acp: [] });
    expect((blind.agent as { disabled_toolsets: string[] }).disabled_toolsets).toContain('browser');
  });
});

describe('HermesProvider', () => {
  let stub: StubMcpServer;
  beforeAll(async () => {
    stub = await startStubMcpServer({ token: 'agent-token-123' });
  });
  afterAll(async () => {
    await stub.close();
  });

  it('writes the profile, starts Hermes in it with ChatGPT on Hermes’s own login and no runner secrets, and answers', async () => {
    const { dir, root, profile, provider, entries } = setup('');
    const events = await collect(
      provider.runTurn(
        input(dir, {
          credential: {
            workflow: 'PI',
            provider: 'codex',
            authMode: 'chatgpt',
            home: '/homes/mara/codex',
            env: {},
          },
        }),
        new AbortController().signal,
      ),
    );
    expect(finals(events)).toEqual(['Done: What is on my calendar?']);
    const config = JSON.parse(readFileSync(join(profile, 'config.yaml'), 'utf8').replace(/^#.*\n/, ''));
    expect(config.model).toEqual({ provider: 'openai-codex', default: 'gpt-6.1-sol' });
    // The profile's own skills, in Hermes's layout (OP-08): no external directory.
    expect(config.skills).toMatchObject({ project_discovery: false });
    expect(config.skills.external_dirs).toBeUndefined();
    expect(profile).toBe(root);
    // Rendered from the turn's context (persona/prompt.ts, HE-34), not from its system prompt.
    expect(readFileSync(join(profile, 'SOUL.md'), 'utf8')).toContain(context().agent.name);
    expect(readFileSync(join(profile, 'whombat.md'), 'utf8')).toContain('post_message');
    expect(existsSync(join(profile, 'bin', 'codex'))).toBe(false);
    const env = (entries().find((e) => e.kind === 'start') as { env: Record<string, string> }).env;
    expect(env.HERMES_HOME).toBe(profile);
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.WHOMBAT_MCP_TOKEN).toBe('agent-token-123');
    for (const secret of ['RUNNER_TOKEN', 'DATABASE_URL', 'GH_TOKEN']) expect(env[secret]).toBeUndefined();
  });

  it('a turn outsiders’ input started runs in their own profile, remembers nothing and gets no Vault (OP-17)', async () => {
    const { dir, root, provider, entries } = setup('');
    const vaultMcpServers = [
      { name: 'vault_notion', url: 'http://127.0.0.1:9/mcp', headers: [], tools: ['search'] },
    ];
    const outside = input(dir, { context: context({ account: null }), vaultMcpServers });
    expect(await provider.podNeeds(outside)).toBeNull();
    await collect(provider.runTurn(outside, new AbortController().signal));
    const env = (entries().find((e) => e.kind === 'start') as { env: Record<string, string> }).env;
    expect(env.HERMES_HOME).toBe(hermesFeedbackProfile(root));
    expect(JSON.stringify(env)).not.toContain('vault_notion');
    const config = JSON.parse(
      readFileSync(join(hermesFeedbackProfile(root), 'config.yaml'), 'utf8').replace(/^#.*\n/, ''),
    );
    expect(config.memory).toEqual({ memory_enabled: false, user_profile_enabled: false });
    expect(config.auxiliary.background_review).toEqual({ enabled: false });
    expect(config.mcp_servers).toBeUndefined();
    expect(existsSync(join(root, 'config.yaml'))).toBe(false);
  });

  it('a turn outsiders started runs on the person’s ChatGPT access token alone, lent for the turn (OP-S89)', async () => {
    const steps = { command: [process.execPath, FAKE_CHATGPT_STEPS] };
    const { dir, root, provider, entries } = setup('', { chatgptSteps: steps });
    const outside = hermesFeedbackProfile(root);
    const credential = {
      workflow: 'NA',
      provider: 'codex',
      authMode: 'chatgpt',
      home: '/creds/codex',
      env: {},
    } as const;
    let atStart = '';
    const events = await collect(
      provider.runTurn(
        input(dir, {
          context: context({ account: null }),
          credential,
          host: {
            spawn: (command, args, o) => {
              atStart = readFileSync(join(outside, 'auth.json'), 'utf8');
              return spawn(command, [...args], { cwd: o.cwd, env: o.env, stdio: 'pipe' });
            },
          },
        }),
        new AbortController().signal,
      ),
    );
    expect(finals(events)).toHaveLength(1);
    // Hermes started on the lent access token; the person's own login stayed where it is.
    expect(JSON.parse(atStart).credential_pool['openai-codex']).toEqual([
      expect.objectContaining({ auth_type: 'api_key' }),
    ]);
    expect(readFileSync(join(root, 'auth.json'), 'utf8')).toBe('{}');
    const [asked] = readFileSync(join(root, '.fake-lent.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(asked).toEqual({ to: outside, minSeconds: 8 * 3600 });
    expect(
      (entries().find((e) => e.kind === 'start') as { env: Record<string, string> }).env.HERMES_HOME,
    ).toBe(outside);
    // Nothing of it is kept after the turn.
    expect(existsSync(join(outside, 'auth.json'))).toBe(false);
  });

  it('without a lent token a turn outsiders started says why and starts nothing (OP-S89)', async () => {
    const credential = {
      workflow: 'NA',
      provider: 'codex',
      authMode: 'chatgpt',
      home: '/creds/codex',
      env: {},
    } as const;
    const run = async (o: Partial<HermesProviderOptions>, before: (root: string) => void = () => {}) => {
      const s = setup('', o);
      before(s.root);
      const events = await collect(
        s.provider.runTurn(
          input(s.dir, { context: context({ account: null }), credential }),
          new AbortController().signal,
        ),
      );
      expect(s.entries().some((e) => e.kind === 'start')).toBe(false);
      return error(events);
    };
    const steps = { command: [process.execPath, FAKE_CHATGPT_STEPS] };
    // The person isn't signed in to ChatGPT any more.
    expect(await run({ chatgptSteps: steps }, (root) => rmSync(join(root, 'auth.json')))).toMatchObject({
      message: CHATGPT_SIGN_IN_AGAIN,
      retryable: false,
      credentialState: 'auth_revoked',
    });
    // It couldn't be lent just now: tried again.
    expect(
      await run({ chatgptSteps: steps }, (root) => writeFileSync(join(root, '.fake-lend'), 'fail')),
    ).toMatchObject({ message: CHATGPT_LEND_RETRY, retryable: true });
    // No Hermes to lend it with (development's scripted one).
    expect(await run({ chatgptSteps: null })).toMatchObject({
      message: CHATGPT_LEND_UNAVAILABLE,
      retryable: false,
    });
  });

  it('every turn of the person runs in their profile, Hermes’s default one: the root (OP-08)', async () => {
    const { dir, root, provider, entries } = setup('');
    await collect(provider.runTurn(input(dir), new AbortController().signal));
    const env = (entries().find((e) => e.kind === 'start') as { env: Record<string, string> }).env;
    expect(env.HERMES_HOME).toBe(root);
    // Without a sign-in at all (development, the scripted stand-in) it is still the person's.
    const plain = setup('');
    await collect(
      plain.provider.runTurn(
        input(plain.dir, { context: { ...context(), credential: null } }),
        new AbortController().signal,
      ),
    );
    const plainEnv = (plain.entries().find((e) => e.kind === 'start') as { env: Record<string, string> }).env;
    expect(plainEnv.HERMES_HOME).toBe(plain.root);
  });

  it('a turn’s logins are in the profile only during it, never a secret, and Hermes’s own vault goes after (HE-S141)', async () => {
    const { dir, profile, provider, entries } = setup('');
    mkdirSync(join(profile, 'vault'), { recursive: true });
    writeFileSync(join(profile, 'vault', 'vault.json'), '{"saved":"by the agent"}');
    const login = {
      entryId: 'vlt_github',
      name: 'GitHub',
      origin: 'https://github.com',
      username: 'mara@example.com',
      otp: false,
    };
    let during: unknown = null;
    const turn = provider.runTurn(
      input(dir, { browser: { cdpUrl: 'http://127.0.0.1:47105', sites: null, logins: [login] } }),
      new AbortController().signal,
    );
    const events: TurnEvent[] = [];
    for await (const e of turn) {
      events.push(e);
      if (during === null && existsSync(join(profile, 'whombat-logins.json')))
        during = JSON.parse(readFileSync(join(profile, 'whombat-logins.json'), 'utf8'));
    }
    expect(during).toEqual({ logins: [login] });
    expect(existsSync(join(profile, 'whombat-logins.json'))).toBe(false);
    expect(existsSync(join(profile, 'vault'))).toBe(false);
    const config = JSON.parse(readFileSync(join(profile, 'config.yaml'), 'utf8').replace(/^#.*\n/, ''));
    expect(config.browser.cdp_url).toBe('http://127.0.0.1:47105');
    expect(entries().some((e) => e.kind === 'start')).toBe(true);
  });

  it('one Chat thread is one Hermes session: reported as hermes:<id>, resumed without its replayed history', async () => {
    const { dir, provider, received } = setup('');
    const first = await collect(provider.runTurn(input(dir), new AbortController().signal));
    const session = first.find((e) => e.type === 'session') as { sessionId: string };
    expect(session.sessionId.startsWith(HERMES_SESSION_PREFIX)).toBe(true);
    const next = await collect(
      provider.runTurn(input(dir, { resumeSessionId: session.sessionId }), new AbortController().signal),
    );
    expect(received('session/resume')[0]?.params.sessionId).toBe(
      session.sessionId.slice(HERMES_SESSION_PREFIX.length),
    );
    expect(next.find((e) => e.type === 'session')).toEqual(session);
    expect(finals(next)[0]).not.toContain('OLD');
    expect(next.some((e) => e.type === 'tool_call')).toBe(false);
  });

  it('another provider’s session is never resumed; a gone one fails for a fresh retry, or starts fresh', async () => {
    const { dir, provider, received } = setup('');
    await collect(
      provider.runTurn(input(dir, { resumeSessionId: 'claude-uuid' }), new AbortController().signal),
    );
    expect(received('session/resume')).toHaveLength(0);
    expect(received('session/new')).toHaveLength(1);
    const gone = await collect(
      provider.runTurn(
        input(dir, { resumeSessionId: `${HERMES_SESSION_PREFIX}gone` }),
        new AbortController().signal,
      ),
    );
    expect(error(gone)).toMatchObject({ retryable: true });
    const fresh = await collect(
      provider.runTurn(
        input(dir, { resumeSessionId: `${HERMES_SESSION_PREFIX}gone`, freshIfSessionGone: true }),
        new AbortController().signal,
      ),
    );
    expect(finals(fresh)).toHaveLength(1);
  });

  it('Whombat’s tools through the stdio bridge, by their bare names; notices stay out of the reply', async () => {
    const { dir, provider } = setup('stdio-mcp');
    const before = stub.calls.length;
    const events = await collect(
      provider.runTurn(
        input(dir, { mcp: { url: stub.url, token: stub.token } }),
        new AbortController().signal,
      ),
    );
    expect(finals(events)[0]).toContain('mcp=ok');
    expect(stub.calls.slice(before)).toMatchObject([
      { name: 'set_status', authorization: `Bearer ${stub.token}` },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_call', name: 'set_status', category: 'mcp' }),
    );
  });

  it('answers Hermes’s permission cards by Whombat’s policy, its questions with Skip, never “cancelled”', async () => {
    const walled = setup('hermes-permission');
    const yes = await collect(walled.provider.runTurn(input(walled.dir), new AbortController().signal));
    expect(finals(yes)[0]).toContain('exec=allow_once clarify=skip');
    expect(yes).toContainEqual(
      expect.objectContaining({ type: 'permission', allowed: true, target: 'rm -rf build' }),
    );
    expect(yes).toContainEqual(
      expect.objectContaining({ type: 'permission', tool: 'clarify', allowed: false }),
    );
    const again = setup('hermes-permission');
    const command = await collect(again.provider.runTurn(input(again.dir), new AbortController().signal));
    expect(finals(command)[0]).toContain('exec=allow_once');
  });

  it('asks the turn’s person about a key at Ask and answers Hermes with their yes or no (HE-44)', async () => {
    const asked: ToolAsk[] = [];
    const yes = setup('hermes-ask');
    const allowed = await collect(
      yes.provider.runTurn(
        input(yes.dir, {
          askPerson: async (a) => {
            asked.push(a);
            return { allow: true, reason: 'Mara allowed it once' };
          },
        }),
        new AbortController().signal,
      ),
    );
    expect(finals(allowed)[0]).toContain('ask=allow_once');
    expect(asked).toEqual([
      {
        keyId: 'web.browse',
        tool: 'web_search',
        detail: 'opening hours of the Rijksmuseum',
        id: '0123456789abcdef0123456789abcdef',
      },
    ]);
    expect(allowed).toContainEqual(
      expect.objectContaining({ type: 'permission', tool: 'web_search', allowed: true }),
    );
    // The turn's policy is in the profile, from the agent's keys.
    const policy = JSON.parse(readFileSync(join(yes.profile, 'whombat-policy.json'), 'utf8'));
    expect(policy.default).toBe('block');
    const no = setup('hermes-ask');
    const declined = await collect(
      no.provider.runTurn(
        input(no.dir, {
          askPerson: async () => ({
            allow: false,
            reason: 'Mara said no',
            message: 'Mara said no; it didn’t happen.',
          }),
        }),
        new AbortController().signal,
      ),
    );
    expect(finals(declined)[0]).toContain('ask=deny');
    // The plugin's hook reads Whombat's words by the ask's id, not Hermes's “denied” (HE-S149).
    expect(readFileSync(join(no.profile, 'whombat-asks', '0123456789abcdef0123456789abcdef'), 'utf8')).toBe(
      'Mara said no; it didn’t happen.',
    );
    // Nobody to ask: the call doesn't run.
    const nobody = setup('hermes-ask');
    expect(
      finals(await collect(nobody.provider.runTurn(input(nobody.dir), new AbortController().signal)))[0],
    ).toContain('ask=deny');
  });

  it('the turn person’s Vault MCP servers: placeholders in config.yaml, the sign-in only in Hermes’s environment', async () => {
    const s = setup('');
    const secret = 'Bearer ha-llat-secret-0123456789';
    await collect(
      s.provider.runTurn(
        input(s.dir, {
          vaultMcpServers: [
            {
              name: 'vault_abcdefgh',
              url: 'https://ha.example.com/api/mcp?key=q-secret',
              headers: [{ name: 'Authorization', value: secret }],
              tools: ['HassTurnOn'],
            },
          ],
        }),
        new AbortController().signal,
      ),
    );
    const yaml = readFileSync(join(s.profile, 'config.yaml'), 'utf8');
    expect(yaml).not.toContain('ha-llat-secret');
    expect(yaml).not.toContain('q-secret');
    const config = JSON.parse(yaml.split('\n').slice(1).join('\n'));
    expect(config.mcp_servers.vault_abcdefgh).toEqual({
      url: `\${WHOMBAT_VAULT_MCP_0_URL}`,
      headers: { Authorization: `\${WHOMBAT_VAULT_MCP_0_H0}` },
      tools: { include: ['HassTurnOn'] },
    });
    const env = (s.entries().find((e) => e.kind === 'start') as { env: Record<string, string> }).env;
    expect(env.WHOMBAT_VAULT_MCP_0_H0).toBe(secret);
    expect(env.WHOMBAT_VAULT_MCP_0_URL).toBe('https://ha.example.com/api/mcp?key=q-secret');
    // A turn without them has none.
    const plain = setup('');
    await collect(plain.provider.runTurn(input(plain.dir), new AbortController().signal));
    expect(readFileSync(join(plain.profile, 'config.yaml'), 'utf8')).not.toContain('mcp_servers');
  });

  it('Stop while a person is asked gives the ask up and ends the turn', async () => {
    const s = setup('hermes-ask');
    const stop = new AbortController();
    let gaveUp = false;
    const events = await collect(
      s.provider.runTurn(
        input(s.dir, {
          askPerson: (_a, signal) =>
            new Promise((resolve) => {
              signal.addEventListener('abort', () => {
                gaveUp = true;
                resolve({ allow: false, reason: 'stopped' });
              });
              setTimeout(() => stop.abort(), 20);
            }),
        }),
        stop.signal,
      ),
    );
    expect(gaveUp).toBe(true);
    expect(error(events)).toBeUndefined();
    expect(events.some((e) => e.type === 'permission' && e.allowed)).toBe(false);
  });

  it('Stop sends session/cancel, ends without an error and leaves nothing running', async () => {
    const { dir, provider, received, pids } = setup('slow,family');
    const controller = new AbortController();
    const done = collect(provider.runTurn(input(dir), controller.signal));
    const family = await readPids(pids);
    controller.abort();
    const events = await done;
    expect(error(events)).toBeUndefined();
    expect(received('session/cancel')).toHaveLength(1);
    await expectAllDead([family.pid, family.child, family.escaped]);
  });

  it('a follow-up with files waits for the running prompt, then is its next prompt: answer, steered, answer', async () => {
    const { dir, provider, received } = setup('', {}, { FAKE_ACP_WORK_MS: '300' });
    const file = join(dir, 'note.txt');
    writeFileSync(file, 'tomorrow');
    const follow = steering([
      {
        id: 'msg_f1',
        prompt: 'Mara added this: and tomorrow?',
        attachments: [
          { id: 'att_1', path: file, name: 'note.txt', mediaType: 'text/plain', size: 8, kind: 'text' },
        ],
      },
    ]);
    const events = await collect(
      provider.runTurn(input(dir, { steering: follow }), new AbortController().signal),
      () => follow.hand(),
    );
    const order = events.filter((e) => e.type === 'final' || e.type === 'steered').map((e) => e.type);
    expect(order).toEqual(['final', 'steered', 'final']);
    expect(finals(events)[1]).toContain('and tomorrow?');
    expect(received('session/prompt')).toHaveLength(2);
  });

  it('a follow-up goes into the running turn as `/steer`, ChatGPT’s too; Hermes’s notice is the delivery, never the reply', async () => {
    const { dir, provider } = setup('', {}, { FAKE_ACP_WORK_MS: '400' });
    let tooled = false;
    const follow = steering([{ id: 'msg_f2', prompt: 'and BANANA' }], () => tooled);
    const events = await collect(
      provider.runTurn(input(dir, { steering: follow }), new AbortController().signal),
      (e) => {
        if (e.type === 'session') tooled = true;
        follow.hand();
      },
    );
    expect(events).toContainEqual({ type: 'steered', id: 'msg_f2' });
    expect(finals(events)).toHaveLength(1);
    expect(finals(events)[0]).toContain('steered=and BANANA');
    expect(finals(events)[0]).not.toContain('Steer queued');
  });

  it('the gateway’s notice in place of a bare NO_REPLY is not the reply', async () => {
    const { dir, provider } = setup('silence-refused');
    const events = await collect(provider.runTurn(input(dir), new AbortController().signal));
    expect(finals(events)).toEqual(['NO_REPLY']);
  });

  it('a turn Hermes lost is discarded before the prompt goes again', async () => {
    const { dir, provider, received } = setup('lost');
    const events = await collect(provider.runTurn(input(dir), new AbortController().signal));
    expect(finals(events)).toHaveLength(1);
    expect(received('session/prompt').map((p) => (p.params.prompt as { text: string }[])[0]?.text)).toContain(
      '/discard adm_lost1',
    );
    expect(lostTurns(new Error('nothing lost'))).toEqual([]);
  });

  it('says what Hermes said when it fails a turn; a CLI turn without a model names the CLI’s own default (HE-67)', async () => {
    const { dir, provider } = setup('no-model');
    expect(
      error(await collect(provider.runTurn(input(dir), new AbortController().signal)))?.message,
    ).toContain('No model is set');
    const written = (profile: string) =>
      JSON.parse(readFileSync(join(profile, 'config.yaml'), 'utf8').split('\n').slice(1).join('\n'));
    const claude = setup('', { kind: 'claude', settleMs: 0 });
    const viaClaude = await collect(
      claude.provider.runTurn(input(claude.dir, { model: '' }), new AbortController().signal),
    );
    expect(finals(viaClaude)).toHaveLength(1);
    expect(written(claude.profile).model.default).toBe('default');
    const codex = setup('', { defaultModel: () => 'gpt-6.1-sol' });
    const viaCodex = await collect(
      codex.provider.runTurn(input(codex.dir, { model: '' }), new AbortController().signal),
    );
    expect(finals(viaCodex)).toHaveLength(1);
    expect(written(codex.profile).model.default).toBe('gpt-6.1-sol');
    // No list of ChatGPT's models yet: no session Hermes would refuse, a sentence instead.
    const unknown = setup('');
    const refused = await collect(
      unknown.provider.runTurn(input(unknown.dir, { model: '' }), new AbortController().signal),
    );
    expect(error(refused)?.message).toContain('Settings → Agent');
    expect(unknown.received('session/new')).toHaveLength(0);
  });

  it('drops the repeated last sentence, and never posts what came before its own prompt (HE-37)', async () => {
    const { dir, provider } = setup('repeat,stale');
    const events = await collect(provider.runTurn(input(dir), new AbortController().signal));
    const [text] = finals(events);
    expect(text).toBe('Done: What is on my calendar?');
    expect(text).not.toContain('STALE');
  });

  it('a retry loads the session afresh before it tries to resume it (HE-37)', async () => {
    const { dir, provider, entries } = setup('');
    const ctx = context();
    ctx.dispatch = { ...ctx.dispatch, attempts: 2 };
    await collect(
      provider.runTurn(
        input(dir, { context: ctx, resumeSessionId: 'hermes:local-1' }),
        new AbortController().signal,
      ),
    );
    const methods = entries()
      .filter((e) => e.kind === 'recv')
      .map((e) => e.method)
      .filter((m) => m === 'session/load' || m === 'session/resume');
    expect(methods[0]).toBe('session/load');
  });

  it('runs an API key, the AI gateway and a model on the home network on Hermes’s own loop (HE-32)', async () => {
    const configOf = (profile: string) =>
      JSON.parse(readFileSync(join(profile, 'config.yaml'), 'utf8').split('\n').slice(1).join('\n'));
    /** The one loop provider entry, by the name the model block uses (`whombat-<kind>-<hex>`, HN-L06). */
    const loopEntry = (c: {
      model: { provider: string };
      providers: Record<string, Record<string, unknown>>;
    }) => c.providers[c.model.provider] as Record<string, unknown>;
    // The person's API key: the key file of the provider's home, the API's model id.
    const key = setup('', { kind: 'claude', settleMs: 0 });
    const home = join(key.dir, 'cred');
    await collect(
      key.provider.runTurn(
        input(key.dir, {
          model: 'claude-sonnet-5-5',
          credential: {
            workflow: 'PI',
            provider: 'claude',
            authMode: 'api_key',
            home,
            env: {},
          },
        }),
        new AbortController().signal,
      ),
    );
    const k = configOf(key.profile);
    expect(k.model).toMatchObject({ default: 'claude-sonnet-5-5' });
    expect(k.model.provider).toMatch(/^whombat-key-/);
    expect(loopEntry(k)).toMatchObject({ transport: 'anthropic_messages' });
    expect(loopEntry(k).key_cmd).toContain(join(home, 'api-key'));
    // The AI gateway: the relay at the forwarder's origin, the agent token as the key.
    const gw = setup('', { kind: 'codex' });
    await collect(
      gw.provider.runTurn(
        input(gw.dir, {
          gateway: { name: 'Fusebox', baseUrl: 'http://127.0.0.1:47104/ai-gateway/codex/v1', home: gw.dir },
        }),
        new AbortController().signal,
      ),
    );
    expect(loopEntry(configOf(gw.profile))).toMatchObject({
      base_url: 'http://127.0.0.1:47104/ai-gateway/codex/v1',
      key_env: 'WHOMBAT_MCP_TOKEN',
    });
    const native = setup('', { kind: 'claude', settleMs: 0 });
    const nativeEvents = await collect(
      native.provider.runTurn(
        input(native.dir, {
          model: 'claude-opus-5-5',
          gateway: { name: 'Fusebox', baseUrl: 'http://127.0.0.1:47104/ai-gateway/claude', home: native.dir },
        }),
        new AbortController().signal,
      ),
    );
    expect(error(nativeEvents)).toBeUndefined();
    const n = configOf(native.profile);
    expect(n.model).toEqual({ provider: 'whombat-claude-gateway', default: 'claude-opus-5-5' });
    expect(n.providers).toEqual({});
    expect(JSON.stringify(n)).not.toContain('agent-token-123');
    const nativeNeeds = await native.provider.sandboxNeeds(
      input(native.dir, {
        gateway: { name: 'Fusebox', baseUrl: 'http://127.0.0.1:47104/ai-gateway/claude', home: native.dir },
      }),
    );
    expect(nativeNeeds.env?.CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND).toBe(native.provider.cli());
    expect(nativeNeeds.installs?.length).toBeGreaterThan(0);
    // A model on the person's network: its key in the profile, never in the config.
    const local = setup('', { kind: 'local' });
    const ctx = context();
    ctx.localModel = { v: 1, baseUrl: 'http://192.168.1.20:11434/v1', model: 'llama4', apiKey: 'sk-local' };
    await collect(
      local.provider.runTurn(input(local.dir, { context: ctx, model: '' }), new AbortController().signal),
    );
    const l = configOf(local.profile);
    expect(l.model.default).toBe('llama4');
    expect(loopEntry(l)).toMatchObject({ transport: 'chat_completions' });
    expect(JSON.stringify(l)).not.toContain('sk-local');
    expect(readFileSync(join(local.profile, 'local-model.key'), 'utf8').trim()).toBe('sk-local');
    // When `input.model` is cleared on a fallback retry, Hermes uses `local.defaultModel` instead of the rejected override in `local.model`.
    const localRetry = setup('', { kind: 'local' });
    const retryCtx = context();
    retryCtx.localModel = {
      v: 1,
      baseUrl: 'http://192.168.1.20:11434/v1',
      model: 'removed-bg-model',
      defaultModel: 'llama4',
      apiKey: 'sk-local',
    };
    await collect(
      localRetry.provider.runTurn(
        input(localRetry.dir, { context: retryCtx, model: '' }),
        new AbortController().signal,
      ),
    );
    expect(configOf(localRetry.profile).model.default).toBe('llama4');
    expect(
      localRetry.provider.loopSource(
        input(localRetry.dir, { context: retryCtx, model: 'removed-bg-model' }),
        localRetry.profile,
      )?.model,
    ).toBe('removed-bg-model');
    expect(
      localRetry.provider.loopSource(
        input(localRetry.dir, { context: retryCtx, model: undefined }),
        localRetry.profile,
      )?.model,
    ).toBe('llama4');
    // `local` without a model on the person's network doesn't start.
    const none = await collect(
      local.provider.runTurn(input(local.dir, { model: '' }), new AbortController().signal),
    );
    expect(error(none)).toMatchObject({ retryable: false });
  });

  it('never resumes a session saved on the retired claude-cli route, and reuses its sign-in directory (HN-07)', async () => {
    const { dir, provider, entries, received } = setup('legacy-claude', { kind: 'claude', settleMs: 0 });
    const turn = input(dir, {
      model: 'opus',
      resumeSessionId: 'hermes:saved-session',
      credential: {
        workflow: 'PI',
        provider: 'claude',
        authMode: 'subscription_cli',
        home: '/homes/mara/claude',
        env: { CLAUDE_CONFIG_DIR: '/homes/mara/claude/config' },
      },
    });
    // A resumed chat turn carries only what is new: it fails for the server's fresh retry with the whole window.
    const events = await collect(provider.runTurn(turn, new AbortController().signal));
    expect(error(events)).toMatchObject({ retryable: true });
    expect(received('session/set_model')).toHaveLength(0);
    expect(received('session/prompt')).toHaveLength(0);
    // A turn whose prompt carries it all starts a new session instead.
    const fresh = await collect(
      provider.runTurn({ ...turn, freshIfSessionGone: true }, new AbortController().signal),
    );
    expect(finals(fresh)).toHaveLength(1);
    expect(received('session/new')).toHaveLength(1);
    const session = fresh.find((e) => e.type === 'session') as { sessionId: string };
    expect(session.sessionId).not.toBe('hermes:saved-session');
    const env = (entries().find((e) => e.kind === 'start') as { env: Record<string, string> }).env;
    expect(env.CLAUDE_CONFIG_DIR).toBe('/homes/mara/claude/config');
    expect(env.CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND).toBe(provider.cli());
  });

  it('moves a resumed session to the turn’s model before the prompt, Hermes’s check of it answered yes (HN-07)', async () => {
    const { dir, provider, entries, received } = setup('other-model,confirm-model', {
      kind: 'claude',
      settleMs: 0,
    });
    const events = await collect(
      provider.runTurn(
        input(dir, { model: 'opus', resumeSessionId: 'hermes:saved-session' }),
        new AbortController().signal,
      ),
    );
    expect(finals(events)).toHaveLength(1);
    expect(events.find((e) => e.type === 'session')).toEqual({
      type: 'session',
      sessionId: 'hermes:saved-session',
    });
    expect(received('session/set_model')[0]?.params).toEqual({
      sessionId: 'saved-session',
      modelId: 'claude-subscription-directsdk-experimental:opus',
    });
    const order = entries()
      .filter((e) => e.kind === 'recv' && (e.method === 'session/set_model' || e.method === 'session/prompt'))
      .map((e) => e.method);
    expect(order[0]).toBe('session/set_model');
    // Hermes's card for Whombat's own switch: yes, and not one of the turn's permissions.
    const answer = entries().find((e) => e.kind === 'recv' && e.id === 5000 && !e.method) as
      | { result: unknown }
      | undefined;
    expect(answer?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    expect(events.some((e) => e.type === 'permission')).toBe(false);

    // On the session's own model nothing is set.
    const same = setup('other-model', { kind: 'claude', settleMs: 0 });
    await collect(
      same.provider.runTurn(
        input(same.dir, { model: 'sonnet', resumeSessionId: 'hermes:saved-session' }),
        new AbortController().signal,
      ),
    );
    expect(same.received('session/set_model')).toHaveLength(0);

    // A model Hermes won't move it to: not resumed, the turn fails for a fresh retry.
    const refused = setup('other-model,refuse-model', { kind: 'claude', settleMs: 0 });
    const failed = await collect(
      refused.provider.runTurn(
        input(refused.dir, { model: 'fable', resumeSessionId: 'hermes:saved-session' }),
        new AbortController().signal,
      ),
    );
    expect(error(failed)).toMatchObject({ retryable: true });
    expect(refused.received('session/prompt')).toHaveLength(0);
  });

  it('a ChatGPT thread resumed after its model changed moves to it; a Codex-mode session is never resumed (HN-02, HN-07)', async () => {
    const { dir, provider, received } = setup('chatgpt-model');
    const moved = await collect(
      provider.runTurn(
        input(dir, { model: 'gpt-5.5', resumeSessionId: 'hermes:saved-session' }),
        new AbortController().signal,
      ),
    );
    expect(finals(moved)).toHaveLength(1);
    expect(received('session/set_model')[0]?.params).toEqual({
      sessionId: 'saved-session',
      modelId: 'openai-codex:gpt-5.5',
    });
    // On the session's own model nothing is set.
    const same = setup('chatgpt-model');
    await collect(
      same.provider.runTurn(
        input(same.dir, { model: 'gpt-6-sol', resumeSessionId: 'hermes:saved-session' }),
        new AbortController().signal,
      ),
    );
    expect(same.received('session/set_model')).toHaveLength(0);
    // A thread Codex mode answered (`openai:`): another provider, so a fresh session with the whole window.
    const old = setup('codex-mode');
    const refused = await collect(
      old.provider.runTurn(
        input(old.dir, { model: 'gpt-6-sol', resumeSessionId: 'hermes:saved-session' }),
        new AbortController().signal,
      ),
    );
    expect(error(refused)).toMatchObject({ retryable: true });
    expect(old.received('session/prompt')).toHaveLength(0);
    const fresh = await collect(
      old.provider.runTurn(
        input(old.dir, {
          model: 'gpt-6-sol',
          resumeSessionId: 'hermes:saved-session',
          freshIfSessionGone: true,
        }),
        new AbortController().signal,
      ),
    );
    expect(finals(fresh)).toHaveLength(1);
    expect(old.received('session/new')).toHaveLength(1);
  });

  it('a Feedback assessment is read-only on Hermes, in its own profile (HE-36, HN-W14)', async () => {
    const { dir, profile, provider } = setup('');
    const ctx = context();
    ctx.dispatch = { ...ctx.dispatch, trigger: 'feedback' };
    expect(await provider.podNeeds(input(dir, { context: ctx }))).toBeNull();
    await collect(provider.runTurn(input(dir, { context: ctx }), new AbortController().signal));
    const own = hermesFeedbackProfile(profile);
    expect(existsSync(join(profile, 'config.yaml'))).toBe(false);
    const config = JSON.parse(readFileSync(join(own, 'config.yaml'), 'utf8').split('\n').slice(1).join('\n'));
    expect(config.platform_toolsets).toEqual({ acp: [] });
    expect(config.auxiliary.background_review).toEqual({ enabled: false });
    expect(config.memory).toEqual({ memory_enabled: false, user_profile_enabled: false });
  });

  it('a ChatGPT turn without Hermes’s login in the profile asks for a new sign-in and starts nothing (HN-03)', async () => {
    const { dir, profile, provider, entries } = setup('');
    rmSync(join(profile, 'auth.json'));
    const credential = {
      workflow: 'PI',
      provider: 'codex',
      authMode: 'chatgpt',
      home: '/homes/mara/codex',
      env: {},
    } as const;
    const events = await collect(provider.runTurn(input(dir, { credential }), new AbortController().signal));
    expect(error(events)).toMatchObject({
      message: CHATGPT_SIGN_IN_AGAIN,
      retryable: false,
      credentialState: 'auth_revoked',
    });
    expect(entries().some((e) => e.kind === 'start')).toBe(false);
  });

  it('when the plugin marks a review running, the turn says answered and waits for it to end (HN-08)', async () => {
    const { dir, profile, provider, entries } = setup(
      'review',
      { settleMs: 10_000 },
      { FAKE_ACP_REVIEW_MS: '700' },
    );
    // A marker a killed Hermes left behind is no review of this turn's.
    mkdirSync(join(profile, 'whombat-review'), { recursive: true });
    writeFileSync(join(profile, 'whombat-review', 'stale'), '');
    const reviewingAtAnswer: boolean[] = [];
    const events = await collect(provider.runTurn(input(dir), new AbortController().signal), (event) => {
      if (event.type === 'final' || event.type === 'answered')
        reviewingAtAnswer.push(readdirSync(join(profile, 'whombat-review')).length > 0);
    });
    const order = events.filter((e) => ['final', 'answered'].includes(e.type)).map((e) => e.type);
    expect(order).toEqual(['final', 'answered']);
    expect(entries().some((e) => e.kind === 'review')).toBe(true);
    expect(reviewingAtAnswer).toEqual([true, true]);
    expect(readdirSync(join(profile, 'whombat-review'))).toEqual([]);
    // No review: the answer ends the turn, nothing waited for (no `answered` before an upkeep).
    const plain = setup('');
    const quick = await collect(plain.provider.runTurn(input(plain.dir), new AbortController().signal));
    expect(quick.map((e) => e.type)).not.toContain('answered');
    expect(finals(quick)).toHaveLength(1);
  });

  it('a Hermes that dies during the review after its answer doesn’t fail the answered turn', async () => {
    const { dir, provider } = setup(
      'review,review-dies',
      { settleMs: 10_000 },
      { FAKE_ACP_REVIEW_MS: '5000' },
    );
    const started = Date.now();
    const events = await collect(provider.runTurn(input(dir), new AbortController().signal));
    expect(events.filter((e) => ['final', 'answered'].includes(e.type)).map((e) => e.type)).toEqual([
      'final',
      'answered',
    ]);
    expect(error(events)).toBeUndefined();
    // It ended with the process, not after the whole settle.
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it('one Hermes per profile: a second turn of the same person waits, then gives up retryably', async () => {
    const { dir, root, profile, provider } = setup('', { lockWaitMs: 100 });
    const held = await lockHermesProfile(root, profile, { holder: 'dsp_other' });
    try {
      const events = await collect(provider.runTurn(input(dir), new AbortController().signal));
      expect(error(events)).toMatchObject({ retryable: true });
    } finally {
      await held.release();
    }
    const after = await collect(provider.runTurn(input(dir), new AbortController().signal));
    expect(finals(after)).toHaveLength(1);
  });

  it('managed: the profile is the task’s one writable state dir, with HERMES_HOME and the bridge inside', async () => {
    const { dir, profile, provider } = setup('');
    const needs = await provider.sandboxNeeds(input(dir));
    expect(needs.stateDirs).toEqual([profile]);
    expect(needs.env).toMatchObject({ HERMES_HOME: profile });
    expect(needs.readable).toEqual([expect.stringMatching(/hermes$/)]);
  });

  it('the runner’s own folders in the person’s profile are out of Hermes’s sight; the outsiders’ have none (OP-08)', async () => {
    const { dir, root, provider } = setup('');
    const needs = await provider.sandboxNeeds(input(dir));
    expect(needs.denied).toEqual(expect.arrayContaining([join(root, 'profiles'), join(root, 'locks')]));
    // Made before the sandbox opens, so nothing made later shows through the profile's mount.
    for (const d of needs.denied ?? []) expect(existsSync(d)).toBe(true);
    const pod = await provider.podNeeds(input(dir));
    expect(pod?.denied).toEqual(needs.denied);
    const outside = await provider.sandboxNeeds(input(dir, { context: context({ account: null }) }));
    expect(outside.stateDirs).toEqual([hermesFeedbackProfile(root)]);
    expect(outside.denied).toEqual([]);
  });
});

describe('checkHermes (HE-01, HE-46)', () => {
  /** A `hermes` that prints `line` for `--version`. */
  const fake = (dir: string, line: string) => {
    const bin = join(dir, 'hermes');
    writeFileSync(bin, `#!/bin/sh\necho '${line}'\n`, { mode: 0o755 });
    return bin;
  };

  it('the pinned release is ready; another is outdated; the scripted stand-in says it is scripted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-hermes-check-'));
    const root = join(dir, 'root');
    const real = await checkHermes({
      bin: fake(dir, 'Hermes Agent v0.22.5 (2026.9.24) · stable'),
      root,
      version: '0.22.5',
    });
    expect(real).toMatchObject({ ready: true, version: '0.22.5', problem: null });
    expect(isScriptedHermes(real.version)).toBe(false);
    const old = await checkHermes({
      bin: fake(dir, 'Hermes Agent v0.22.4 (2026.9.20) · stable'),
      root,
      version: '0.22.5',
    });
    expect(old).toMatchObject({ ready: false, problem: 'outdated' });
    const missing = await checkHermes({ bin: join(dir, 'nope'), root });
    expect(missing).toMatchObject({ ready: false, problem: 'missing' });
    const scripted = await checkHermes({
      bin: await scriptedHermesLauncher(mkdtempSync(join(dir, 's-'))),
      root,
    });
    expect(scripted.ready).toBe(true);
    expect(isScriptedHermes(scripted.version)).toBe(true);
  });
});

describe('HermesProvider in a person’s pod (hermes-native.md HN-W01…HN-W13)', () => {
  /** The pod as the runner hands it in: its viewer is the fake started here, every bind noted. */
  function podInput(dir: string, extra: Partial<TurnInput> = {}) {
    const bound: string[] = [];
    const viewers: string[] = [];
    const turn = input(dir, {
      host: {
        spawn: (command, args, o) => {
          viewers.push(o.cwd ?? '');
          return spawn(command, [...args], { cwd: o.cwd, env: o.env, stdio: 'pipe' });
        },
      },
      pod: {
        mcpUrl: 'http://127.0.0.1:47100/mcp',
        spawnAcp: () => {
          throw new Error('the provider spawns through host.spawn');
        },
        bind: (session) => bound.push(session),
      },
      ...extra,
    });
    return { turn, bound, viewers };
  }

  it('replaces a resumed session’s tool policy with a block-all policy for answer recovery', async () => {
    const { dir, profile, provider } = setup('');
    const { turn, bound } = podInput(dir);
    const first = await collect(provider.runTurn(turn, new AbortController().signal));
    const session = first.find((event) => event.type === 'session');
    if (session?.type !== 'session') throw new Error('the original turn did not start a session');
    const recovery = await collect(
      provider.runTurn(
        { ...turn, resumeSessionId: session.sessionId, replyOnly: true },
        new AbortController().signal,
      ),
    );
    expect(error(recovery)).toBeUndefined();
    expect(bound).toHaveLength(2);
    expect(bound[1]).toBe(bound[0]);
    const policy = JSON.parse(
      readFileSync(join(profile, 'whombat-turns', bound[1] as string, 'policy.json'), 'utf8'),
    );
    expect(policy).toMatchObject({ default: 'block', rules: [{ tools: ['*'], action: 'block' }] });
    expect(policy.rules).toHaveLength(1);
  });

  it('takes no profile lock, binds its session and writes the session’s own policy and logins', async () => {
    const { dir, profile, provider } = setup('');
    // A Hermes-home step or another holder of the profile: a pod turn never waits for it (the pod holds the profile).
    const held = await lockHermesProfile(profile, profile, { holder: 'test' });
    try {
      const { turn, bound } = podInput(dir, {
        browser: {
          cdpUrl: 'http://127.0.0.1:47105',
          sites: null,
          logins: [
            { entryId: 'vlt_gh', name: 'GitHub', origin: 'https://github.com', username: 'm', otp: false },
          ],
        },
        vaultMcpServers: [
          {
            name: 'vault_linear',
            url: 'https://mcp.linear.app/mcp',
            headers: [{ name: 'Authorization', value: 'Bearer vault-secret' }],
            tools: ['list_issues'],
          },
        ],
      });
      const events = await collect(provider.runTurn(turn, new AbortController().signal));
      expect(error(events)).toBeUndefined();
      expect(bound).toHaveLength(1);
      const session = bound[0] as string;
      const files = join(profile, 'whombat-turns', session);
      const policy = JSON.parse(readFileSync(join(files, 'policy.json'), 'utf8'));
      // The Vault server's own tool only, the other keys' blocked; the browser allowed as the turn has one.
      expect(JSON.stringify(policy.rules)).toContain('mcp__editor_vault_linear_');
      expect(
        policy.rules.find((r: { tools: string[] }) => r.tools.includes('mcp__editor_vault_*'))?.action,
      ).toBe('block');
      expect(JSON.parse(readFileSync(join(files, 'logins.json'), 'utf8')).logins[0]).toMatchObject({
        entryId: 'vlt_gh',
      });
      expect(readFileSync(join(files, 'logins.json'), 'utf8')).not.toContain('secret');
      // Nothing of the turn in the profile's own files: no profile policy, no logins file, no MCP server.
      expect(existsSync(join(profile, 'whombat-policy.json'))).toBe(false);
      expect(existsSync(join(profile, 'whombat-logins.json'))).toBe(false);
      const config = readFileSync(join(profile, 'config.yaml'), 'utf8');
      expect(config).not.toContain('vault-secret');
      const parsed = JSON.parse(config.split('\n').slice(1).join('\n'));
      expect(parsed.mcp_servers).toBeUndefined();
      expect(parsed.gateway.unmanaged_idle_exit_seconds).toBe(0);
      expect(parsed.agent.agent_cache).toEqual({ max_size: 16, idle_ttl_secs: 1800 });
      expect(parsed.plugins.enabled).toContain('claude-subscription-directsdk-experimental');
      expect(parsed.browser.cdp_url).toBe('http://127.0.0.1:47105');
    } finally {
      await held.release();
    }
  });

  it('gives the session the Vault’s servers as its own, with the turn’s sign-ins', async () => {
    const { dir, provider, received } = setup('');
    const { turn } = podInput(dir, {
      vaultMcpServers: [
        {
          name: 'vault_linear',
          url: 'https://mcp.linear.app/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer vault-secret' }],
          tools: ['list_issues'],
        },
      ],
    });
    await collect(provider.runTurn(turn, new AbortController().signal));
    const servers = received('session/new')[0]?.params.mcpServers as { name: string; type?: string }[];
    expect(servers.map((s) => s.name)).toEqual(['whombat', 'vault_linear']);
    expect(servers[1]).toMatchObject({ type: 'http', url: 'https://mcp.linear.app/mcp' });
  });

  it('pins a resumed session’s effort for this session alone, and posts nothing of it (HN-L11)', async () => {
    const { dir, provider, received } = setup('chatgpt-model');
    const { turn } = podInput(dir, {
      model: 'gpt-6-sol',
      resumeSessionId: 'hermes:saved-session',
      context: {
        ...context(),
        agent: { ...context().agent, runtime: { ...context().agent.runtime, effort: 'high' } },
      },
      fast: true,
      credential: undefined,
    });
    const events = await collect(provider.runTurn(turn, new AbortController().signal));
    const prompts = received('session/prompt').map(
      (p) => ((p.params.prompt as { text?: string }[])[0]?.text ?? '') as string,
    );
    expect(prompts[0]).toBe('/reasoning high');
    expect(prompts[1]).toBe('/fast fast');
    expect(finals(events).join('')).not.toMatch(/reasoning|fast/);
  });

  it('ends at its answer while a review runs on in the gateway (HN-W13)', async () => {
    const { dir, provider } = setup('review', {}, { FAKE_ACP_REVIEW_MS: '5000' });
    const { turn } = podInput(dir);
    const started = Date.now();
    const events = await collect(provider.runTurn(turn, new AbortController().signal));
    expect(events.some((e) => e.type === 'answered')).toBe(false);
    expect(finals(events)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
