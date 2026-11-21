/**
 * What answers in Chat (Whombat chat-runtime.md CR-01…CR-11; contracts 0.96.0 CT-456…CT-468; app chat-runtime.md
 * AP-2680…): the composer's button and its popover (web) or sheet (phone) — where the button shows, what it says, the
 * draft rules (another provider resets, another model clamps), the models it lists, the fast replies row, the usage line
 * and the body of “Make this <Name>’s default” — and, in the thread, what answered a reply, the divider when that
 * changed and the quiet lines when fast replies or the model didn't happen. Every word is the contracts'
 * (`text/chat-runtime.ts`). Since contracts 0.124 (CT-1174; hermes-engine-app.md AP-5002) Local, the burrow's model on
 * its network, is a third provider where the Whombat lists it: its models by name, any other typed, no effort and no fast
 * replies. A started thread keeps its provider (Whombat hermes-native.md HN-06; thread-provider.md AP-5600…): its popover
 * offers only that provider's models, effort and fast replies; the provider is chosen for a new chat. Pure; web and phone
 * share it.
 */
import {
  AGENT_EFFORTS,
  type AgentEffort,
  type AgentModelRuntime,
  CHAT_PROVIDERS,
  type ChatProvider,
  type ChatRoom,
  type ChatRuntime,
  type ChatRuntimeProvider,
  type ChatRuntimeView,
  chatRuntimeEquals,
  chatRuntimeWithModel,
  chatRuntimeWithProvider,
  effortsFor,
  type Message,
  modelOf,
  type ProviderModel,
  type RanOn,
} from '@whombat/core/domain';
import {
  CHAT_PROVIDER_LABELS,
  CHAT_RUNTIME_COPY,
  chatModelLabel,
  chatRuntimeChip,
  chatUsageLine,
  EFFORT_LABELS,
  effortLabel,
  fastNoneText,
  fastSkippedText,
  MODEL_EFFORT_COPY,
  modelSkippedText,
  ranOnText,
  runSwitchText,
} from '@whombat/core/text';
import { ApiError } from '../http/errors';

/**
 * Whether the composer shows the button (CR-01, CR-11): the Chat room (not Feedback or other rooms), and an assistant on
 * Claude Code or ChatGPT (`default` not null). Hidden while `chats.runtime` hasn't answered.
 */
export function chatRuntimeShown(where: {
  room: ChatRoom | null | undefined;
  view: Pick<ChatRuntimeView, 'default'> | null | undefined;
}): boolean {
  return where.room === 'chat' && !!where.view?.default;
}

/** One provider of the view (absent: not offered on this Whombat). */
export function chatProviderOf(
  view: Pick<ChatRuntimeView, 'providers'> | null | undefined,
  provider: ChatProvider,
): ChatRuntimeProvider | null {
  return view?.providers.find((p) => p.provider === provider) ?? null;
}

/** A provider's models as the view lists them; empty when not known (the default only). */
export function chatModelsOf(
  view: Pick<ChatRuntimeView, 'providers'> | null | undefined,
  provider: ChatProvider,
): readonly ProviderModel[] {
  return chatProviderOf(view, provider)?.models ?? [];
}

/**
 * The choice in effect: the composer's own draft (the top-level box before sending), else the thread's stored choice,
 * else the assistant's default (CR-02). Null when the assistant isn't on Claude Code or ChatGPT.
 */
export function chatRuntimeInEffect(
  view: Pick<ChatRuntimeView, 'default' | 'thread'> | null | undefined,
  draft?: ChatRuntime | null,
): ChatRuntime | null {
  return draft ?? view?.thread ?? view?.default ?? null;
}

/** Fast replies as a choice has them: its own `fast`, else the model's default; never for a model without them. */
export function chatFastOn(
  runtime: ChatRuntime,
  models: readonly ProviderModel[] | null | undefined,
): boolean {
  return chatRuntimeChip(runtime, models).fast;
}

/**
 * Whether two choices answer the same (CR-02): the same provider, the same model (the tool's default by its id), the
 * same effort and fast replies as each has them. A choice the same as the assistant's is stored as null.
 */
export function chatRuntimeSame(
  a: ChatRuntime | null | undefined,
  b: ChatRuntime | null | undefined,
  models: readonly ProviderModel[] | null | undefined,
): boolean {
  if (chatRuntimeEquals(a, b)) return true;
  if (!a || !b || a.provider !== b.provider) return false;
  const id = (r: ChatRuntime) => modelOf(models, r.model)?.id ?? r.model ?? null;
  return (
    id(a) === id(b) &&
    (a.effort ?? null) === (b.effort ?? null) &&
    chatFastOn(a, models) === chatFastOn(b, models)
  );
}

/** A changed choice, back to `base` itself when it answers the same (so the thread follows the default again). */
function settle(
  next: ChatRuntime,
  base: ChatRuntime | null | undefined,
  models: readonly ProviderModel[] | null | undefined,
): ChatRuntime {
  return base && chatRuntimeSame(next, base, models) ? base : next;
}

/**
 * Another provider picked (CR-05): model, effort and fast go back to that provider's defaults — the assistant's own
 * choice when it is on that provider. The same provider changes nothing.
 */
export function chatDraftWithProvider(
  runtime: ChatRuntime,
  provider: ChatProvider,
  base?: ChatRuntime | null,
): ChatRuntime {
  if (runtime.provider === provider) return runtime;
  return base?.provider === provider ? base : chatRuntimeWithProvider(runtime, provider);
}

/**
 * Another model picked (CR-05; `id` null: the tool's default): the effort stays within what it takes, fast is dropped
 * when it has none (`chatRuntimeWithModel`). The default model is kept as “the default” (no id), so it follows the tool.
 */
export function chatDraftWithModel(
  runtime: ChatRuntime,
  id: string | null,
  models: readonly ProviderModel[] | null | undefined,
  base?: ChatRuntime | null,
): ChatRuntime {
  const model = modelOf(models, id);
  const next = chatRuntimeWithModel(runtime, model?.isDefault ? null : id, models);
  return settle(next, base, models);
}

/** Another effort picked (null: automatic). */
export function chatDraftWithEffort(
  runtime: ChatRuntime,
  effort: AgentEffort | null,
  models: readonly ProviderModel[] | null | undefined,
  base?: ChatRuntime | null,
): ChatRuntime {
  const { effort: _, ...rest } = runtime;
  return settle(effort ? { ...rest, effort } : rest, base, models);
}

/** Fast replies turned on or off; left out when that is the model's own default (`fast` absent). */
export function chatDraftWithFast(
  runtime: ChatRuntime,
  on: boolean,
  models: readonly ProviderModel[] | null | undefined,
  base?: ChatRuntime | null,
): ChatRuntime {
  const { fast: _, ...rest } = runtime;
  const offered = modelOf(models, runtime.model)?.fast;
  const next = offered && on === (offered === 'on') ? rest : { ...rest, fast: on };
  return settle(next, base, models);
}

/** What a thread stores (CR-02): null when the choice answers the same as the assistant's own. */
export function chatThreadChoice(
  runtime: ChatRuntime,
  view: Pick<ChatRuntimeView, 'default' | 'providers'>,
): ChatRuntime | null {
  return chatRuntimeSame(runtime, view.default, chatModelsOf(view, runtime.provider)) ? null : runtime;
}

/** The top-level box's `chats.start` `runtime` (CR-02): absent when it is the assistant's own. */
export function chatStartRuntime(
  draft: ChatRuntime | null | undefined,
  view: Pick<ChatRuntimeView, 'default' | 'providers'> | null | undefined,
): ChatRuntime | undefined {
  if (!draft || !view) return undefined;
  return chatThreadChoice(draft, view) ?? undefined;
}

/* The button ----------------------------------------------------------------------------------------------------- */

/**
 * A choice in words (CR-01): “Opus · Automatic”, “GPT-6.1 Sol · High”; a model on the network by its name alone, since
 * it takes no effort (“Llama on the NAS”, AP-5002).
 */
function choiceLabel(runtime: ChatRuntime, models: readonly ProviderModel[] | null | undefined): string {
  return runtime.provider === 'local'
    ? chatModelLabel(models, runtime.model)
    : chatRuntimeChip(runtime, models).label;
}

export interface ChatRuntimeButton {
  provider: ChatProvider;
  /** “Claude”, “ChatGPT”: the mark's accessible name. */
  providerLabel: string;
  /** “Opus”. */
  model: string;
  /** “Automatic”, “High”: shown after a middle dot, muted; empty for Local, which takes none. */
  effort: string;
  /** “Opus · Automatic”; Local's model alone (“Llama on the NAS”). */
  label: string;
  /** The bolt (CR-01). */
  fast: boolean;
  /** “Choose how Neo answers”. */
  ariaLabel: string;
}

/** The composer's button (CR-01): the provider's mark, the model's label, “· <effort>” and a bolt with fast replies on. */
export function chatRuntimeButton(
  view: Pick<ChatRuntimeView, 'providers' | 'assistantName'>,
  runtime: ChatRuntime,
): ChatRuntimeButton {
  const models = chatModelsOf(view, runtime.provider);
  const chip = chatRuntimeChip(runtime, models);
  const local = runtime.provider === 'local';
  return {
    provider: runtime.provider,
    providerLabel: CHAT_PROVIDER_LABELS[runtime.provider],
    model: chatModelLabel(models, runtime.model),
    effort: local ? '' : effortLabel(runtime.effort),
    label: choiceLabel(runtime, models),
    fast: !local && chip.fast,
    ariaLabel: CHAT_RUNTIME_COPY.buttonLabel(view.assistantName),
  };
}

/**
 * What the composer's icon says without opening it (AP-2960, AP-2961): “Opus · Automatic”, “GPT-6.1 Sol · High · Fast
 * replies”, and after it the scope when given (the phone's long press: “Opus · Automatic · For this thread”).
 */
export function chatRuntimeLine(button: Pick<ChatRuntimeButton, 'label' | 'fast'>, scope?: string): string {
  return [button.label, button.fast ? CHAT_RUNTIME_COPY.fast : null, scope ?? null]
    .filter((part): part is string => !!part)
    .join(' · ');
}

/* The popover --------------------------------------------------------------------------------------------------- */

export interface ChatProviderSegment {
  provider: ChatProvider;
  /** “Claude”, “ChatGPT”. */
  label: string;
  /** False: greyed, with `notSetUp` and “Set it up” (CR-04). */
  ready: boolean;
  picked: boolean;
}

/**
 * The switch (CR-01, CR-04): Claude · ChatGPT, and Local where the Whombat lists it (a model on its network, AP-5002) or
 * the choice is on it; each greyed when it can't run this person's turns. In a thread (`inThread`) only the thread's own
 * provider, picked: a started thread keeps it (HN-06, AP-5600), so there is nothing to switch to.
 */
export function chatProviderSegments(
  view: Pick<ChatRuntimeView, 'providers'>,
  runtime: ChatRuntime,
  inThread = false,
): ChatProviderSegment[] {
  if (inThread)
    return [
      {
        provider: runtime.provider,
        label: CHAT_PROVIDER_LABELS[runtime.provider],
        ready: chatProviderOf(view, runtime.provider)?.ready ?? false,
        picked: true,
      },
    ];
  const shown = CHAT_PROVIDERS.filter(
    (p) => p !== 'local' || runtime.provider === 'local' || !!chatProviderOf(view, p),
  );
  return shown.map((provider) => ({
    provider,
    label: CHAT_PROVIDER_LABELS[provider],
    ready: chatProviderOf(view, provider)?.ready ?? false,
    picked: runtime.provider === provider,
  }));
}

/**
 * The lines under the switch: the usage line (CR-09), then “ChatGPT isn’t set up on this Whombat.” per greyed one. With
 * `only` (a thread's provider, AP-5601) the line and the words are that provider's alone.
 */
export function chatProviderHints(
  view: Pick<ChatRuntimeView, 'providers'>,
  only?: ChatProvider,
): {
  usage: string | null;
  notSetUp: { provider: ChatProvider; text: string }[];
} {
  const segments = only
    ? chatProviderSegments(view, { provider: only }, true)
    : chatProviderSegments(view, { provider: 'claude' });
  return {
    usage: chatUsageLine(only ? view.providers.filter((p) => p.provider === only) : view.providers),
    notSetUp: segments
      .filter((s) => !s.ready)
      .map((s) => ({ provider: s.provider, text: CHAT_RUNTIME_COPY.notSetUp(s.label) })),
  };
}

/** How many model rows the web popover shows before “N more…” (CR-05; the mock's four lines). */
export const CHAT_MODELS_SHOWN = 4;

export interface ChatModelRow {
  /** What picking it sets (`chatDraftWithModel`); null: the tool's default. */
  id: string | null;
  /** “Opus”. */
  label: string;
  /** The tool's own line about it. */
  description: string | null;
  /** Tagged DEFAULT. */
  isDefault: boolean;
  picked: boolean;
}

/**
 * The model list (CR-05): the tool's models in its order, the default tagged; a list longer than four shows three and
 * “N more…” (`more`) until opened — the picked one always shows. A model the list doesn't have (or an unknown list)
 * shows by its id, so what is picked always shows.
 */
export function chatModelRows(
  models: readonly ProviderModel[] | null | undefined,
  picked: string | null | undefined,
  open = false,
): { rows: ChatModelRow[]; more: number } {
  const current = modelOf(models, picked);
  const all: ChatModelRow[] = (models ?? []).map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
    isDefault: m.isDefault,
    picked: current?.id === m.id,
  }));
  if (!current)
    all.push({
      id: picked ?? null,
      label: chatModelLabel(models, picked),
      description: null,
      isDefault: !picked,
      picked: true,
    });
  if (open || all.length <= CHAT_MODELS_SHOWN) return { rows: all, more: 0 };
  const shown = all.filter((r, i) => i < CHAT_MODELS_SHOWN - 1 || r.picked);
  return { rows: shown, more: all.length - shown.length };
}

/** The effort pills (CR-05): Automatic, then the levels the model takes; none for a model that takes none. */
export function chatEffortChoices(
  models: readonly ProviderModel[] | null | undefined,
  runtime: ChatRuntime,
): { value: AgentEffort | null; label: string; picked: boolean }[] {
  const efforts = effortsFor(models?.length ? models : null, runtime.model);
  const current = runtime.effort ?? null;
  if (efforts.length === 0 && !current) return [];
  return [
    { value: null, label: MODEL_EFFORT_COPY.automatic, picked: current === null },
    ...AGENT_EFFORTS.filter((e) => efforts.includes(e) || e === current).map((e) => ({
      value: e,
      label: EFFORT_LABELS[e],
      picked: e === current,
    })),
  ];
}

/**
 * The thread the popover is for, when it is one: how many replies it has and whether its last answer ran fast on Claude
 * (then the thread was read at the fast price already; an answer from ChatGPT doesn't count).
 */
export interface ChatThreadState {
  replies: number;
  lastFast: boolean;
}

/**
 * The Fast replies row (CR-06): `offered` with the provider's hint (and, in a Claude thread with replies whose last
 * reply wasn't fast, that turning it on reads the whole thread once at the fast price); `blocked` greyed when the
 * provider's turns go through the AI gateway; `none` greyed when the picked model has none (“Only Opus has fast
 * replies. Sonnet is picked.”); `hidden` when no model of the provider has them.
 */
export type ChatFastRow =
  | { kind: 'hidden' }
  | { kind: 'none'; title: string; text: string }
  | { kind: 'blocked'; title: string; text: string }
  | { kind: 'offered'; title: string; text: string; on: boolean; note: string | null };

export function chatFastRow(
  provider: Pick<ChatRuntimeProvider, 'models' | 'fastBlocked'> | null | undefined,
  runtime: ChatRuntime,
  thread?: ChatThreadState | null,
): ChatFastRow {
  const models = provider?.models ?? [];
  // Local's models have no fast replies (CT-1173).
  if (runtime.provider === 'local' || !models.some((m) => m.fast)) return { kind: 'hidden' };
  const title = CHAT_RUNTIME_COPY.fast;
  if (provider?.fastBlocked === 'gateway')
    return { kind: 'blocked', title, text: CHAT_RUNTIME_COPY.fastGateway };
  const model = modelOf(models, runtime.model);
  if (model && !model.fast) return { kind: 'none', title, text: fastNoneText(models, runtime.model) };
  const note =
    runtime.provider === 'claude' && thread && thread.replies > 0 && !thread.lastFast
      ? CHAT_RUNTIME_COPY.fastMidThread
      : null;
  return {
    kind: 'offered',
    title,
    text: CHAT_RUNTIME_COPY.fastHint[runtime.provider],
    on: chatFastOn(runtime, models),
    note,
  };
}

/** The footer's scope (CR-01): “For this thread” in a thread, “For your next question” in the top-level box. */
export function chatRuntimeScope(inThread: boolean): string {
  return inThread ? CHAT_RUNTIME_COPY.scopeThread : CHAT_RUNTIME_COPY.scopeNext;
}

/** “Make this <Name>’s default” (CR-03): shown while the choice isn't already the assistant's own. */
export function chatMakeDefaultShown(
  view: Pick<ChatRuntimeView, 'default' | 'providers'>,
  runtime: ChatRuntime,
): boolean {
  return !chatRuntimeSame(runtime, view.default, chatModelsOf(view, runtime.provider));
}

/** `agents.update`'s `runtime` for “Make this <Name>’s default”: the whole choice, fast replies too (CR-03, ME-01). */
export function chatDefaultBody(runtime: ChatRuntime): AgentModelRuntime {
  return {
    provider: runtime.provider,
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.effort ? { effort: runtime.effort } : {}),
    ...(runtime.fast !== undefined ? { fast: runtime.fast } : {}),
  };
}

/** The toast after it (CR-03): “Neo now answers with Opus · High by default.” */
export function chatMadeDefaultText(
  view: Pick<ChatRuntimeView, 'assistantName' | 'providers'>,
  runtime: ChatRuntime,
): string {
  return CHAT_RUNTIME_COPY.madeDefault(
    view.assistantName,
    choiceLabel(runtime, chatModelsOf(view, runtime.provider)),
  );
}

/* The thread ---------------------------------------------------------------------------------------------------- */

export interface RanOnMark {
  provider: ChatProvider;
  /** “Claude”, “ChatGPT”: shown after the time. */
  label: string;
  /** “Claude · Opus · High effort · Fast”: the tooltip (CR-07). */
  title: string;
}

/**
 * Whether replies show their provider's mark after the time: only where more than one AI can answer (Claude and
 * ChatGPT signed in, or a model on the network). With one, every reply comes from it and the mark says nothing; the
 * whole line stays on the time's hover or long press, and a switch has its divider. Unknown (still loading): no mark.
 */
export function ranOnMarked(view: Pick<ChatRuntimeView, 'providers'> | null | undefined): boolean {
  return (view?.providers ?? []).filter((p) => p.ready).length > 1;
}

/** What answered an assistant's reply (CR-07): the provider's mark and label after the time; null without `ranOn`. */
export function ranOnMark(message: Pick<Message, 'ranOn'>): RanOnMark | null {
  const r = message.ranOn;
  if (!r) return null;
  return { provider: r.provider, label: CHAT_PROVIDER_LABELS[r.provider], title: ranOnText(r) };
}

/**
 * The quiet lines under a reply (CR-08): the model asked for wasn't available (“Fable wasn’t available, so this one came
 * from Opus.”), fast replies didn't happen for a reason the person can change (credits, a setting of their
 * organisation). Fast replies that were only busy or briefly unavailable say nothing: the reply came anyway, and there
 * is nothing to do. `models` names the skipped model.
 */
export function ranOnNotes(
  ranOn: RanOn | null | undefined,
  models?: readonly ProviderModel[] | null,
): { kind: 'model' | 'fast'; text: string }[] {
  if (!ranOn) return [];
  const notes: { kind: 'model' | 'fast'; text: string }[] = [];
  if (ranOn.modelSkipped) {
    const used = ranOn.modelLabel ?? chatModelLabel(models, ranOn.model);
    notes.push({ kind: 'model', text: modelSkippedText(chatModelLabel(models, ranOn.modelSkipped), used) });
  }
  if (ranOn.fastSkipped && ranOn.fastSkipped !== 'busy' && ranOn.fastSkipped !== 'unavailable')
    notes.push({ kind: 'fast', text: fastSkippedText(ranOn.fastSkipped, ranOn.provider) });
  return notes;
}

export interface RanOnSwitch {
  /** The reply the divider goes before. */
  messageId: string;
  /** Its provider's mark. */
  provider: ChatProvider;
  /** “Switched to ChatGPT · High effort”. */
  text: string;
}

/**
 * The dividers of a thread's messages, oldest first (CR-07): before each assistant reply that ran on something else
 * than the previous reply with `ranOn`, `runSwitchText`. Messages without `ranOn` (a person's, an older reply) are
 * passed over.
 */
export function ranOnSwitches(messages: readonly Pick<Message, 'id' | 'ranOn'>[]): Map<string, RanOnSwitch> {
  const out = new Map<string, RanOnSwitch>();
  let prev: RanOn | null = null;
  for (const m of messages) {
    if (!m.ranOn) continue;
    const text = runSwitchText(prev, m.ranOn);
    if (text) out.set(m.id, { messageId: m.id, provider: m.ranOn.provider, text });
    prev = m.ranOn;
  }
  return out;
}

/** The popover's thread state from a thread's replies, oldest first (`chatFastRow`'s mid-thread note). */
export function chatThreadState(replies: readonly Pick<Message, 'ranOn'>[]): ChatThreadState {
  const last = [...replies].reverse().find((m) => m.ranOn);
  return { replies: replies.length, lastFast: last?.ranOn?.provider === 'claude' && last.ranOn.fast };
}

/**
 * Words when a thread's choice wasn't saved (the popover puts it back): the Whombat's own for a refusal (a key it needs,
 * a 4xx), else that it didn't go through. Not in the contracts' words yet (app chat-runtime.md AP-2689).
 */
export const CHAT_RUNTIME_NOT_SAVED = 'Couldn’t change that. Try again in a moment.';

export function chatRuntimeRefusalText(outcome: unknown): string {
  if (outcome instanceof ApiError)
    return outcome.status < 500 && outcome.message ? outcome.message : CHAT_RUNTIME_NOT_SAVED;
  if (outcome && typeof outcome === 'object' && 'status' in outcome) {
    const o = outcome as { status: unknown; message?: unknown };
    if (o.status === 'blocked' && typeof o.message === 'string' && o.message) return o.message;
  }
  return CHAT_RUNTIME_NOT_SAVED;
}
