import {
  type ChatRuntimeView,
  localProviderModels,
  type ProviderModel,
  type RanOn,
} from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors';
import {
  CHAT_MODELS_SHOWN,
  CHAT_RUNTIME_NOT_SAVED,
  chatDefaultBody,
  chatDraftWithEffort,
  chatDraftWithFast,
  chatDraftWithModel,
  chatDraftWithProvider,
  chatEffortChoices,
  chatFastRow,
  chatMadeDefaultText,
  chatMakeDefaultShown,
  chatModelRows,
  chatProviderHints,
  chatProviderSegments,
  chatRuntimeButton,
  chatRuntimeInEffect,
  chatRuntimeLine,
  chatRuntimeRefusalText,
  chatRuntimeSame,
  chatRuntimeScope,
  chatRuntimeShown,
  chatStartRuntime,
  chatThreadChoice,
  chatThreadState,
  ranOnMark,
  ranOnMarked,
  ranOnNotes,
  ranOnSwitches,
} from './runtime';

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Claude Code's list with `supportsFastMode` on Opus (CR-06): fast offered, off unless asked. */
const CLAUDE: ProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: 'Everyday, complex tasks',
    efforts: [...CLAUDE_EFFORTS],
    isDefault: true,
    fast: 'off',
  },
  {
    id: 'fable',
    label: 'Fable',
    description: 'Hardest, longest tasks',
    efforts: [...CLAUDE_EFFORTS],
    isDefault: false,
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    description: 'Routine tasks',
    efforts: ['low', 'medium', 'high'],
    isDefault: false,
  },
  { id: 'haiku', label: 'Haiku', description: 'Quick answers', efforts: [], isDefault: false },
];

const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const codex = (id: string, label: string, isDefault = false, fast: 'on' | 'off' = 'off'): ProviderModel => ({
  id,
  label,
  description: null,
  efforts: [...CODEX_EFFORTS],
  isDefault,
  fast,
});
/** Codex's `model/list`: every model has the `priority` tier, Sol its default (CR-06). */
const CODEX: ProviderModel[] = [
  codex('gpt-6.1-sol', 'GPT-6.1 Sol', true, 'on'),
  codex('gpt-6-astra', 'GPT-6 Astra'),
  codex('gpt-6-luna', 'GPT-6 Luna', false, 'on'),
  codex('gpt-6', 'GPT-6'),
  codex('gpt-6-mini', 'GPT-6 Mini'),
  codex('gpt-5.5', 'GPT-5.5'),
  codex('gpt-5.5-mini', 'GPT-5.5 Mini'),
];

const view = (over: Partial<ChatRuntimeView> = {}): ChatRuntimeView => ({
  assistantId: 'prn_neo' as never,
  assistantName: 'Neo',
  default: { provider: 'claude' },
  providers: [
    {
      provider: 'claude',
      ready: true,
      models: CLAUDE,
      fastBlocked: null,
      usage: { usedPct: 38.2, resetsAt: null },
    },
    {
      provider: 'codex',
      ready: true,
      models: CODEX,
      fastBlocked: null,
      usage: { usedPct: 12, resetsAt: null },
    },
  ],
  ...over,
});

const ran = (over: Partial<RanOn> = {}): RanOn => ({
  provider: 'claude',
  model: 'opus',
  modelLabel: 'Opus',
  effort: null,
  fast: false,
  ...over,
});

describe('where the button shows (CR-01, CR-11)', () => {
  it('only in the Chat room, with an assistant on Claude Code or Codex', () => {
    expect(chatRuntimeShown({ room: 'chat', view: view() })).toBe(true);
    expect(chatRuntimeShown({ room: 'feedback', view: view() })).toBe(false);
    expect(chatRuntimeShown({ room: null, view: view() })).toBe(false);
    expect(chatRuntimeShown({ room: 'chat', view: view({ default: null }) })).toBe(false);
    expect(chatRuntimeShown({ room: 'chat', view: undefined })).toBe(false);
  });

  it('shows the draft, else the thread’s choice, else the default (CR-02)', () => {
    const thread = { provider: 'codex' } as const;
    expect(chatRuntimeInEffect(view())).toEqual({ provider: 'claude' });
    expect(chatRuntimeInEffect(view({ thread }))).toBe(thread);
    expect(chatRuntimeInEffect(view({ thread }), { provider: 'claude', effort: 'high' })).toEqual({
      provider: 'claude',
      effort: 'high',
    });
    expect(chatRuntimeInEffect(view({ default: null }))).toBeNull();
  });
});

describe('the draft rules (CR-05)', () => {
  it('another provider resets model, effort and fast — to the default when it is on that one', () => {
    const r = { provider: 'claude', model: 'fable', effort: 'max', fast: true } as const;
    expect(chatDraftWithProvider(r, 'codex')).toEqual({ provider: 'codex' });
    expect(chatDraftWithProvider(r, 'claude')).toBe(r);
    const base = { provider: 'codex', effort: 'high' } as const;
    expect(chatDraftWithProvider(r, 'codex', base)).toBe(base);
  });

  it('another model keeps the effort within what it takes and drops fast when it has none', () => {
    const r = { provider: 'claude', effort: 'max', fast: true } as const;
    expect(chatDraftWithModel(r, 'sonnet', CLAUDE)).toEqual({
      provider: 'claude',
      model: 'sonnet',
      effort: 'high',
    });
    expect(chatDraftWithModel(r, 'haiku', CLAUDE)).toEqual({ provider: 'claude', model: 'haiku' });
    expect(chatDraftWithModel({ provider: 'claude', model: 'sonnet' }, 'opus', CLAUDE)).toEqual({
      provider: 'claude',
    });
  });

  it('a change that lands on the default is the default itself', () => {
    const base = { provider: 'claude', model: 'opus' } as const;
    const r = chatDraftWithEffort(base, 'high', CLAUDE, base);
    expect(r).toEqual({ provider: 'claude', model: 'opus', effort: 'high' });
    expect(chatDraftWithEffort(r, null, CLAUDE, base)).toBe(base);
    expect(chatDraftWithModel({ provider: 'claude', model: 'fable' }, 'opus', CLAUDE, base)).toBe(base);
  });

  it('fast is left out when it is the model’s own default', () => {
    const on = chatDraftWithFast({ provider: 'claude' }, true, CLAUDE);
    expect(on).toEqual({ provider: 'claude', fast: true });
    expect(chatDraftWithFast(on, false, CLAUDE)).toEqual({ provider: 'claude' });
    expect(chatDraftWithFast({ provider: 'codex' }, false, CODEX)).toEqual({
      provider: 'codex',
      fast: false,
    });
    expect(chatDraftWithFast({ provider: 'codex', fast: false }, true, CODEX)).toEqual({ provider: 'codex' });
  });

  it('compares choices by what answers', () => {
    expect(chatRuntimeSame({ provider: 'claude', model: 'opus' }, { provider: 'claude' }, CLAUDE)).toBe(true);
    expect(chatRuntimeSame({ provider: 'codex', fast: true }, { provider: 'codex' }, CODEX)).toBe(true);
    expect(chatRuntimeSame({ provider: 'claude', fast: true }, { provider: 'claude' }, CLAUDE)).toBe(false);
    expect(chatRuntimeSame({ provider: 'claude' }, { provider: 'codex' }, CLAUDE)).toBe(false);
  });

  it('stores null for a thread and sends nothing with chats.start when it is the assistant’s own (CR-02)', () => {
    const v = view({ default: { provider: 'claude', effort: 'high' } });
    expect(chatThreadChoice({ provider: 'claude', model: 'opus', effort: 'high' }, v)).toBeNull();
    expect(chatThreadChoice({ provider: 'codex' }, v)).toEqual({ provider: 'codex' });
    expect(chatStartRuntime(null, v)).toBeUndefined();
    expect(chatStartRuntime({ provider: 'claude', effort: 'high' }, v)).toBeUndefined();
    expect(chatStartRuntime({ provider: 'codex', effort: 'low' }, v)).toEqual({
      provider: 'codex',
      effort: 'low',
    });
  });
});

describe('the button (CR-01)', () => {
  it('names the model and effort, with the bolt when fast replies are on', () => {
    expect(chatRuntimeButton(view(), { provider: 'claude' })).toEqual({
      provider: 'claude',
      providerLabel: 'Claude',
      model: 'Opus',
      effort: 'Automatic',
      label: 'Opus · Automatic',
      fast: false,
      ariaLabel: 'Choose how Neo answers',
    });
    const sol = chatRuntimeButton(view(), { provider: 'codex', effort: 'high' });
    expect([sol.label, sol.fast, sol.providerLabel]).toEqual(['GPT-6.1 Sol · High', true, 'ChatGPT']);
    expect(chatRuntimeButton(view(), { provider: 'codex', model: 'gpt-6-astra' }).fast).toBe(false);
  });

  it('says the choice on hover or a long press, with the scope when given (AP-2960, AP-2961)', () => {
    const opus = chatRuntimeButton(view(), { provider: 'claude' });
    expect(chatRuntimeLine(opus)).toBe('Opus · Automatic');
    expect(chatRuntimeLine(opus, 'For this thread')).toBe('Opus · Automatic · For this thread');
    const sol = chatRuntimeButton(view(), { provider: 'codex', effort: 'high' });
    expect(chatRuntimeLine(sol)).toBe('GPT-6.1 Sol · High · Fast replies');
  });
});

describe('the popover', () => {
  it('has Claude · ChatGPT, greyed when not ready, with the usage line (CR-04, CR-09)', () => {
    const v = view({
      providers: view().providers.map((p) =>
        p.provider === 'codex' ? { ...p, ready: false, usage: null } : p,
      ),
    });
    expect(chatProviderSegments(v, { provider: 'claude' })).toEqual([
      { provider: 'claude', label: 'Claude', ready: true, picked: true },
      { provider: 'codex', label: 'ChatGPT', ready: false, picked: false },
    ]);
    expect(chatProviderHints(v)).toEqual({
      usage: 'This 5 hours: Claude 38% used',
      notSetUp: [{ provider: 'codex', text: 'ChatGPT isn’t set up on this Whombat.' }],
    });
    expect(chatProviderHints(view()).usage).toBe('This 5 hours: Claude 38% used · ChatGPT 12% used');
    expect(chatProviderHints(view({ providers: [] })).notSetUp.map((h) => h.provider)).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('lists four models, or three and “N more…”; the picked one always shows (CR-05)', () => {
    const claude = chatModelRows(CLAUDE, undefined);
    expect(claude.rows.map((r) => [r.label, r.isDefault, r.picked])).toEqual([
      ['Opus', true, true],
      ['Fable', false, false],
      ['Sonnet', false, false],
      ['Haiku', false, false],
    ]);
    expect(claude.more).toBe(0);
    const codexRows = chatModelRows(CODEX, undefined);
    expect(codexRows.rows).toHaveLength(CHAT_MODELS_SHOWN - 1);
    expect(codexRows.more).toBe(4);
    const picked = chatModelRows(CODEX, 'gpt-5.5');
    expect(picked.rows.map((r) => r.label)).toEqual(['GPT-6.1 Sol', 'GPT-6 Astra', 'GPT-6 Luna', 'GPT-5.5']);
    expect(picked.more).toBe(3);
    expect(chatModelRows(CODEX, undefined, true).rows).toHaveLength(7);
  });

  it('shows a model the list doesn’t have, and the default alone while the list isn’t known', () => {
    expect(chatModelRows([], undefined)).toEqual({
      rows: [{ id: null, label: 'Default', description: null, isDefault: true, picked: true }],
      more: 0,
    });
    expect(chatModelRows(CLAUDE, 'claude-opus-4').rows.at(-1)).toMatchObject({
      id: 'claude-opus-4',
      picked: true,
    });
  });

  it('offers Automatic and the model’s levels', () => {
    expect(
      chatEffortChoices(CLAUDE, { provider: 'claude', effort: 'high' }).map((e) => [e.label, e.picked]),
    ).toEqual([
      ['Automatic', false],
      ['Low', false],
      ['Medium', false],
      ['High', true],
      ['Extra high', false],
      ['Max', false],
    ]);
    expect(chatEffortChoices(CODEX, { provider: 'codex' }).at(-1)?.label).toBe('Ultra');
    expect(chatEffortChoices(CLAUDE, { provider: 'claude', model: 'haiku' })).toEqual([]);
    expect(chatEffortChoices([], { provider: 'claude' })).toHaveLength(7);
  });

  it('says what fast replies do, cost and why not (CR-06)', () => {
    const claude = view().providers[0] as never;
    expect(chatFastRow(claude, { provider: 'claude', fast: true })).toMatchObject({
      kind: 'offered',
      on: true,
      text: 'Up to 2½× faster. Paid from usage credits on your Claude account, not from your plan.',
      note: null,
    });
    expect(chatFastRow(claude, { provider: 'claude', model: 'sonnet' })).toMatchObject({
      kind: 'none',
      text: 'Only Opus has fast replies. Sonnet is picked.',
    });
    expect(chatFastRow({ models: CLAUDE, fastBlocked: 'gateway' }, { provider: 'claude' })).toMatchObject({
      kind: 'blocked',
      text: 'Fast replies don’t go through the AI gateway.',
    });
    expect(chatFastRow({ models: [], fastBlocked: null }, { provider: 'claude' })).toEqual({
      kind: 'hidden',
    });
    expect(chatFastRow(view().providers[1] as never, { provider: 'codex' })).toMatchObject({ on: true });
  });

  it('warns about reading the whole thread at the fast price in a Claude thread with replies', () => {
    const claude = view().providers[0] as never;
    const replies = [{ ranOn: ran() }, { ranOn: null }];
    const state = chatThreadState(replies);
    expect(state).toEqual({ replies: 2, lastFast: false });
    const row = chatFastRow(claude, { provider: 'claude' }, state);
    expect(row.kind === 'offered' && row.note).toContain('fast price');
    expect(chatFastRow(claude, { provider: 'claude' }, { replies: 0, lastFast: false })).toMatchObject({
      note: null,
    });
    expect(
      chatFastRow(claude, { provider: 'claude' }, chatThreadState([{ ranOn: ran({ fast: true }) }])),
    ).toMatchObject({ note: null });
    expect(chatFastRow(view().providers[1] as never, { provider: 'codex' }, state)).toMatchObject({
      note: null,
    });
    // A fast answer from ChatGPT didn't read the thread at Claude's fast price.
    const fromChatGpt = chatThreadState([{ ranOn: ran({ provider: 'codex', fast: true }) }]);
    expect(fromChatGpt.lastFast).toBe(false);
  });

  it('scopes the choice and makes it the default (CR-02, CR-03)', () => {
    expect(chatRuntimeScope(true)).toBe('For this thread');
    expect(chatRuntimeScope(false)).toBe('For your next question');
    expect(chatMakeDefaultShown(view(), { provider: 'codex' })).toBe(true);
    expect(chatMakeDefaultShown(view(), { provider: 'claude', model: 'opus' })).toBe(false);
    expect(chatDefaultBody({ provider: 'codex', model: 'gpt-6-astra', effort: 'high', fast: false })).toEqual(
      {
        provider: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
        fast: false,
      },
    );
    expect(chatDefaultBody({ provider: 'claude' })).toEqual({ provider: 'claude' });
    expect(chatMadeDefaultText(view(), { provider: 'claude', effort: 'high' })).toBe(
      'Neo now answers with Opus · High by default.',
    );
  });

  it('puts the Whombat’s words on a refusal, else its own', () => {
    expect(chatRuntimeRefusalText({ status: 'blocked', message: 'Not yours.' })).toBe('Not yours.');
    expect(
      chatRuntimeRefusalText(
        new ApiError(409, 'conflict', 'Codex isn’t ready.', null, 'chats.setThreadRuntime'),
      ),
    ).toBe('Codex isn’t ready.');
    expect(chatRuntimeRefusalText(new TypeError('offline'))).toBe(CHAT_RUNTIME_NOT_SAVED);
  });
});

describe('Local, the model on the burrow’s network (CT-1174, AP-5002)', () => {
  const LOCAL = localProviderModels({
    model: 'llama3.3:70b',
    label: 'Llama on the NAS',
    check: { state: 'ok', at: '2026-10-23T09:00:00.000Z', models: ['qwen3:32b'], detail: null },
  });
  const withLocal = view({
    providers: [
      ...view().providers,
      { provider: 'local', ready: true, models: LOCAL, fastBlocked: null, usage: null },
    ],
  });

  it('is a third choice only where the Whombat lists it, or the choice is on it', () => {
    expect(chatProviderSegments(view(), { provider: 'claude' }).map((s) => s.provider)).toEqual([
      'claude',
      'codex',
    ]);
    expect(chatProviderSegments(withLocal, { provider: 'claude' }).map((s) => [s.provider, s.label])).toEqual(
      [
        ['claude', 'Claude'],
        ['codex', 'ChatGPT'],
        ['local', 'Local'],
      ],
    );
    const onIt = chatProviderSegments(view(), { provider: 'local' }).at(-1);
    expect(onIt).toEqual({ provider: 'local', label: 'Local', ready: false, picked: true });
    expect(chatProviderHints(withLocal).notSetUp).toEqual([]);
  });

  it('in a started thread offers only its own provider, and only its words (HN-06, AP-5600, AP-5601)', () => {
    const v = view();
    expect(chatProviderSegments(v, { provider: 'codex', effort: 'high' }, true)).toEqual([
      { provider: 'codex', label: 'ChatGPT', ready: true, picked: true },
    ]);
    expect(chatProviderHints(v, 'claude')).toEqual({
      usage: 'This 5 hours: Claude 38% used',
      notSetUp: [],
    });
    expect(chatProviderHints(v, 'codex').usage).toBe('This 5 hours: ChatGPT 12% used');
    // A thread on a provider that can't run any more says so, and nothing of the other.
    const off = view({ providers: [] });
    expect(chatProviderSegments(off, { provider: 'codex' }, true)).toEqual([
      { provider: 'codex', label: 'ChatGPT', ready: false, picked: true },
    ]);
    expect(chatProviderHints(off, 'codex').notSetUp.map((h) => h.provider)).toEqual(['codex']);
  });

  it('names its model alone: no effort, no bolt, no fast replies row', () => {
    const local = chatDraftWithProvider({ provider: 'claude', effort: 'high' }, 'local');
    expect(local).toEqual({ provider: 'local' });
    const button = chatRuntimeButton(withLocal, local);
    expect([button.providerLabel, button.label, button.effort, button.fast]).toEqual([
      'Local',
      'Llama on the NAS',
      '',
      false,
    ]);
    expect(chatEffortChoices(LOCAL, local)).toEqual([]);
    expect(chatFastRow(withLocal.providers[2], { provider: 'local', fast: true }).kind).toBe('hidden');
    expect(chatMadeDefaultText(withLocal, local)).toContain('Llama on the NAS');
  });

  it('takes a model its list doesn’t name, which then shows picked', () => {
    const typed = chatDraftWithModel({ provider: 'local' }, 'mistral-small', LOCAL);
    expect(typed).toEqual({ provider: 'local', model: 'mistral-small' });
    expect(chatModelRows(LOCAL, typed.model).rows.map((r) => [r.label, r.picked])).toEqual([
      ['Llama on the NAS', false],
      ['qwen3:32b', false],
      ['mistral-small', true],
    ]);
    // The burrow's own model is its default: picking it follows the burrow.
    expect(chatDraftWithModel(typed, 'llama3.3:70b', LOCAL)).toEqual({ provider: 'local' });
    expect(chatDefaultBody(typed)).toEqual({ provider: 'local', model: 'mistral-small' });
  });
});

describe('what answered (CR-07, CR-08)', () => {
  it('marks a reply with its provider and the full line', () => {
    expect(ranOnMark({ ranOn: ran({ effort: 'high', fast: true }) })).toEqual({
      provider: 'claude',
      label: 'Claude',
      title: 'Claude · Opus · High effort · Fast',
    });
    expect(ranOnMark({ ranOn: null })).toBeNull();
    expect(ranOnMark({})).toBeNull();
  });

  it('shows the mark only where more than one AI can answer', () => {
    const entry = (provider: 'claude' | 'codex', ready: boolean) => ({
      provider,
      ready,
      models: [],
      fastBlocked: null,
      usage: null,
    });
    expect(ranOnMarked({ providers: [entry('claude', true), entry('codex', false)] })).toBe(false);
    expect(ranOnMarked({ providers: [entry('claude', true), entry('codex', true)] })).toBe(true);
    expect(ranOnMarked(null)).toBe(false);
  });

  it('puts a divider before a reply that ran on something else, skipping messages without ranOn', () => {
    const switches = ranOnSwitches([
      { id: 'msg_1', ranOn: ran() },
      { id: 'msg_2', ranOn: null },
      { id: 'msg_3', ranOn: ran() },
      {
        id: 'msg_4',
        ranOn: ran({ provider: 'codex', model: 'gpt-6.1-sol', modelLabel: 'GPT-6.1 Sol', effort: 'high' }),
      },
    ]);
    expect([...switches.keys()]).toEqual(['msg_4']);
    expect(switches.get('msg_4')).toEqual({
      messageId: 'msg_4',
      provider: 'codex',
      text: 'Switched to ChatGPT · High effort',
    });
  });

  it('says quietly when fast replies or the model didn’t happen, only what the person can change', () => {
    // Busy or briefly unavailable: the reply came anyway and there is nothing to do.
    expect(ranOnNotes(ran({ fastSkipped: 'busy' }))).toEqual([]);
    expect(ranOnNotes(ran({ fastSkipped: 'unavailable' }))).toEqual([]);
    expect(ranOnNotes(ran({ fastSkipped: 'credits' }))[0]?.text).toMatch(/usage credits/);
    expect(ranOnNotes(ran({ modelSkipped: 'fable' }), CLAUDE)).toEqual([
      { kind: 'model', text: 'Fable wasn’t available, so this one came from Opus.' },
    ]);
    expect(ranOnNotes(null)).toEqual([]);
  });
});
