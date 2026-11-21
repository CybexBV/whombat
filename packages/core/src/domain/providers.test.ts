import { describe, expect, it } from 'vitest';
import {
  agentsBlockedNotice,
  ENGINE_PROBLEM_COPY,
  providerFix,
  providerStateLabel,
  unrunnableReply,
} from '../text/copy.js';
import {
  type AgentSetupStatus,
  agentsCanReply,
  defaultAgentProvider,
  HERMES_PROBLEMS,
  HermesCheck,
  LIVE_PROVIDERS,
  PROVIDER_LABELS,
  providerRunnable,
  RunnerStatus,
} from './providers.js';
import {
  ConsoleInputText,
  ConsoleOutputData,
  PROVIDER_CONSOLE_INPUT_MAX_BYTES,
  utf8ByteLength,
} from './signins.js';

const READY: HermesCheck = { ready: true, version: '0.22.5', problem: null, detail: null };

const status = (
  over: Partial<Pick<AgentSetupStatus, 'runner' | 'hermes' | 'providers'>> = {},
): Pick<AgentSetupStatus, 'runner' | 'hermes' | 'providers'> => ({
  runner: { connected: true, seenAt: null },
  hermes: READY,
  providers: [
    { provider: 'claude', state: 'logged_out', version: null, detail: null, sandboxProblem: null },
    { provider: 'codex', state: 'ready', version: 'Hermes 0.22.5', detail: null, sandboxProblem: null },
  ],
  ...over,
});

describe('AI providers', () => {
  it('a new agent gets the first ready provider, Claude Code first', () => {
    expect(defaultAgentProvider(status().providers)).toBe('codex');
    expect(
      defaultAgentProvider([
        { provider: 'claude', state: 'ready' },
        { provider: 'codex', state: 'ready' },
      ]),
    ).toBe('claude');
    expect(defaultAgentProvider([])).toBe('claude');
  });

  it('agents reply only with a runner and a ready provider', () => {
    expect(agentsCanReply(status())).toBe(true);
    expect(providerRunnable(status(), 'claude')).toBe(false);
    expect(providerRunnable(status(), 'codex')).toBe(true);
    expect(agentsCanReply(status({ runner: { connected: false, seenAt: null } }))).toBe(false);
    const none = status({
      providers: [{ provider: 'codex', state: 'missing', version: null, detail: null, sandboxProblem: null }],
    });
    expect(agentsCanReply(none)).toBe(false);
  });

  it('runs nothing while Hermes isn’t ready on the runner (CT-1160)', () => {
    const broken: HermesCheck = { ready: false, version: null, problem: 'broken', detail: 'exit 1' };
    expect(agentsCanReply(status({ hermes: broken }))).toBe(false);
    expect(providerRunnable(status({ hermes: broken }), 'codex')).toBe(false);
    expect(agentsCanReply(status({ hermes: null }))).toBe(false);
    expect(
      RunnerStatus.parse({ hermes: READY, providers: [], checkedAt: '2026-10-23T12:00:00Z' }).hermes,
    ).toEqual(READY);
    expect(RunnerStatus.safeParse({ providers: [], checkedAt: '2026-10-23T12:00:00Z' }).success).toBe(false);
    expect(HermesCheck.safeParse({ ...broken, problem: 'gone' }).success).toBe(false);
  });

  it('says why in words people can act on, never the engine’s name', () => {
    for (const problem of HERMES_PROBLEMS) {
      const notice = agentsBlockedNotice(
        status({ hermes: { ready: false, version: null, problem, detail: null } }),
        'Dusty',
      );
      const reply = unrunnableReply({ kind: 'engine', problem });
      for (const words of [ENGINE_PROBLEM_COPY[problem], notice, reply])
        expect(words.toLowerCase()).not.toContain('hermes');
      expect(notice).toContain('Dusty');
      expect(reply).toContain('ask me again');
    }
    expect(agentsBlockedNotice(status({ hermes: null }), 'Dusty')).toContain('starting');
  });

  it('says what each state means and what to run on the host', () => {
    expect(providerStateLabel({ state: 'ready', version: '2.1.278 (Claude Code)' })).toBe(
      'Ready · 2.1.278 (Claude Code)',
    );
    expect(
      providerStateLabel({ provider: 'claude', state: 'ready', version: '2.1.278 (Claude Code)' }),
    ).toContain('2.1.278');
    expect(providerStateLabel({ state: 'logged_out', version: null })).toBe('Installed, not logged in');
    expect(providerFix({ provider: 'claude', state: 'logged_out', detail: null })).toEqual({
      text: 'On the host, run claude and sign in with /login.',
      command: 'claude',
    });
    expect(providerFix({ provider: 'claude', state: 'missing', detail: null })?.command).toBe(
      'npm i -g @anthropic-ai/claude-code',
    );
    expect(providerFix({ provider: 'codex', state: 'ready', detail: null })).toBeNull();
  });

  it('calls the codex provider ChatGPT, which needs nothing installed (CT-1450, CT-1451)', () => {
    expect(LIVE_PROVIDERS).toEqual(['claude', 'codex']);
    expect(PROVIDER_LABELS.codex).toBe('ChatGPT');
    expect(PROVIDER_LABELS.claude).toBe('Claude Code');
    // Ready whenever Hermes is: never the runner's version, and nothing to install or log in to on the machine.
    expect(providerStateLabel({ provider: 'codex', state: 'ready', version: 'Hermes 0.22.5' })).toBe('Ready');
    for (const state of ['missing', 'logged_out'] as const) {
      expect(providerStateLabel({ provider: 'codex', state, version: null })).toBe('Not ready');
      const fix = providerFix({ provider: 'codex', state, detail: null });
      expect(fix?.command).toBeNull();
      expect(fix?.text).toContain('ChatGPT');
    }
    expect(providerStateLabel({ provider: 'codex', state: 'unknown', version: null })).toBe(
      'Not checked yet',
    );
    const words = [
      unrunnableReply({ kind: 'no_provider' }),
      unrunnableReply({ kind: 'provider', provider: 'codex' }),
      agentsBlockedNotice(status({ providers: [] }), 'Dusty'),
      ...(['missing', 'logged_out'] as const).map(
        (state) => providerFix({ provider: 'codex', state, detail: null })?.text ?? '',
      ),
    ];
    for (const text of words) {
      expect(text).toContain('ChatGPT');
      expect(text).not.toMatch(/codex|hermes/i);
    }
  });
});

describe('sign-in console input (CT-71)', () => {
  it('counts UTF-8 bytes', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('a\r\u0003')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('\ud800')).toBe(3);
    expect(utf8ByteLength('é€😀x')).toBe(10);
  });

  it('takes at most 4 KiB of UTF-8', () => {
    expect(ConsoleInputText.safeParse('a'.repeat(PROVIDER_CONSOLE_INPUT_MAX_BYTES)).success).toBe(true);
    expect(ConsoleInputText.safeParse('é'.repeat(2_048)).success).toBe(true);
    expect(ConsoleInputText.safeParse('é'.repeat(2_049)).success).toBe(false);
    expect(ConsoleInputText.safeParse('').success).toBe(false);
  });

  it('carries output as bounded base64', () => {
    expect(ConsoleOutputData.safeParse('G1szMm1PSxtbMG0NCg==').success).toBe(true);
    expect(ConsoleOutputData.safeParse('not base64!').success).toBe(false);
    expect(ConsoleOutputData.safeParse('A'.repeat(21_848)).success).toBe(true);
    expect(ConsoleOutputData.safeParse('A'.repeat(21_852)).success).toBe(false);
  });
});
