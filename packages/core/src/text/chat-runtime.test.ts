/** What answers in Chat, in words (0.96, CT-463…CT-466). */
import { describe, expect, it } from 'vitest';
import type { RanOn } from '../domain/chat-runtime.js';
import type { ProviderModel } from '../domain/models.js';
import {
  CHAT_PROVIDER_LABELS,
  CHAT_RUNTIME_COPY,
  chatModelLabel,
  chatRuntimeChip,
  chatUsageLine,
  fastNoneText,
  fastSkippedText,
  modelSkippedText,
  ranOnText,
  runSwitchText,
} from './chat-runtime.js';
import { agentFastChangeText, agentModelSummary } from './models.js';

const model = (id: string, label: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  label,
  description: null,
  efforts: ['low', 'medium', 'high'],
  isDefault: false,
  ...extra,
});

const claude = [
  model('opus', 'Opus', { isDefault: true, fast: 'off' }),
  model('sonnet', 'Sonnet'),
  model('fable', 'Fable', { fast: 'off' }),
  model('haiku', 'Haiku', { fast: null }),
];
const codex = [model('gpt-6.1-sol', 'GPT-6.1 Sol', { isDefault: true, fast: 'on' })];

const opus: RanOn = { provider: 'claude', model: 'opus', modelLabel: 'Opus', effort: 'medium', fast: false };

describe('the popover’s words (CT-463)', () => {
  it('names the providers for the sign-in', () => {
    expect(CHAT_PROVIDER_LABELS).toEqual({ claude: 'Claude', codex: 'ChatGPT', local: 'Custom' });
  });

  it('puts the assistant’s name and counts in place', () => {
    expect(CHAT_RUNTIME_COPY.answersWith('Neo')).toBe('Neo answers with');
    expect(CHAT_RUNTIME_COPY.makeDefault('Neo')).toBe('Make this Neo’s default');
    expect(CHAT_RUNTIME_COPY.more(3)).toBe('3 more…');
    expect(CHAT_RUNTIME_COPY.notSetUp('ChatGPT')).toContain('ChatGPT isn’t set up');
    expect(CHAT_RUNTIME_COPY.madeDefault('Neo', 'Opus · High')).toContain('Neo now answers with Opus · High');
    expect(CHAT_RUNTIME_COPY.buttonLabel('Neo')).toContain('Neo');
    expect(CHAT_RUNTIME_COPY.fastHint.claude).toContain('usage credits');
    expect(CHAT_RUNTIME_COPY.fastHint.codex).toContain('ChatGPT plan');
  });

  it('labels a model by its own name, the default’s without an id', () => {
    expect(chatModelLabel(claude, 'sonnet')).toBe('Sonnet');
    expect(chatModelLabel(claude, undefined)).toBe('Opus');
    expect(chatModelLabel(claude, 'claude-mystery')).toBe('claude-mystery');
    expect(chatModelLabel(undefined, undefined)).toBe('Default');
  });

  it('says which models have fast replies when the picked one has none', () => {
    const one = [claude[0] as ProviderModel, claude[1] as ProviderModel];
    expect(fastNoneText(one, 'sonnet')).toBe('Only Opus has fast replies. Sonnet is picked.');
    const two = fastNoneText(claude, 'haiku');
    expect(two).toContain('Opus and Fable have');
    expect(two).toContain('Haiku is picked');
    const three = fastNoneText([...claude, model('max', 'Max', { fast: 'on' })], 'sonnet');
    expect(three).toContain('Opus, Fable and Max');
    expect(fastNoneText([claude[1] as ProviderModel], 'sonnet')).toBe('This model has no fast replies.');
    expect(fastNoneText(undefined, null)).toBe('This model has no fast replies.');
  });

  it('writes the usage line in whole percents, leaving out unknown windows', () => {
    const usage = (usedPct: number) => ({ usedPct, resetsAt: null });
    expect(
      chatUsageLine([
        { provider: 'claude', usage: usage(37.6) },
        { provider: 'codex', usage: usage(12.2) },
      ]),
    ).toBe('This 5 hours: Claude 38% used · ChatGPT 12% used');
    const one = chatUsageLine([
      { provider: 'claude', usage: null },
      { provider: 'codex', usage: usage(5) },
    ]);
    expect(one).toContain('ChatGPT 5% used');
    expect(one).not.toContain('Claude');
    expect(chatUsageLine([{ provider: 'claude', usage: null }])).toBeNull();
    expect(chatUsageLine([])).toBeNull();
  });
});

describe('the composer’s button (CT-464)', () => {
  it('shows the model and effort, the default model by its own name', () => {
    expect(chatRuntimeChip({ provider: 'claude' }, claude)).toEqual({
      label: 'Opus · Automatic',
      fast: false,
    });
    expect(chatRuntimeChip({ provider: 'claude', model: 'sonnet', effort: 'xhigh' }, claude).label).toBe(
      'Sonnet · Extra high',
    );
  });

  it('shows the bolt for the choice’s fast, else the model’s default, never where the model has none', () => {
    expect(chatRuntimeChip({ provider: 'codex' }, codex)).toEqual({
      label: 'GPT-6.1 Sol · Automatic',
      fast: true,
    });
    expect(chatRuntimeChip({ provider: 'codex', fast: false }, codex).fast).toBe(false);
    expect(chatRuntimeChip({ provider: 'claude', fast: true }, claude).fast).toBe(true);
    expect(chatRuntimeChip({ provider: 'claude', model: 'sonnet', fast: true }, claude).fast).toBe(false);
    expect(chatRuntimeChip({ provider: 'claude', fast: true }, undefined)).toEqual({
      label: 'Default · Automatic',
      fast: true,
    });
  });
});

describe('what answered a reply (CT-465)', () => {
  it('names provider, model, effort and fast', () => {
    expect(ranOnText({ ...opus, effort: 'high', fast: true })).toBe('Claude · Opus · High effort · Fast');
    expect(ranOnText({ provider: 'codex', model: null, modelLabel: null, effort: null, fast: false })).toBe(
      'ChatGPT',
    );
  });

  it('says what switched between replies', () => {
    const chatgpt: RanOn = {
      provider: 'codex',
      model: null,
      modelLabel: 'GPT-6.1 Sol',
      effort: 'high',
      fast: false,
    };
    expect(runSwitchText(opus, chatgpt)).toBe('Switched to ChatGPT · High effort');
    expect(runSwitchText(opus, { ...opus, model: 'sonnet', modelLabel: 'Sonnet' })).toBe(
      'Switched to Sonnet',
    );
    expect(runSwitchText(opus, { ...opus, fast: true })).toBe('Fast replies on');
    expect(runSwitchText({ ...opus, fast: true }, opus)).toBe('Fast replies off');
    expect(runSwitchText({ ...opus, fast: true }, { ...opus, model: 'sonnet', modelLabel: 'Sonnet' })).toBe(
      'Switched to Sonnet · fast replies off',
    );
    expect(runSwitchText(opus, { ...opus, effort: 'max' })).toBe('Switched to Max effort');
  });

  it('says nothing for the first reply, the same choice, or a skip its own line explains', () => {
    expect(runSwitchText(null, opus)).toBeNull();
    expect(runSwitchText(opus, { ...opus })).toBeNull();
    const fast = { ...opus, fast: true };
    expect(runSwitchText(fast, { ...opus, fastSkipped: 'busy' })).toBeNull();
    expect(runSwitchText({ ...opus, fastSkipped: 'busy' }, fast)).toBeNull();
    const fable = { ...opus, model: 'fable', modelLabel: 'Fable' };
    expect(runSwitchText(fable, { ...opus, modelSkipped: 'fable' })).toBeNull();
  });

  it('explains a reply that came at the normal speed', () => {
    for (const reason of ['busy', 'credits', 'org', 'unavailable'] as const)
      expect(fastSkippedText(reason, 'claude')).toContain('normal speed');
    expect(fastSkippedText('credits', 'claude')).toContain('usage credits on your Claude account');
    expect(fastSkippedText('credits', 'codex')).toContain('your ChatGPT plan');
    expect(fastSkippedText('org', 'claude')).toContain('Claude organization');
    expect(fastSkippedText('org', 'codex')).toContain('ChatGPT workspace');
    expect(fastSkippedText('busy', 'codex')).toContain('busy');
    expect(fastSkippedText('unavailable', 'codex')).toContain('weren’t available');
  });

  it('explains a model that wasn’t available', () => {
    expect(modelSkippedText('Fable', 'Opus')).toBe('Fable wasn’t available, so this one came from Opus.');
  });
});

describe('fast replies on an agent (CT-466)', () => {
  it('adds “Fast” to the profile’s line, also alone', () => {
    expect(agentModelSummary({ model: 'sonnet', effort: 'high', fast: true }, claude)).toBe(
      'Sonnet · High effort · Fast',
    );
    expect(agentModelSummary({ fast: true }, claude)).toBe('Default model · Fast');
    expect(agentModelSummary({ fast: false }, claude)).toBeNull();
    expect(agentModelSummary({ model: 'sonnet', fast: false }, claude)).toBe('Sonnet');
  });

  it('writes the Keys line', () => {
    expect(agentFastChangeText('Neo', true)).toBe('Turned on fast replies for Neo');
    expect(agentFastChangeText('Neo', false)).toBe('Turned off fast replies for Neo');
  });
});
