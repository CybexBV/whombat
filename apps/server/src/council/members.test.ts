import { describe, expect, it } from 'vitest';
import {
  automaticSeats,
  chatSeat,
  chosenAi,
  markOf,
  modelLabel,
  pickSeats,
  providerOptions,
  providersOf,
  t3CouncilSeats,
} from './members';

/** T3 Code's `orchestrator_capabilities`, as John's 0.1.7 answers it (trimmed). */
const CAPABILITIES = {
  providers: [
    {
      providerInstanceId: 'codex',
      displayName: 'Codex',
      models: [
        {
          id: 'gpt-6.1-sol',
          options: [
            { id: 'reasoningEffort', values: ['low', 'high', 'xhigh', 'max'] },
            { id: 'serviceTier', values: ['default', 'priority'], default: 'priority' },
          ],
        },
        { id: 'gpt-6-astra', options: [{ id: 'reasoningEffort', values: ['low', 'high', 'xhigh'] }] },
      ],
      constraints: [],
    },
    {
      providerInstanceId: 'claudeAgent',
      displayName: 'Claude',
      models: [
        {
          id: 'claude-opus-5-5',
          label: 'Claude Opus 5.5',
          options: [
            { id: 'effort', values: ['low', 'xhigh'] },
            { id: 'fastMode', values: [false, true] },
          ],
        },
      ],
      constraints: [],
    },
    {
      providerInstanceId: 'cursor',
      displayName: 'Cursor',
      models: [],
      constraints: ['Provider instance is disabled.'],
    },
    {
      providerInstanceId: 'grok',
      displayName: 'Grok',
      models: [{ id: 'grok-build' }],
      constraints: ['Provider instance is disabled.'],
    },
    {
      providerInstanceId: 'muse',
      displayName: 'Muse Code',
      models: [
        {
          id: 'muse-wonder-1.0',
          label: 'Muse Wonder 1.0',
          options: [{ id: 'reasoningEffort', values: ['high', 'max'] }],
        },
        {
          id: 'muse-wonder-full-1.0',
          label: 'Muse Wonder Full 1.0',
          options: [{ id: 'reasoningEffort', values: ['high', 'xhigh', 'max'] }],
        },
      ],
      constraints: [],
    },
  ],
};

describe('who sits on a council', () => {
  const providers = providersOf(CAPABILITIES);

  it('leads on the chat’s own AI, by its company, model and effort', () => {
    expect(chatSeat(providers, { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' })).toMatchObject({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      options: [{ id: 'reasoningEffort', value: 'high' }],
    });
    // A model named the chat's way (`opus`, a `[1m]` context) is found by its name; none: the company's best.
    expect(chatSeat(providers, { provider: 'claude', model: 'opus' })?.model).toBe('claude-opus-5-5');
    expect(chatSeat(providers, { provider: 'claude', model: 'claude-opus-5-5[1m]' })?.model).toBe(
      'claude-opus-5-5',
    );
    expect(chatSeat(providers, { provider: 'claude' })?.model).toBe('claude-opus-5-5');
    // An effort the model doesn't take: the most it thinks.
    expect(chatSeat(providers, { provider: 'claude', effort: 'medium' })?.options).toEqual([
      { id: 'effort', value: 'xhigh' },
    ]);
    // A company T3 Code doesn't run: none (the council's own lead seat then).
    expect(chatSeat(providers, { provider: 'local', model: 'qwen' })).toBeNull();
  });

  it('knows only the providers T3 Code can run now', () => {
    expect(providers.map((p) => p.instanceId)).toEqual(['codex', 'claudeAgent', 'muse']);
  });

  it('seats one of each provider, its best model at xhigh', () => {
    const pick = automaticSeats(providers);
    expect(pick.ok).toBe(true);
    if (!pick.ok) return;
    expect(pick.seats.map((s) => [s.provider, s.model])).toEqual([
      ['codex', 'gpt-6.1-sol'],
      ['claudeAgent', 'claude-opus-5-5'],
      ['muse', 'muse-wonder-full-1.0'],
    ]);
    expect(pick.seats[0]?.options).toEqual([{ id: 'reasoningEffort', value: 'xhigh' }]);
    expect(pick.seats[1]?.label).toBe('Claude Opus 5.5');
  });

  it('seats T3 Code’s own council as it sat last, else Whombat’s guess', () => {
    const sat = [
      { provider: 'muse', model: 'muse-wonder-1.0', options: [] },
      { provider: 'codex', model: 'gpt-6-astra', options: [{ id: 'reasoningEffort', value: 'high' }] },
      { provider: 'grok', model: 'grok-build', options: [] },
    ];
    const pick = t3CouncilSeats(providers, sat);
    expect(pick.ok && pick.seats.map((s) => [s.model, s.options[0]?.value])).toEqual([
      ['muse-wonder-1.0', 'high'],
      ['gpt-6-astra', 'high'],
    ]);
    // Fewer than two companies it can run now: Whombat's guess.
    expect(t3CouncilSeats(providers, sat.slice(0, 1))).toEqual(automaticSeats(providers));
    expect(t3CouncilSeats(providers, [])).toEqual(automaticSeats(providers));
  });

  it('seats Claude Opus 5.5 at xhigh where T3 Code has it, whatever its order', () => {
    const claude = {
      providerInstanceId: 'claudeAgent',
      displayName: 'Claude',
      models: [
        { id: 'claude-fable-5-2', options: [{ id: 'effort', values: ['low', 'high', 'xhigh'] }] },
        { id: 'claude-opus-5-5', options: [{ id: 'effort', values: ['low', 'high', 'xhigh'] }] },
      ],
      constraints: [],
    };
    const pick = automaticSeats(providersOf({ providers: [CAPABILITIES.providers[0], claude] }));
    expect(pick.ok && pick.seats[1]).toMatchObject({
      model: 'claude-opus-5-5',
      options: [{ id: 'effort', value: 'xhigh' }],
    });
  });

  it('seats Antigravity’s Gemini 4 Neon at its xhigh thought level, four seats in all', () => {
    const antigravity = {
      providerInstanceId: 'antigravity',
      displayName: 'Antigravity',
      models: [
        { id: 'gemini-4-carbon', options: [{ id: 'thought_level', values: ['low', 'high', 'xhigh'] }] },
        {
          id: 'gemini-4-neon',
          label: 'Gemini 4 Neon',
          options: [{ id: 'thought_level', values: ['low', 'high', 'xhigh'], default: 'high' }],
        },
      ],
      constraints: [],
    };
    const all = providersOf({ providers: [...CAPABILITIES.providers, antigravity] });
    const pick = automaticSeats(all);
    expect(pick.ok && pick.seats.map((s) => s.model)).toEqual([
      'gpt-6.1-sol',
      'claude-opus-5-5',
      'muse-wonder-full-1.0',
      'gemini-4-neon',
    ]);
    expect(pick.ok && pick.seats[3]?.options).toEqual([{ id: 'thought_level', value: 'xhigh' }]);
    // Its thought level reads as its thinking in Settings too.
    expect(providerOptions(all).at(-1)?.models[1]).toMatchObject({
      efforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
    });
  });

  it('seats GPT 6.2 Sol for Codex once T3 Code has it, wherever Codex lists it', () => {
    const codex = CAPABILITIES.providers[0] as (typeof CAPABILITIES.providers)[0];
    const sol62 = {
      id: 'gpt-6.2-sol',
      options: [{ id: 'reasoningEffort', values: ['low', 'high', 'xhigh', 'ultra'] }],
    };
    const withSol62 = { ...codex, models: [...codex.models, sol62] };
    const pick = automaticSeats(providersOf({ providers: [withSol62, CAPABILITIES.providers[1]] }));
    expect(pick.ok && pick.seats[0]).toMatchObject({
      model: 'gpt-6.2-sol',
      options: [{ id: 'reasoningEffort', value: 'xhigh' }],
    });
  });

  it('seats who the person named, by their own words', () => {
    const pick = pickSeats(providers, [{ provider: 'ChatGPT' }, { provider: 'claude' }]);
    expect(pick.ok && pick.seats.map((s) => s.provider)).toEqual(['codex', 'claudeAgent']);
    const model = pickSeats(providers, [{ provider: 'codex', model: 'gpt-6-astra' }, { provider: 'Muse' }]);
    expect(model.ok && model.seats.map((s) => s.model)).toEqual(['gpt-6-astra', 'muse-wonder-full-1.0']);
  });

  it('is no council with fewer than two providers, and says why', () => {
    const one = automaticSeats(providersOf({ providers: [CAPABILITIES.providers[0]] }));
    expect(one.ok).toBe(false);
    if (!one.ok) expect(one.message).toContain('Codex');
    const asked = pickSeats(providers, [{ provider: 'Codex' }, { provider: 'Grok' }]);
    expect(asked.ok).toBe(false);
    if (!asked.ok) expect(asked.message).toContain('Grok');
  });

  it('seats one provider twice only with another model, and never a council of one company', () => {
    expect(pickSeats(providers, [{ provider: 'Codex' }, { provider: 'codex' }])).toMatchObject({ ok: false });
    const twice = pickSeats(providers, [
      { provider: 'Codex' },
      { provider: 'codex' },
      { provider: 'Claude' },
    ]);
    expect(twice.ok && twice.seats.map((s) => s.model)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'claude-opus-5-5',
    ]);
  });

  it('takes an effort the model knows, and says when it doesn’t', () => {
    const pick = pickSeats(providers, [
      { provider: 'Claude', effort: 'low' },
      { provider: 'Codex', effort: 'ultrathink' },
    ]);
    expect(pick.ok && pick.seats.map((s) => s.options)).toEqual([
      [{ id: 'effort', value: 'low' }],
      [{ id: 'reasoningEffort', value: 'xhigh' }],
    ]);
    expect(pick.ok && pick.notes.join(' ')).toContain('ultrathink');
  });

  it('says who the person named and couldn’t sit', () => {
    const asked = pickSeats(providers, [{ provider: 'Codex' }, { provider: 'Claude' }, { provider: 'Grok' }]);
    expect(asked.ok).toBe(true);
    expect(asked.ok && asked.notes.join(' ')).toMatch(/Grok/);
  });

  it('lists what T3 Code can run for Settings: models with their efforts and defaults', () => {
    const options = providerOptions(providers);
    expect(options.map((p) => p.id)).toEqual(['codex', 'claudeAgent', 'muse']);
    expect(options[0]?.models[0]).toMatchObject({
      id: 'gpt-6.1-sol',
      label: 'GPT 6.1 Sol',
      efforts: ['low', 'high', 'xhigh', 'max'],
    });
  });

  it('says which models have a fast tier, and whether it is on unless chosen', () => {
    const options = providerOptions(providers);
    expect(options[0]?.models.map((m) => m.fast)).toEqual([true, null]);
    expect(options[1]?.models[0]?.fast).toBe(false);
  });

  it('takes a task’s AI the person chose, with only the options they chose', () => {
    expect(
      chosenAi(providers, { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: false }),
    ).toEqual({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      modelLabel: 'GPT 6.1 Sol',
      options: [
        { id: 'reasoningEffort', value: 'high' },
        { id: 'serviceTier', value: 'default' },
      ],
    });
    expect(
      chosenAi(providers, { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: null, fast: true })
        ?.options,
    ).toEqual([{ id: 'fastMode', value: true }]);
    expect(
      chosenAi(providers, { provider: 'codex', model: 'gpt-6-astra', effort: null, fast: null })?.options,
    ).toEqual([]);
    // A model T3 Code can't run, or an effort it doesn't take: refused.
    expect(chosenAi(providers, { provider: 'codex', model: 'gpt-5', effort: null, fast: null })).toBeNull();
    expect(
      chosenAi(providers, { provider: 'codex', model: 'gpt-6.1-sol', effort: 'ultra', fast: null }),
    ).toBeNull();
  });

  it('names models and marks plainly', () => {
    expect(modelLabel({ id: 'gpt-6.1-sol', label: null })).toBe('GPT 6.1 Sol');
    expect(markOf('claudeAgent')).toBe('claude');
    expect(markOf('codex')).toBe('openai');
    expect(markOf('muse')).toBeNull();
  });
});
