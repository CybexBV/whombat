/**
 * What answers in Chat (0.96, CT-459…CT-462; Whombat chat-runtime.md CR-01…CR-11): the person picks the provider
 * (Claude or ChatGPT), the model, the effort and fast replies per thread of their Chat with the assistant. A thread's
 * choice (`ChatThread.runtime`) is a conversation preference, not a setting of the assistant: none (null) follows the
 * assistant's own runtime (`AgentModelRuntime`), and everything else the assistant does keeps that (CR-03). Each reply
 * says what answered it (`Message.ranOn`, CR-07).
 */
import { z } from 'zod';
import { PrincipalId } from '../ids.js';
import type { AgentModelRuntime } from './agent.js';
import { Timestamp } from './common.js';
import {
  AgentEffort,
  FastSkippedReason,
  ModelId,
  modelOf,
  type ProviderModel,
  ProviderModels,
  turnEffort,
} from './models.js';

/**
 * The providers Chat offers (CR-04), named for the sign-in: `claude` (“Claude”), `codex` (“ChatGPT”), and since 0.124
 * (CT-1174; Whombat HE-31) `local` (“Local”), the burrow's model on its network (`CHAT_PROVIDER_LABELS`). Every agent
 * provider is one.
 */
export const CHAT_PROVIDERS = ['claude', 'codex', 'local'] as const;
export const ChatProvider = z.enum(CHAT_PROVIDERS);
export type ChatProvider = z.infer<typeof ChatProvider>;

/**
 * A choice of what answers (CT-459): the provider, one of its models (absent: the tool's default), the effort (absent:
 * automatic, `turnEffort`) and fast replies (absent: the model's own default, `turnFast`). The same rules as
 * `AgentModelRuntime`'s; “Make this <Name>’s default” saves it there with `agent.update` (CR-03).
 */
export const ChatRuntime = z.object({
  provider: ChatProvider,
  model: ModelId.optional(),
  effort: AgentEffort.optional(),
  fast: z.boolean().optional(),
});
export type ChatRuntime = z.infer<typeof ChatRuntime>;

function isChatProvider(provider: string): provider is ChatProvider {
  return (CHAT_PROVIDERS as readonly string[]).includes(provider);
}

/** The assistant's own runtime as a choice; null when there is none (no button then, CR-01). */
export function chatRuntimeOf(
  runtime: Pick<AgentModelRuntime, 'provider' | 'model' | 'effort' | 'fast'> | null | undefined,
): ChatRuntime | null {
  if (!runtime || !isChatProvider(runtime.provider)) return null;
  const choice: ChatRuntime = { provider: runtime.provider };
  if (runtime.model) choice.model = runtime.model;
  if (runtime.effort) choice.effort = runtime.effort;
  if (runtime.fast !== undefined) choice.fast = runtime.fast;
  return choice;
}

/**
 * Another provider (CR-05): model, effort and fast go back to that provider's defaults. The same provider changes
 * nothing.
 */
export function chatRuntimeWithProvider(runtime: ChatRuntime, provider: ChatProvider): ChatRuntime {
  return runtime.provider === provider ? runtime : { provider };
}

/**
 * Another model of the same provider (CR-05; `id` absent: the tool's default): the effort stays within what the model
 * takes (`turnEffort`'s rule — the nearest lower, else the nearest higher; none for a model that takes none; automatic
 * stays automatic), and fast is dropped when the model has none (and `fast: false` is dropped for unknown models when
 * the provider's list is known, matching the server). A `local` provider never keeps effort or fast replies.
 */
export function chatRuntimeWithModel(
  runtime: ChatRuntime,
  id: string | null | undefined,
  models: readonly ProviderModel[] | null | undefined,
): ChatRuntime {
  const model = modelOf(models, id);
  const next: ChatRuntime = { provider: runtime.provider };
  if (id) next.model = id;
  if (runtime.provider === 'local') return next;
  if (runtime.effort) {
    const effort = model ? turnEffort(runtime.effort, 'chat', model.efforts) : runtime.effort;
    if (effort) next.effort = effort;
  }
  if (runtime.fast !== undefined && (model ? !!model.fast : !models?.length || runtime.fast === true))
    next.fast = runtime.fast;
  return next;
}

/** Whether two choices are the same (absent and null alike); CR-02 stores a choice equal to the assistant's as null. */
export function chatRuntimeEquals(
  a: ChatRuntime | null | undefined,
  b: ChatRuntime | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.provider === b.provider &&
    (a.model ?? null) === (b.model ?? null) &&
    (a.effort ?? null) === (b.effort ?? null) &&
    (a.fast ?? null) === (b.fast ?? null)
  );
}

/**
 * What answered an assistant's reply in Chat (0.96, CT-460; CR-07, CR-08), from the runner's `CompleteBody.ran`: the
 * provider, the model (null: the tool's default) and its label then (`modelLabel`, null when not known), the effort sent
 * (null: none), whether it ran fast; `fastSkipped` when fast was asked for and the reply came at the normal speed,
 * `modelSkipped` the model asked for when it wasn't available and the reply came from `model` instead.
 */
export const RanOn = z.object({
  provider: ChatProvider,
  model: ModelId.nullable(),
  modelLabel: z.string().max(60).nullable(),
  effort: AgentEffort.nullable(),
  fast: z.boolean(),
  fastSkipped: FastSkippedReason.nullable().optional(),
  modelSkipped: ModelId.nullable().optional(),
});
export type RanOn = z.infer<typeof RanOn>;

/** A provider's 5-hour window for this person (CR-09): how much is used, and when it resets (null: not known). */
export const ChatProviderUsage = z.object({
  usedPct: z.number().min(0).max(100),
  resetsAt: Timestamp.nullable(),
});
export type ChatProviderUsage = z.infer<typeof ChatProviderUsage>;

/**
 * One provider in the popover (CT-461; CR-04, CR-05, CR-06, CR-09): whether it can run this person's turns (`ready`;
 * else greyed with “Set it up”), its models (empty: not known, the default only), `fastBlocked` `gateway` when its turns
 * go through the AI gateway (no fast replies there), and its usage line's part (null: no known window, a gateway or an
 * organization key). `local` (CT-1174): ready once the burrow has a model on its network, its models
 * `localProviderModels`, no usage.
 */
export const ChatRuntimeProvider = z.object({
  provider: ChatProvider,
  ready: z.boolean(),
  models: ProviderModels,
  fastBlocked: z.enum(['gateway']).nullable(),
  usage: ChatProviderUsage.nullable(),
});
export type ChatRuntimeProvider = z.infer<typeof ChatRuntimeProvider>;

/**
 * `chats.runtime`'s answer (CT-461): the caller's assistant, its own runtime as a choice (`default`), the thread's choice
 * when one was asked for (`thread`; null: it follows the default; absent: no thread asked), and the providers (Claude, ChatGPT, and Local once the
 * burrow has a model on its network).
 */
export const ChatRuntimeView = z.object({
  assistantId: PrincipalId,
  assistantName: z.string().min(1).max(80),
  default: ChatRuntime.nullable(),
  thread: ChatRuntime.nullable().optional(),
  providers: z.array(ChatRuntimeProvider).max(CHAT_PROVIDERS.length),
});
export type ChatRuntimeView = z.infer<typeof ChatRuntimeView>;
