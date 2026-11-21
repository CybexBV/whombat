/**
 * Hermes's configuration for a Feedback assessment (HE-36) and for turns on its own loop (HE-08, HE-32): the facts the
 * turn depends on (checked against Hermes v0.22.5's own resolver while writing them: `providers.whombat-<kind>-<hex>`
 * resolves to the named custom runtime with the transport, URL and key below, and `platform_toolsets.acp: []` leaves
 * an ACP session none of Hermes's toolsets).
 */
import { describe, expect, it } from 'vitest';
import { checkDestination, endpointAllowance, withAllowance } from '../access/managed/egress';
import { hermesAssessmentConfig } from './assessment';
import { CLAUDE_DIRECTSDK_PROVIDER, CLAUDE_GATEWAY_PROVIDER } from './claude';
import { hermesConfig } from './config';
import { hermesLoopConfig, hermesLoopEndpoint, hermesLoopProviderName } from './own-loop';

const claude = hermesConfig({ runtime: 'claude_directsdk', model: 'sonnet', effort: 'high' });
const codex = hermesConfig({ runtime: 'openai_codex', model: 'gpt-5.5', effort: null, fast: true });
type Conf = Record<string, Record<string, unknown>>;

describe('a Feedback assessment on Hermes (HE-36)', () => {
  it('DirectSDK exposes only feedback tools; none of Hermes’s own tools; nothing remembered or learned', () => {
    const c = hermesAssessmentConfig(claude, 'claude_directsdk') as Conf;
    expect(c.plugins).toEqual(claude.plugins);
    expect(c.platform_toolsets).toEqual({ acp: [] });
    expect(c.agent?.disabled_toolsets).toEqual(
      expect.arrayContaining(['terminal', 'file', 'web', 'browser', 'memory', 'skills', 'code_execution']),
    );
    expect(c.agent?.reasoning_effort).toBe('high');
    expect(c.memory).toEqual({ memory_enabled: false, user_profile_enabled: false });
    expect((c.auxiliary as Conf).background_review).toEqual({ enabled: false });
    expect((c.auth as { adopt_external_logins: boolean }).adopt_external_logins).toBe(false);
    expect(c.model).toEqual(claude.model);
  });

  it('ChatGPT the same way: none of Hermes’s own tools, nothing learned, its own provider kept', () => {
    const c = hermesAssessmentConfig(codex, 'openai_codex') as Conf;
    expect(c.platform_toolsets).toEqual({ acp: [] });
    expect(c.plugins).toEqual(codex.plugins);
    expect(c.model).toEqual({ provider: 'openai-codex', default: 'gpt-5.5' });
    expect(c.memory).toEqual({ memory_enabled: false, user_profile_enabled: false });
    expect((c.auxiliary as Conf).background_review).toEqual({ enabled: false });
    // An assessor that may look at the reported website keeps Hermes's browser toolset (HE-S140).
    const looking = hermesAssessmentConfig(codex, 'openai_codex', { browser: true }) as Conf;
    expect(looking.platform_toolsets).toEqual({ acp: ['browser'] });
  });
});

describe('turns on Hermes’s own loop (HE-08, HE-32)', () => {
  /** The one provider entry, under the name the model block uses. */
  const provider = (c: Record<string, unknown>) =>
    (c.providers as Record<string, Record<string, unknown>>)[
      (c.model as { provider: string }).provider
    ] as Record<string, unknown>;

  it('an organisation key: the provider’s own API, the key read from its file, never a CLI', () => {
    const anthropic = {
      kind: 'key',
      api: 'anthropic',
      model: 'claude-sonnet-4-5',
      keyFile: '/k/api key',
    } as const;
    const c = hermesLoopConfig(claude, anthropic);
    expect(c.model).toEqual({ provider: hermesLoopProviderName(anthropic), default: 'claude-sonnet-4-5' });
    expect(Object.keys(c.providers as object)).toEqual([hermesLoopProviderName(anthropic)]);
    expect(provider(c)).toMatchObject({
      base_url: 'https://api.anthropic.com',
      transport: 'anthropic_messages',
      key_cmd: "cat '/k/api key'",
    });
    expect(c.plugins).toMatchObject({ enabled: ['whombat'], auto_update_check_hours: 0 });
    expect(JSON.stringify(c)).not.toMatch(
      /claude_bin|codex_bin|openai_runtime|openai-codex|service_tier|claude-subscription-directsdk/,
    );
    const openai = hermesLoopConfig(codex, { kind: 'key', api: 'openai', model: 'gpt-5.5', keyFile: '/k' });
    expect(provider(openai)).toMatchObject({
      base_url: 'https://api.openai.com/v1',
      transport: 'codex_responses',
    });
    // ChatGPT's own provider and its fast replies stay with the subscription.
    expect(JSON.stringify(openai)).not.toMatch(/openai-codex|service_tier/);
    const compatible = hermesLoopConfig(codex, {
      kind: 'key',
      api: 'openai',
      model: 'llama',
      keyFile: '/k',
      baseUrl: 'https://models.example.com/v1/',
    });
    expect(provider(compatible)).toMatchObject({
      base_url: 'https://models.example.com/v1',
      transport: 'chat_completions',
    });
  });

  it('the AI gateway: Claude Code through DirectSDK, Codex through the Responses client', () => {
    const origin = 'http://127.0.0.1:47104';
    const a = hermesLoopConfig(claude, {
      kind: 'gateway',
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      origin,
    });
    expect(a.model).toEqual({ provider: CLAUDE_GATEWAY_PROVIDER, default: 'claude-sonnet-4-5' });
    expect(a.providers).toEqual({});
    const plugins = a.plugins as Conf;
    expect(plugins.enabled).toContain(CLAUDE_DIRECTSDK_PROVIDER);
    expect((plugins.entries as Conf)[CLAUDE_DIRECTSDK_PROVIDER]?.settings).toMatchObject({
      claude_code_telemetry: false,
      whombat_gateway: { base_url: `${origin}/ai-gateway/claude`, pod: false },
    });
    expect((a.auxiliary as Conf).compression).toEqual({
      provider: CLAUDE_GATEWAY_PROVIDER,
      model: 'claude-sonnet-4-5',
    });
    const o = hermesLoopConfig(codex, {
      kind: 'gateway',
      provider: 'codex',
      model: 'gpt-5.5',
      origin: `${origin}/`,
    });
    expect(provider(o)).toMatchObject({
      base_url: `${origin}/ai-gateway/codex/v1`,
      transport: 'codex_responses',
    });
    expect(hermesLoopEndpoint({ kind: 'gateway', provider: 'codex', model: 'm', origin })).toBeNull();
  });

  it('a pod keeps its native gateway available beside personal sessions and their reviews', () => {
    const pod = hermesConfig({ runtime: 'openai_codex', model: 'gpt-6', effort: null, pod: true });
    const c = hermesLoopConfig(
      pod,
      { kind: 'local', model: 'llama', baseUrl: 'http://model:11434/v1' },
      { pod: true },
    );
    const plugins = c.plugins as Conf;
    expect((plugins.entries as Conf)[CLAUDE_DIRECTSDK_PROVIDER]?.settings).toMatchObject({
      whombat_gateway: { base_url: 'http://127.0.0.1:47104/ai-gateway/claude', pod: true },
    });
    expect(JSON.stringify(c)).not.toContain('agent-token');
  });

  it('a model on the network: Chat Completions, no key unless it has one; commands in their wrapper', () => {
    const c = hermesLoopConfig(claude, {
      kind: 'local',
      model: 'qwen3:32b',
      baseUrl: 'http://192.168.1.20:11434/v1',
    });
    expect(provider(c)).toMatchObject({
      base_url: 'http://192.168.1.20:11434/v1',
      transport: 'chat_completions',
      api_key: 'no-key-required',
    });
    expect(c.terminal).toEqual({ backend: 'whombat_commands' });
    expect(c.compression).toEqual({ enabled: true });
    expect((c.auxiliary as Conf).compression).toEqual({
      provider: (c.model as { provider: string }).provider,
      model: 'qwen3:32b',
    });
    expect((c.auxiliary as Conf).background_review).toEqual({ enabled: true });
    expect(c.auth).toEqual(claude.auth);
  });
});

describe('a loop provider’s name says its route (HN-L06)', () => {
  it('one name per endpoint and wire shape, the same for every model there', () => {
    const origin = 'http://127.0.0.1:47104';
    const names = [
      hermesLoopProviderName({ kind: 'key', api: 'anthropic', model: 'claude-sonnet-4-5', keyFile: '/k' }),
      hermesLoopProviderName({ kind: 'key', api: 'openai', model: 'gpt-5.5', keyFile: '/k' }),
      hermesLoopProviderName({ kind: 'gateway', provider: 'claude', model: 'claude-sonnet-4-5', origin }),
      hermesLoopProviderName({ kind: 'gateway', provider: 'codex', model: 'gpt-5.5', origin }),
      hermesLoopProviderName({ kind: 'local', model: 'qwen3:32b', baseUrl: 'http://192.168.1.20:11434/v1' }),
      hermesLoopProviderName({ kind: 'local', model: 'qwen3:32b', baseUrl: 'http://192.168.1.21:11434/v1' }),
    ];
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toMatch(/^whombat-key-[0-9a-f]{8}$/);
    expect(names[4]).toMatch(/^whombat-local-/);
    // Another model, or another key file, is the same route.
    expect(
      hermesLoopProviderName({ kind: 'key', api: 'anthropic', model: 'claude-opus-4-5', keyFile: '/other' }),
    ).toBe(names[0]);
  });
});

describe('the sandbox’s egress for a model’s own endpoint (HE-S52)', () => {
  const policy = { allow: ['api.anthropic.com'] };
  const resolve = async (h: string) =>
    h === 'ollama.lan' || h === 'models.home.example'
      ? [{ address: '192.168.1.20', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }];

  it('opens exactly that address and port, by name or address, and nothing like it', async () => {
    const named = await endpointAllowance('http://models.home.example:11434/v1', resolve);
    expect(named?.url).toBe('http://models.home.example:11434/v1');
    const byName = withAllowance(policy, named);
    expect((await checkDestination('models.home.example', 11434, byName, resolve)).ok).toBe(true);
    expect((await checkDestination('192.168.1.20', 11434, byName, resolve)).ok).toBe(true);
    expect((await checkDestination('192.168.1.20', 22, byName, resolve)).ok).toBe(false);
    expect((await checkDestination('192.168.1.21', 11434, byName, resolve)).ok).toBe(false);
    // A local name the proxy never resolves: the turn gets the address it resolved to.
    const local = await endpointAllowance('http://ollama.lan:11434/v1', resolve);
    expect(local).toMatchObject({ allow: [], url: 'http://192.168.1.20:11434/v1' });
    expect((await checkDestination('192.168.1.20', 11434, withAllowance(policy, local), resolve)).ok).toBe(
      true,
    );
    expect(await endpointAllowance('https://ollama.lan/v1', resolve)).toBeNull();
    const byAddress = withAllowance(policy, await endpointAllowance('http://192.168.1.20:11434/v1'));
    expect((await checkDestination('192.168.1.20', 11434, byAddress, resolve)).ok).toBe(true);
    expect((await checkDestination('api.anthropic.com', 8080, byAddress, resolve)).ok).toBe(false);
  });

  it('never this host or the metadata service', async () => {
    expect(await endpointAllowance('http://127.0.0.1:11434/v1')).toBeNull();
    expect(await endpointAllowance('http://169.254.169.254/latest')).toBeNull();
    expect(await endpointAllowance('http://localhost.example:11434/v1', resolve)).toBeNull();
    expect(await endpointAllowance('file:///etc/passwd')).toBeNull();
    expect(withAllowance(policy, null)).toBe(policy);
  });
});
