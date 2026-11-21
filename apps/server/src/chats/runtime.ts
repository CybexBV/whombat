/**
 * What answers in Chat (docs/decisions/chat-runtime.md CR-01…CR-11; chat-runtime-server.md CR-S…): a person picks the
 * provider, model, effort and fast replies per thread of their Chat with their assistant. A thread's choice is stored by
 * its first message (`chat_thread_runtimes`) through the commit pipeline (`set_chat_thread_runtime`, and `start_chat`
 * with `runtime`), only by the Chat's person, only on a top-level message of their Chat (not the Feedback room, task
 * chats or any other room), checked against what the provider offers this person now, and stored as nothing when it is
 * the assistant's own. A turn woken in such a thread is resolved to it when it is queued (`dispatchRuntimeFor`,
 * `dispatches.runtime`). A thread that has a turn keeps its provider (hermes-native.md HN-06): its model, effort and fast
 * replies stay free. `chats.runtime` reads it all for the popover.
 */
import {
  CHAT_PROVIDER_LABELS,
  CHAT_PROVIDERS,
  type ChatProvider,
  type ChatRuntime,
  type ChatRuntimeProvider,
  type ChatRuntimeView,
  chatRuntimeEquals,
  chatRuntimeOf,
  MessageId,
  SetChatThreadRuntimeBody,
  topics,
} from '@whombat/core';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { chatThreadRuntimes, dispatches, subscriptionUsage } from '../db/schema/index';
import { switchedGateway } from '../gateway/store';
import { ApiError, forbidden, notFound } from '../lib/errors';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import { loadMessageRow } from '../read/messages';
import { agentRuntimeOf, loadAgentRow, loadPrincipalRow, type PrincipalRow } from '../read/principals';
import { providerReadiness } from '../runtime/readiness';
import type { Services } from '../services';
import { chatRoomOf } from './rooms';
import {
  type ChatProviderFacts,
  checkChoice,
  fiveHourUsage,
  resolveThreadRuntime,
  THREAD_CHOICE_TRIGGERS,
} from './runtime-rules';
import { burrowLocalModel, providerModels, threadChoices } from './thread-runtime';

/** A thread of a person's Chat: its first message, its room and the room's assistant. */
export interface ChatThreadRef {
  rootId: string;
  conversation: ConversationRow;
  agent: PrincipalRow;
}

/** Whether a conversation is `personId`'s Chat with the agent (CHT-01, CR-01). */
function isChatOf(conversation: ConversationRow, personId: string): boolean {
  return conversation.dmPersonId === personId && chatRoomOf(conversation) === 'chat';
}

/**
 * A thread of `personId`'s Chat by its first message: a top-level message (not deleted) of their Chat with their own
 * assistant. Null for anything else — a Chat that isn't theirs, the Feedback room, a task chat, a channel, a reply.
 */
export async function chatThreadOf(
  db: Db,
  burrowId: string,
  personId: string,
  rootId: string,
): Promise<ChatThreadRef | null> {
  const root = await loadMessageRow(db, rootId);
  if (!root || root.burrowId !== burrowId || root.threadRootId !== null || root.deletedAt) return null;
  const conversation = await loadConversationRow(db, root.conversationId);
  if (!conversation || !isChatOf(conversation, personId)) return null;
  const agent = conversation.dmAgentId ? await loadPrincipalRow(db, conversation.dmAgentId) : undefined;
  if (agent?.kind !== 'agent') return null;
  return { rootId: root.id, conversation, agent };
}

/**
 * What `provider` offers `person`'s turns with `agent` now (CR-04…CR-06, CR-09): whether it can run them, its models,
 * whether its turns go through the AI gateway, and the 5-hour window of the sign-in they run on (none through the
 * gateway, on an organization key or when not known).
 */
export async function providerFacts(
  services: Services,
  agent: PrincipalRow,
  person: PrincipalRow,
  provider: ChatProvider,
): Promise<ChatProviderFacts & Omit<ChatRuntimeProvider, 'ready' | 'models' | 'fastBlocked'>> {
  const db = services.db;
  // The model on the person's network (CT-1170, CT-1173): ready once the burrow has one and a runner claims `local`;
  // its models are the burrow's own and the ones its last test listed. No gateway, no sign-in, no 5-hour window.
  if (provider === 'local') {
    const view = await burrowLocalModel(db, agent.burrowId);
    const ready = !!view && (await providerReadiness(services, agent, 'local', person)).ok;
    return { provider, ready, models: providerModels(services, 'local', view), gateway: false, usage: null };
  }
  const gateway = (await switchedGateway(db, agent.burrowId, provider)) !== null;
  const ready = (await providerReadiness(services, agent, provider, person)).ok;
  let usage: ChatRuntimeProvider['usage'] = null;
  if (!gateway) {
    // The person's own sign-in (one-person.md OP-S09).
    const accountId = person.accountId ?? null;
    if (accountId) {
      const [row] = await db
        .select({ kind: subscriptionUsage.kind, windows: subscriptionUsage.windows })
        .from(subscriptionUsage)
        .where(and(eq(subscriptionUsage.accountId, accountId), eq(subscriptionUsage.provider, provider)));
      usage = fiveHourUsage(row);
    }
  }
  return { provider, ready, models: providerModels(services, provider), gateway, usage };
}

/** A refused choice: `validation_failed` on `runtime`, in the words of the check (CR-S05). */
function refuse(text: string): never {
  throw new ApiError('validation_failed', text, { fields: { runtime: [text] } });
}

/** A provider as a sentence names it: Claude, ChatGPT, the model on your network. */
function providerInWords(provider: ChatProvider): string {
  return provider === 'local' ? 'the model on your network' : CHAT_PROVIDER_LABELS[provider];
}

/** The words when a started thread is asked for another provider (HN-06): it keeps its own; a new chat can have another. */
export function keepsProviderText(now: ChatProvider, asked: ChatProvider): string {
  return `This chat stays with ${providerInWords(now)}. To use ${providerInWords(asked)}, start a new chat.`;
}

/**
 * A thread that has a turn keeps its provider (hermes-native.md HN-06, HN-L01): Hermes keeps the provider with the
 * thread's session. The provider in effect now — the thread's choice, else the assistant's own — against the one asked
 * for (the choice, else the assistant's own); the same provider's model, effort and fast replies stay free. A thread
 * whose turns haven't started yet (only queued) still may (CR-02: the queued turn takes it). Throws `validation_failed`.
 */
async function keepsItsProvider(ctx: ApplyContext, thread: ChatThreadRef, asked: ChatRuntime | null) {
  const own = chatRuntimeOf(agentRuntimeOf(thread.agent.runtime));
  // No choice to make at all: `checkedChoice` says so.
  if (!own) return;
  const [stored] = await ctx.tx
    .select({ runtime: chatThreadRuntimes.runtime })
    .from(chatThreadRuntimes)
    .where(eq(chatThreadRuntimes.rootId, thread.rootId));
  const now = (stored?.runtime ?? own).provider;
  const next = (asked ?? own).provider;
  if (now === next) return;
  const [turn] = await ctx.tx
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.agentId, thread.agent.id),
        eq(dispatches.conversationId, thread.conversation.id),
        eq(dispatches.threadRootId, thread.rootId),
        inArray(dispatches.trigger, [...THREAD_CHOICE_TRIGGERS]),
        gt(dispatches.attempts, 0),
      ),
    )
    .limit(1);
  if (turn) refuse(keepsProviderText(now, next));
}

/** The words when the assistant itself doesn't run on Claude Code or Codex: no choice to make (CR-01). */
export function noChoiceText(agentName: string): string {
  return `${agentName} doesn’t answer with Claude or ChatGPT here.`;
}

/**
 * A choice as it would be stored for a thread with `agent` (CR-02, CR-04…CR-06): checked against what its provider
 * offers `person` now, and null when it is the assistant's own (or null was asked for). Throws `validation_failed`.
 */
export async function checkedChoice(
  services: Services,
  agent: PrincipalRow,
  person: PrincipalRow,
  choice: ChatRuntime | null,
): Promise<ChatRuntime | null> {
  if (!choice) return null;
  const own = chatRuntimeOf(agentRuntimeOf(agent.runtime));
  if (!own) refuse(noChoiceText(agent.name));
  const check = checkChoice(choice, await providerFacts(services, agent, person, choice.provider));
  if (!check.ok) refuse(check.problem);
  return chatRuntimeEquals(check.choice, own) ? null : check.choice;
}

/**
 * Stores a thread's choice in the caller's commit (CR-02): replaced, or removed for null; the turns of the thread still
 * queued take it at once (a running turn finishes as it started); signed and told to the person's devices
 * (`chat.thread_runtime`). Nothing happens when it doesn't change.
 */
export async function storeThreadChoice(
  ctx: ApplyContext,
  thread: ChatThreadRef,
  choice: ChatRuntime | null,
): Promise<ChatRuntime | null> {
  const { tx } = ctx;
  const [before] = await tx
    .select({ runtime: chatThreadRuntimes.runtime })
    .from(chatThreadRuntimes)
    .where(eq(chatThreadRuntimes.rootId, thread.rootId));
  if (chatRuntimeEquals(before?.runtime ?? null, choice)) return choice;
  if (choice)
    await tx
      .insert(chatThreadRuntimes)
      .values({
        rootId: thread.rootId,
        burrowId: ctx.burrow.id,
        conversationId: thread.conversation.id,
        runtime: choice,
        setById: ctx.actor.id,
        setAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: chatThreadRuntimes.rootId,
        set: { runtime: choice, setById: ctx.actor.id, setAt: ctx.now },
      });
  else await tx.delete(chatThreadRuntimes).where(eq(chatThreadRuntimes.rootId, thread.rootId));
  // The thread's next turn takes it, a queued one too (CR-02).
  await tx
    .update(dispatches)
    .set({ runtime: resolveThreadRuntime(agentRuntimeOf(thread.agent.runtime), choice) })
    .where(
      and(
        eq(dispatches.agentId, thread.agent.id),
        eq(dispatches.conversationId, thread.conversation.id),
        eq(dispatches.threadRootId, thread.rootId),
        eq(dispatches.state, 'queued'),
        inArray(dispatches.trigger, [...THREAD_CHOICE_TRIGGERS]),
      ),
    );
  await ctx.emit({
    type: 'chat.thread_runtime_set',
    kind: 'System',
    text: null,
    where: thread.agent.name,
    aboutId: thread.agent.id,
    payload: {
      conversationId: thread.conversation.id,
      rootId: thread.rootId,
      runtime: choice ? { ...choice } : null,
    },
  });
  ctx.publish(topics.me(ctx.actor.id), {
    type: 'chat.thread_runtime',
    conversationId: thread.conversation.id,
    rootId: thread.rootId,
    runtime: choice,
  });
  return choice;
}

/** The Chat's person, or a plain refusal. */
async function chatPerson(ctx: ApplyContext): Promise<PrincipalRow> {
  if (ctx.actor.kind !== 'person') throw forbidden('Only you choose what answers in your Chat.');
  const person = await loadPrincipalRow(ctx.tx, ctx.actor.id);
  if (!person) throw notFound('Person');
  return person;
}

/**
 * `chats.setThreadRuntime` (CT-461; CR-02): what answers in a thread of the caller's own Chat from its next turn; null
 * follows the assistant's own again. A thread that has a turn keeps its provider (HN-06).
 */
export const setChatThreadRuntime = defineCommand({
  name: 'set_chat_thread_runtime',
  schema: SetChatThreadRuntimeBody.extend({ rootId: MessageId }),
  async apply(tx, ctx, input) {
    const person = await chatPerson(ctx);
    const thread = await chatThreadOf(tx, ctx.burrow.id, person.id, input.rootId);
    if (!thread) throw notFound('Thread');
    await keepsItsProvider(ctx, thread, input.runtime);
    const choice = await checkedChoice(ctx.services, thread.agent, person, input.runtime);
    return { thread: await storeThreadChoice(ctx, thread, choice) };
  },
});

/**
 * `chats.runtime` (CT-461): what answers in the person's Chat — the agent's own runtime as a choice, a thread's choice
 * when one is asked for (`thread`), and both providers.
 */
export async function chatRuntimeView(
  services: Services,
  person: PrincipalRow,
  threadId: string | undefined,
): Promise<ChatRuntimeView> {
  const db = services.db;
  const agent = await loadAgentRow(db, person.burrowId);
  if (!agent) throw notFound('Agent');
  let thread: ChatRuntime | null | undefined;
  if (threadId) {
    const found = await chatThreadOf(db, person.burrowId, person.id, threadId);
    if (!found) throw notFound('Thread');
    thread = (await threadChoices(db, [found.rootId])).get(found.rootId) ?? null;
  }
  const providers = await Promise.all(
    CHAT_PROVIDERS.map(async (provider): Promise<ChatRuntimeProvider> => {
      const facts = await providerFacts(services, agent, person, provider);
      return {
        provider,
        ready: facts.ready,
        models: facts.models ? [...facts.models] : [],
        fastBlocked: facts.gateway ? 'gateway' : null,
        usage: facts.usage,
      };
    }),
  );
  return {
    assistantId: agent.id,
    assistantName: agent.name.slice(0, 80),
    default: chatRuntimeOf(agentRuntimeOf(agent.runtime)),
    ...(threadId ? { thread: thread ?? null } : {}),
    providers,
  };
}

/** A new Chat thread's choice, checked before its first message is posted (`firstMessageChoice`). */
export interface NewThreadChoice {
  conversation: ConversationRow;
  agent: PrincipalRow;
  choice: ChatRuntime | null;
}

/**
 * The choice that goes with a new thread's first message (CR-02; CR-S06): `chats.start`'s and `messages.send`'s
 * `runtime`, kept only for a person's top-level message in their own Chat, checked as `chats.setThreadRuntime` checks
 * it — before the message is posted, so a refusal sends nothing. Null when there is nothing to keep (no runtime, a reply,
 * another room, or a choice equal to the assistant's own).
 */
export async function firstMessageChoice(
  ctx: ApplyContext,
  conversation: ConversationRow,
  input: { runtime?: ChatRuntime | undefined; threadRootId?: string | null | undefined },
): Promise<NewThreadChoice | null> {
  if (!input.runtime || input.threadRootId || ctx.actor.kind !== 'person') return null;
  if (!isChatOf(conversation, ctx.actor.id)) return null;
  const agent = conversation.dmAgentId ? await loadPrincipalRow(ctx.tx, conversation.dmAgentId) : undefined;
  const person = await loadPrincipalRow(ctx.tx, ctx.actor.id);
  if (agent?.kind !== 'agent' || !person) return null;
  const choice = await checkedChoice(ctx.services, agent, person, input.runtime);
  return choice ? { conversation, agent, choice } : null;
}

/** Stores a new thread's checked choice in the commit that posted its first message, before its turn is queued. */
export async function storeFirstMessageChoice(
  ctx: ApplyContext,
  prepared: NewThreadChoice | null,
  rootId: string,
): Promise<void> {
  if (!prepared?.choice) return;
  await storeThreadChoice(
    ctx,
    { rootId, conversation: prepared.conversation, agent: prepared.agent },
    prepared.choice,
  );
}
