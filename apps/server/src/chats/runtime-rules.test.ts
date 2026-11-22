/**
 * What answers in Chat, the pure rules (chat-runtime-server.md CR-S03…CR-S09): a turn's runtime from its thread's
 * choice, which choices a provider takes and how they are stored, and what a reply says answered it.
 */
import type { AgentRuntime, ChatRuntime, ProviderModel, RanOn } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  automationDispatchRuntime,
  backgroundTurnRuntime,
  type ChatProviderFacts,
  checkChoice,
  fiveHourUsage,
  followsThreadChoice,
  ranOnAtCompletion,
  ranOnAtPost,
  resolveThreadRuntime,
  turnProviderOf,
  turnRuntimeOf,
} from './runtime-rules';

const CLAUDE: ProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: null,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    isDefault: true,
    fast: 'off',
  },
  { id: 'sonnet', label: 'Sonnet', description: null, efforts: ['low', 'medium', 'high'], isDefault: false },
  { id: 'haiku', label: 'Haiku', description: null, efforts: [], isDefault: false },
];
const CODEX: ProviderModel[] = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    description: null,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    isDefault: true,
    fast: 'on',
  },
];

const AGENT: AgentRuntime = {
  provider: 'claude',
  model: 'opus',
  effort: 'medium',
};

describe('a turn’s runtime (CR-S03)', () => {
  it('takes provider, model, effort and fast from the choice', () => {
    const turn = turnRuntimeOf(AGENT, { provider: 'codex', effort: 'high', fast: true });
    expect(turn).toEqual({
      provider: 'codex',
      effort: 'high',
      fast: true,
    });
    // No choice: the agent's own, untouched.
    expect(turnRuntimeOf(AGENT, null)).toBe(AGENT);
  });

  it('names the provider the turn runs on', () => {
    expect(turnProviderOf({ provider: 'claude' }, { provider: 'codex' })).toBe('codex');
    expect(turnProviderOf({ provider: 'claude' }, null)).toBe('claude');
    expect(turnProviderOf(null, null)).toBe('claude');
  });
});

describe('background model selection', () => {
  const WITH_BG: AgentRuntime = {
    provider: 'claude',
    model: 'opus',
    backgroundModel: 'haiku',
    effort: 'high',
    fast: true,
  };

  it('uses the background model of the same provider with automatic effort and no fast replies', () => {
    const resolved = backgroundTurnRuntime(WITH_BG);
    expect(resolved).toEqual({ provider: 'claude', model: 'haiku' });
    expect(turnRuntimeOf(WITH_BG, resolved)).toEqual({ provider: 'claude', model: 'haiku' });
  });

  it('falls back to the main model when no background model is set', () => {
    expect(backgroundTurnRuntime(AGENT)).toBeNull();
    expect(turnRuntimeOf(AGENT, backgroundTurnRuntime(AGENT))).toBe(AGENT);
  });

  it('applies to scheduled automation steps, not manual, test or event-triggered runs', () => {
    expect(automationDispatchRuntime(WITH_BG, 'schedule')).toEqual({
      provider: 'claude',
      model: 'haiku',
    });
    for (const kind of ['manual', 'github', 'message_posted', 'tracker', 'webhook'])
      expect(automationDispatchRuntime(WITH_BG, kind)).toBeNull();
    expect(automationDispatchRuntime(AGENT, 'schedule')).toBeNull();
  });

  it('supports a custom AI model provider when it has a background model configured', () => {
    const local: AgentRuntime = {
      provider: 'local',
      model: 'llama3.3:70b',
      backgroundModel: 'qwen3:32b',
    };
    const resolved = backgroundTurnRuntime(local);
    expect(resolved).toEqual({ provider: 'local', model: 'qwen3:32b' });
    expect(turnRuntimeOf(local, resolved)).toEqual({ provider: 'local', model: 'qwen3:32b' });
  });

  it('leaves person-started chats and thread choices on the main model or thread choice', () => {
    expect(turnRuntimeOf(WITH_BG, null).model).toBe('opus');
    expect(
      turnRuntimeOf(WITH_BG, resolveThreadRuntime(WITH_BG, { provider: 'claude', model: 'sonnet' })),
    ).toEqual({
      provider: 'claude',
      model: 'sonnet',
    });
  });
});

describe('resolving a thread’s choice (CR-02, CR-S04)', () => {
  it('is the choice while it differs from the assistant’s own, on Claude Code or Codex', () => {
    expect(resolveThreadRuntime(AGENT, { provider: 'codex' })).toEqual({ provider: 'codex' });
    expect(resolveThreadRuntime(AGENT, { provider: 'claude', model: 'opus', effort: 'medium' })).toBeNull();
    expect(resolveThreadRuntime(AGENT, null)).toBeNull();
  });

  it('applies to what a person does in the thread, never to automations, schedules or assessments', () => {
    for (const t of ['dm', 'mention', 'retry', 'expand', 'approval_granted', 'run_control'] as const)
      expect(followsThreadChoice(t)).toBe(true);
    for (const t of ['automation', 'schedule', 'feedback', 'search'] as const)
      expect(followsThreadChoice(t)).toBe(false);
  });
});

describe('checking a choice (CR-04…CR-06, CR-S05)', () => {
  const ready: ChatProviderFacts = { ready: true, models: CLAUDE, gateway: false };
  const problem = (choice: ChatRuntime, facts = ready) => {
    const check = checkChoice(choice, facts);
    return check.ok ? null : check.problem;
  };

  it('needs the provider ready for the person', () => {
    expect(problem({ provider: 'codex' }, { ...ready, ready: false })).toContain('ChatGPT');
  });

  it('takes a model of the list and an effort the model takes', () => {
    expect(problem({ provider: 'claude', model: 'fable' })).toContain('“fable”');
    expect(problem({ provider: 'claude', model: 'sonnet', effort: 'max' })).toContain('Sonnet');
    expect(problem({ provider: 'claude', model: 'sonnet', effort: 'high' })).toBeNull();
    // Without a list: any model and any effort.
    expect(
      problem({ provider: 'claude', model: 'fable', effort: 'ultra' }, { ...ready, models: null }),
    ).toBeNull();
  });

  it('takes fast replies only where the model offers them, never through the AI gateway', () => {
    expect(problem({ provider: 'claude', model: 'sonnet', fast: true })).toContain('Opus');
    expect(problem({ provider: 'claude', fast: true }, { ...ready, gateway: true })).toContain('AI gateway');
    expect(checkChoice({ provider: 'claude', fast: true }, ready)).toEqual({
      ok: true,
      choice: { provider: 'claude', fast: true },
    });
    // Off where there is nothing to turn off is dropped, not refused.
    expect(checkChoice({ provider: 'claude', model: 'sonnet', fast: false }, ready)).toEqual({
      ok: true,
      choice: { provider: 'claude', model: 'sonnet' },
    });
  });

  it('takes any model the network’s server may serve, without an effort or fast replies (CT-1173)', () => {
    const local: ChatProviderFacts = {
      ready: true,
      models: [
        { id: 'llama3.3', label: 'Llama', description: null, efforts: [], isDefault: true, fast: null },
      ],
      gateway: false,
    };
    expect(checkChoice({ provider: 'local', model: 'qwen3:32b' }, local)).toEqual({
      ok: true,
      choice: { provider: 'local', model: 'qwen3:32b' },
    });
    expect(problem({ provider: 'local', model: 'qwen3:32b', effort: 'high' }, local)).not.toBeNull();
    expect(problem({ provider: 'local', model: 'llama3.3', effort: 'high' }, local)).toContain('Llama');
    expect(problem({ provider: 'local', fast: true }, local)).not.toBeNull();
    expect(problem({ provider: 'local' }, { ...local, ready: false })).not.toBeNull();
  });
});

describe('what answered a reply (CR-07, CR-08, CR-S08, CR-S09)', () => {
  it('at post time: the resolved model’s label, a conversation’s effort within the model, fast as asked', () => {
    expect(ranOnAtPost({ provider: 'claude', effort: 'xhigh', fast: true }, CLAUDE)).toEqual({
      provider: 'claude',
      model: null,
      modelLabel: 'Opus',
      effort: 'xhigh',
      fast: true,
    });
    // Automatic effort for a conversation, kept within what the model takes.
    expect(ranOnAtPost({ provider: 'claude', model: 'sonnet' }, CLAUDE)).toMatchObject({
      modelLabel: 'Sonnet',
      effort: 'medium',
      fast: false,
    });
    expect(ranOnAtPost({ provider: 'claude', model: 'haiku', effort: 'high' }, CLAUDE)).toMatchObject({
      effort: null,
    });
    // A model fast by default runs fast unless the choice says otherwise.
    expect(ranOnAtPost({ provider: 'codex' }, CODEX)).toMatchObject({
      modelLabel: 'GPT-6.1 Sol',
      fast: true,
    });
    expect(ranOnAtPost({ provider: 'codex', fast: false }, CODEX)).toMatchObject({ fast: false });
    // Never fast through the AI gateway (CR-R08).
    expect(ranOnAtPost({ provider: 'codex' }, CODEX, { gateway: true })).toMatchObject({ fast: false });
    // Unknown list, no model: the label isn't known.
    expect(ranOnAtPost({ provider: 'codex' }, null)).toMatchObject({ modelLabel: null, effort: 'medium' });
  });

  it('at completion: what the runner says ran, and the model asked for when it fell back', () => {
    const posted: RanOn = {
      provider: 'claude',
      model: 'fable',
      modelLabel: 'Fable',
      effort: 'high',
      fast: true,
    };
    expect(
      ranOnAtCompletion(
        posted,
        { model: null, effort: 'high', fast: false, fastSkipped: 'credits' },
        { model: 'fable' },
        CLAUDE,
      ),
    ).toEqual({
      provider: 'claude',
      model: null,
      modelLabel: 'Opus',
      effort: 'high',
      fast: false,
      fastSkipped: 'credits',
      modelSkipped: 'fable',
    });
    // An older runner says nothing: the post-time values stay.
    expect(ranOnAtCompletion(posted, undefined, undefined, CLAUDE)).toBe(posted);
    // Its fallback alone still says the default answered.
    expect(ranOnAtCompletion(posted, undefined, { model: 'fable' }, CLAUDE)).toMatchObject({
      model: null,
      modelLabel: 'Opus',
      modelSkipped: 'fable',
      fast: true,
    });
  });
});

describe('a provider’s 5-hour window (CR-09)', () => {
  it('is the subscription’s five_hour window with a known share', () => {
    const window = {
      kind: 'five_hour' as const,
      label: '5-hour',
      usedPct: 38,
      resetsAt: '2026-10-19T18:00:00.000Z',
      status: 'ok' as const,
    };
    expect(fiveHourUsage({ kind: 'subscription', windows: [window] })).toEqual({
      usedPct: 38,
      resetsAt: '2026-10-19T18:00:00.000Z',
    });
    expect(fiveHourUsage({ kind: 'api_key', windows: [window] })).toBeNull();
    expect(fiveHourUsage({ kind: 'subscription', windows: [{ ...window, usedPct: null }] })).toBeNull();
    expect(fiveHourUsage(null)).toBeNull();
  });
});
