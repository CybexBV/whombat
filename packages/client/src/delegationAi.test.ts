import type { CouncilProviderOption, DelegationAi, DelegationCard, DelegationCardTask } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { delegationCardView } from './delegation';
import {
  DELEGATION_AI_WORDS,
  delegationAiChoice,
  delegationAiDraft,
  delegationAiLine,
  delegationAiMenu,
  delegationAiOf,
  sameDelegationAi,
  withAiModel,
} from './delegationAi';

const OPTIONS: CouncilProviderOption[] = [
  {
    id: 'codex',
    name: 'Codex',
    models: [
      {
        id: 'gpt-6.1-sol',
        label: 'GPT 6.1 Sol',
        efforts: ['low', 'high', 'xhigh'],
        defaultEffort: 'low',
        fast: true,
      },
    ],
  },
  {
    id: 'claudeAgent',
    name: 'Claude',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['high', 'xhigh'], defaultEffort: 'high' },
      {
        id: 'claude-haiku-5-5',
        label: 'Claude Haiku 5.5',
        efforts: ['low'],
        defaultEffort: null,
        fast: null,
      },
    ],
  },
];

const OPUS: DelegationAi = {
  provider: 'claudeAgent',
  model: 'claude-opus-5-5',
  label: 'Claude Opus 5.5',
  effort: 'xhigh',
  fast: null,
};
const SOL: DelegationAi = {
  provider: 'codex',
  model: 'gpt-6.1-sol',
  label: 'GPT 6.1 Sol',
  effort: 'high',
  fast: true,
};

const task = (n: number, over: Partial<DelegationCardTask> = {}): DelegationCardTask => ({
  id: `dlt_${n}` as DelegationCardTask['id'],
  n,
  title: `Task ${n}`,
  why: null,
  picked: true,
  after: null,
  state: 'offered',
  pending: null,
  step: null,
  program: null,
  since: null,
  endedAt: null,
  url: null,
  branch: null,
  pr: null,
  note: null,
  ...over,
});

const card = (over: Partial<DelegationCard> = {}): DelegationCard => ({
  kind: 'delegation',
  delegationId: 'dlg_1' as DelegationCard['delegationId'],
  title: 'Polish the Settings page',
  project: 'Whombat',
  stage: 'offer',
  live: true,
  atOnce: 3,
  pullRequests: true,
  ai: null,
  tasks: [task(1, { ai: OPUS }), task(2, { ai: null }), task(3, { ai: null, picked: false })],
  outcome: null,
  note: null,
  startedAt: '2026-11-05T12:00:00Z',
  handedAt: null,
  endedAt: null,
  ...over,
});

describe('the AI chosen on the checklist', () => {
  it('reads as the model, its effort, and Fast when on', () => {
    expect(delegationAiLine(OPUS)).toBe('Claude Opus 5.5 · Extra high');
    expect(delegationAiLine(SOL)).toBe('GPT 6.1 Sol · High · Fast');
    expect(delegationAiLine({ ...SOL, effort: null, fast: false })).toBe('GPT 6.1 Sol');
    expect(delegationAiLine(null)).toBeNull();
  });

  it('shows a task’s own choice, and every task’s beside Hand over', () => {
    const none = delegationCardView(card(), 0);
    expect(none.aiChoosable).toBe(true);
    expect(none.tasks.map((t) => t.ai)).toEqual(['Claude Opus 5.5 · Extra high', null, null]);
    expect(none.aiSummary).toBeNull();
    const all = delegationCardView(card({ ai: SOL }), 0);
    expect(all.aiSummary).toBe(DELEGATION_AI_WORDS.others('GPT 6.1 Sol · High · Fast'));
    expect(all.aiShared).toBe(1);
    // No ticked task chose its own: the line is the AI alone.
    const alone = delegationCardView(card({ ai: SOL, tasks: [task(1, { ai: null })] }), 0);
    expect(alone.aiSummary).toBe('GPT 6.1 Sol · High · Fast');
  });

  it('can’t be chosen on an older box’s card, nor once handed over', () => {
    const { ai: _, ...older } = card();
    expect(delegationCardView(older as DelegationCard, 0).aiChoosable).toBe(false);
    expect(
      delegationCardView(card({ stage: 'working', handedAt: '2026-11-05T12:01:00Z' }), 0).aiChoosable,
    ).toBe(false);
  });

  it('offers the models T3 Code runs, their efforts and the fast tier where there is one', () => {
    const menu = delegationAiMenu(OPTIONS, delegationAiDraft(SOL), SOL);
    expect(menu.models.map((m) => m.key)).toEqual([
      'codex/gpt-6.1-sol',
      'claudeAgent/claude-opus-5-5',
      'claudeAgent/claude-haiku-5-5',
    ]);
    expect(menu.selected).toBe('codex/gpt-6.1-sol');
    expect(menu.efforts.filter((e) => e.on).map((e) => e.value)).toEqual(['high']);
    expect(menu.fast).toBe(true);
    // Opus has no fast tier; nothing chosen shows the model's own effort.
    const opus = delegationAiMenu(
      OPTIONS,
      withAiModel(OPTIONS, delegationAiDraft(null), 'claudeAgent/claude-opus-5-5'),
      null,
    );
    expect(opus.fast).toBeNull();
    expect(opus.efforts.find((e) => e.on)?.value).toBe('high');
    // The default: no efforts, no fast tier.
    expect(delegationAiMenu(OPTIONS, delegationAiDraft(null), null)).toMatchObject({
      selected: '',
      efforts: [],
      fast: null,
    });
  });

  it('keeps an effort the next model takes, and sends the default as null', () => {
    const draft = withAiModel(OPTIONS, delegationAiDraft(OPUS), 'codex/gpt-6.1-sol');
    expect(draft).toEqual({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', fast: null });
    expect(withAiModel(OPTIONS, draft, 'claudeAgent/claude-haiku-5-5').effort).toBeNull();
    expect(delegationAiChoice(draft)).toEqual({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      fast: null,
    });
    expect(delegationAiChoice(withAiModel(OPTIONS, draft, ''))).toBeNull();
    // A fast tier left to the model goes as the model's own, so the card says Fast when it runs fast.
    expect(delegationAiChoice(draft, OPTIONS)?.fast).toBe(true);
    expect(delegationAiOf(OPTIONS, draft)?.fast).toBe(true);
  });

  it('shows a choice as T3 Code names it, right away', () => {
    const draft = withAiModel(OPTIONS, delegationAiDraft(null), 'claudeAgent/claude-opus-5-5');
    expect(delegationAiOf(OPTIONS, { ...draft, fast: true })).toEqual({ ...OPUS, effort: null });
    expect(delegationAiOf(OPTIONS, delegationAiDraft(null))).toBeNull();
    expect(sameDelegationAi(OPUS, { ...OPUS })).toBe(true);
    expect(sameDelegationAi(OPUS, SOL)).toBe(false);
    expect(sameDelegationAi(null, undefined)).toBe(true);
  });

  it('still shows a chosen model T3 Code no longer runs, so it can be changed', () => {
    const gone = { ...SOL, model: 'gpt-5', label: 'GPT 5' };
    expect(delegationAiMenu(OPTIONS, delegationAiDraft(gone), gone).models[0]).toMatchObject({
      label: 'GPT 5',
    });
  });
});
