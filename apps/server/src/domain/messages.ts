/**
 * Posting a message (channel, branch room, DM, thread reply) inside a commit, plus what follows it:
 * mention parsing, thread counters, the signed `message.posted` event, realtime frames and the
 * post-commit hooks (search index, unread badges, dispatches, notifications).
 */
import {
  type ChatSubject,
  canonicalizeMentions,
  conversationLabel,
  type DispatchTrigger,
  type JobResult,
  MESSAGE_TOO_LONG,
  type MentionTarget,
  type MessageProvenance,
  messageTextFits,
  newId,
  resolveMentions,
  type StoredCard,
  topics,
} from '@whombat/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ranOnForPost } from '../chats/ran-on';
import { threadedRoom } from '../chats/rooms';
import { threadOpenedByMessage } from '../chats/settle';
import { moveThreadReadMark } from '../chats/unread';
import { settleAgentStatus } from '../commands/agent-status';
import { answerRun, runsAwaitingAnswer } from '../commands/run-answers';
import type { ApplyContext } from '../commit/types';
import { conversations, messages, principals } from '../db/schema/index';
import { badRequest, conflict, notFound } from '../lib/errors';
import { type ConversationRow, personUnreadCounts } from '../read/conversations';
import { loadMessageRow, loadMessages, type MessageRow } from '../read/messages';
import { currentDispatchScope } from '../runtime/dispatch-scope';
import type { Services } from '../services';
import { type DispatchRequest, enqueueInSession } from './dispatch';
import { linkOfConversation, linkOfMessage } from './links';
import { unlinkLocalPaths } from './local-links';
import { notifyForMessage } from './message-notify';
import { indexMessage } from './search-index';

export interface PostMessageArgs {
  conversation: ConversationRow;
  text: string;
  card?: StoredCard | null;
  threadRootId?: string | null;
  clientId?: string | null;
  attachmentIds?: string[];
  /** Quick replies; only an agent's message carries them (RM-05), a person's are dropped. */
  suggestions?: readonly string[];
  /** What a short reply left out, offered as “More detail”; only an agent's message carries it (concise-replies.md). */
  more?: string | null;
  /** The message asks a person something; only an agent's message carries it (agent-status.md AS-03). */
  asks?: boolean;
  /**
   * What the thread this message opens is about (docs/decisions/chat-channel.md CHT-05): stored on a top-level message
   * only, as `chats.start` gives it; a reply never carries one.
   */
  subject?: ChatSubject | null;
  /** Explicit id / time (seed and imports). */
  id?: string;
  createdAt?: Date;
  /** Explicit mentions; resolved from `@Name` in the text when omitted. */
  mentions?: string[];
  /** Summary for the signed event (null = hidden from the log, the default for chat). */
  eventText?: string | null;
  /** Wake mentioned agents (and the DM agent). Default true. */
  dispatch?: boolean;
  /**
   * Tell the DM's person about an agent's message there (inbox and push, `agent_update`). Default true; a guide's
   * step posted in answer to the person's own click is not news to them (assistant-guides.md AG-03).
   */
  notifyDmPerson?: boolean;
  /**
   * Tell nobody about it, also not as a thread reply (default true): the agent's progress under a council's or a
   * checklist's card, which shows in the thread as new without an inbox row or a push (docs/decisions/council.md).
   */
  notify?: boolean;
  /**
   * Notify the people it mentions (default true). A handoff's lane root doesn't: its person owner gets one needs-you
   * row with the brief instead (docs/decisions/archive/delegation.md DG-03).
   */
  notifyMentions?: boolean;
  dispatchTrigger?: DispatchTrigger;
  /**
   * The person the dispatches this message queues are for (CT-69), when it isn't its author (SUB-28): the wake-up
   * after an approved key request is for the person the agent was working for, not the approver. Absent: derived
   * from the author (`personBehind`).
   */
  onBehalfOfAccountId?: string | null;
  /** Where the text came from when it isn't simply the author's own (core `MessageProvenance`). */
  provenance?: MessageProvenance | null;
  /** The message hands a plan step to its agent owner (work-supervision WS-04): its dispatch is linked to the step. */
  planStep?: { planId: string; stepId: string; agentId: string };
  /** The message is the result of a job handed to T3 Code (`Message.jobResult`): its text is T3 Code's report. */
  jobResult?: JobResult | null;
}

export interface PostedMessage {
  id: string;
  /** Dispatch ids are filled in before the message's transaction commits. */
  dispatches: { dispatchId: string; agentId: string }[];
}

/**
 * Principals of a burrow a message can mention: its person rows and its agent (one-agent.md OA-07: a mention is a
 * name, nothing is routed by it). System principals (GitHub, automations, Whombat Feedback) are never mentioned:
 * `@Feedback` stays text (FB-F3-10).
 */
export async function mentionTargets(
  ctx: Pick<ApplyContext, 'tx'>,
  burrowId: string,
): Promise<MentionTarget[]> {
  const rows = await ctx.tx
    .select({
      id: principals.id,
      kind: principals.kind,
      name: principals.name,
      shortName: principals.shortName,
    })
    .from(principals)
    .where(and(eq(principals.burrowId, burrowId), inArray(principals.kind, ['person', 'agent'])));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === 'person' ? ('person' as const) : ('agent' as const),
    name: r.name,
    ...(r.shortName ? { shortName: r.shortName } : {}),
  }));
}

/**
 * Whether the actor's message would wake the agent (LC-10): it is the person's message in their chat with it, or it
 * mentions it. The same rule `postMessage` dispatches by.
 */
export async function wouldWakeAgent(
  ctx: ApplyContext,
  conv: Pick<ConversationRow, 'id' | 'kind' | 'dmAgentId' | 'dmPersonId'>,
  text: string,
): Promise<boolean> {
  if (conv.kind === 'dm' && conv.dmAgentId && ctx.actor.id === conv.dmPersonId) return true;
  const targets = await mentionTargets(ctx, ctx.burrow.id);
  const mentions = resolveMentions(text.trim(), targets).filter((m) => m !== ctx.actor.id);
  return targets.some((t) => t.kind === 'agent' && mentions.includes(t.id));
}

export async function postMessage(ctx: ApplyContext, args: PostMessageArgs): Promise<PostedMessage> {
  const { tx, actor, burrow } = ctx;
  const conv = args.conversation;
  // Every conversation of the burrow is the person's with the agent: the burrow is the only wall here.
  if (conv.burrowId !== burrow.id) throw notFound('Conversation');
  // A retired agent's DM stays readable but closed (essentials-people.md EP-05).
  // An agent's links to paths on its own machine lead nowhere for readers: kept as their words (messaging.md MS-L01).
  const typed = actor.kind === 'agent' ? unlinkLocalPaths(args.text.trim()) : args.text.trim();
  // Files alone are a message too (docs/decisions/bp-attachments.md).
  if (!typed && !args.card && !args.attachmentIds?.length) throw badRequest('Say something first.');
  // Within 48 000 characters and 48 KiB of JSON (contracts CT-151).
  if (!messageTextFits(typed)) throw badRequest(MESSAGE_TOO_LONG);

  let rootId: string | null = null;
  // The thread's root as read here, when the message names the root itself (it does unless it names a reply).
  let rootRow: MessageRow | undefined;
  if (args.threadRootId) {
    const named = await loadMessageRow(tx, args.threadRootId);
    if (!named || named.conversationId !== conv.id) throw notFound('Thread');
    rootId = named.threadRootId ?? named.id;
    if (rootId === named.id) rootRow = named;
  }

  if (args.clientId) {
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conv.id),
          eq(messages.authorId, actor.id),
          eq(messages.clientId, args.clientId),
        ),
      );
    if (existing) return { id: existing.id, dispatches: [] };
  }

  const createdAt = args.createdAt ?? ctx.now;
  const targets = await mentionTargets(ctx, burrow.id);
  // Stored canonical (docs/decisions/messaging.md MS-C02): `@dusty` becomes `@Dusty` before mentions, the event, search
  // and realtime see it, for people and agents alike; the same length, so it still fits.
  const text = canonicalizeMentions(typed, targets);
  const mentions = args.mentions ?? resolveMentions(text, targets).filter((m) => m !== actor.id);
  const id = args.id ?? newId('message');

  // What answered the assistant's reply in its person's Chat (chat-runtime.md CR-07, chat-runtime-server.md CR-S06).
  const ran = await ranOnForPost(ctx, conv, args.card);
  const scope = currentDispatchScope();

  await tx.insert(messages).values({
    id,
    burrowId: burrow.id,
    conversationId: conv.id,
    authorId: actor.id,
    createdAt,
    text,
    mentions,
    card: args.card ?? null,
    suggestions: actor.kind === 'agent' ? [...new Set(args.suggestions ?? [])] : [],
    more:
      actor.kind === 'agent' && args.more?.trim()
        ? { hint: unlinkLocalPaths(args.more.trim()), requestedById: null, requestedAt: null }
        : null,
    asks: actor.kind === 'agent' && (args.asks ?? false),
    attachmentIds: args.attachmentIds ?? [],
    threadRootId: rootId,
    clientId: args.clientId ?? null,
    provenance: args.provenance ?? null,
    jobResult: args.jobResult ?? null,
    // A thread's subject is on its first message only (CHT-05).
    ...(args.subject && !rootId
      ? { subjectKind: args.subject.kind, subjectId: args.subject.id, subjectName: args.subject.name }
      : {}),
    ...(ran ? { ranOn: ran.ranOn, dispatchId: ran.dispatchId } : {}),
    // A question needs its asking turn even outside Chat or without a model display label.
    ...(actor.kind === 'agent' && args.asks && scope?.agentId === actor.id && scope.dispatchId
      ? { dispatchId: scope.dispatchId }
      : {}),
  });

  // A settled thread this message is posted in opens again (docs/decisions/chat-settle.md): new words mean it isn't
  // finished, whoever wrote them. Its “kept open” mark goes too, so it may settle by itself again later.
  let reopened = false;
  if (rootId) {
    // Nothing in this commit changed the root since it was read above, under the burrow lock.
    const root = rootRow ?? (await loadMessageRow(tx, rootId));
    if (!root) throw conflict('Thread root disappeared.');
    const participants = [...root.threadParticipantIds.filter((p) => p !== actor.id), actor.id].slice(-3);
    reopened = root.settledAt !== null;
    await tx
      .update(messages)
      .set({
        replyCount: sql`${messages.replyCount} + 1`,
        lastReplyAt: createdAt,
        threadParticipantIds: participants,
        ...(root.settledAt || root.keptOpenAt ? { settledAt: null, settledHow: null, keptOpenAt: null } : {}),
      })
      .where(eq(messages.id, rootId));
  } else {
    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`greatest(coalesce(${conversations.lastMessageAt}, ${createdAt.toISOString()}::timestamptz), ${createdAt.toISOString()}::timestamptz)`,
      })
      .where(eq(conversations.id, conv.id));
  }

  const link = await linkOfMessage(tx, conv, id, rootId);
  const event = await ctx.emit({
    type: 'message.posted',
    kind: 'Messages',
    text: args.eventText ?? null,
    where: conversationLabel(conv),
    ref: link,
    createdAt: createdAt.toISOString(),
    payload: { messageId: id, conversationId: conv.id, threadRootId: rootId, mentions },
  });

  const rows = await tx
    .select()
    .from(messages)
    .where(rootId ? sql`${messages.id} in (${id}, ${rootId})` : eq(messages.id, id));
  const loaded = await loadMessages(tx, rows, null);
  for (const m of loaded) {
    ctx.publish(
      topics.conversation(conv.id),
      {
        type: m.id === id ? 'message.created' : 'message.updated',
        message: m,
      },
      { eventId: event.id },
    );
  }

  if (rootId && reopened) await threadOpenedByMessage(ctx, conv, rootId);

  // In the person's Chat and Feedback rooms, writing in a thread means they read it up to there
  // (docs/decisions/thread-unread.md).
  const threaded = threadedRoom(conv);
  if (threaded && actor.kind === 'person') {
    const [mine] = rows.filter((r) => r.id === id);
    if (mine) await moveThreadReadMark(tx, actor.id, rootId ?? id, mine.ord, ctx.now);
  }

  const posted: PostedMessage = { id, dispatches: [] };
  const services = ctx.services;
  const authorKind = actor.kind;
  const dispatchWanted = args.dispatch ?? true;
  const notifyMentions = args.notifyMentions ?? true;
  const trigger = args.dispatchTrigger;
  // A person's top-level message in a channel, or in their Chat or Feedback room in the assistant shell (CHT-02).
  const opensThread = authorKind === 'person' && !rootId && threadedRoom(conv);
  const behalf =
    args.onBehalfOfAccountId !== undefined ? { onBehalfOfAccountId: args.onBehalfOfAccountId } : {};

  ctx.after(async () => {
    await indexMessage(services.db, id);
    if (rootId) await indexMessage(services.db, rootId);
  });
  // Link previews are fetched after the commit, off the request's path (EC-17).
  ctx.after(async () => services.linkPreviews.schedule(id));
  // Badges and notifications don't hold the response (server-efficiency.md SV-02); a room's badges in order. In the
  // person's Chat and Feedback rooms a reply counts too, and their own message may have read a thread, so they hear it
  // on their other devices as well.
  if (!rootId || threaded)
    ctx.background(
      'unread badges',
      () => publishUnread(services, burrow.id, conv.id, threaded ? null : actor.id),
      unreadKey(conv.id),
    );
  if (authorKind === 'agent')
    ctx.after(async () => {
      services.typing.stop({ conversationId: conv.id, threadRootId: rootId, principalId: actor.id });
    });
  ctx.beforeCommit(async () => {
    if (!dispatchWanted) return;
    const requests: DispatchRequest[] = [];
    const agentIds = new Set(
      targets.filter((t) => t.kind === 'agent' && mentions.includes(t.id)).map((t) => t.id),
    );
    for (const agentId of agentIds) requests.push({ agentId, trigger: trigger ?? 'mention' });
    if (
      conv.kind === 'dm' &&
      conv.dmAgentId &&
      actor.id === conv.dmPersonId &&
      !agentIds.has(conv.dmAgentId)
    ) {
      requests.push({ agentId: conv.dmAgentId, trigger: trigger ?? 'dm' });
    }
    // A run that waits on this person here (resourceful-agents.md RA-DS62): their message — naming its agent or no
    // agent — answers it, and wakes its agent on the run (its checkout and tools) instead of in a chat turn. Not on a
    // lapsed licence, where only messages that wake nobody are posted (LC-10).
    const onRuns = new Set<string>();
    if (authorKind === 'person' && !trigger && !services.licence.lapsed) {
      const waiting = await runsAwaitingAnswer(tx, {
        burrowId: burrow.id,
        conversationId: conv.id,
        threadRootId: rootId,
        personId: actor.id,
      });
      for (const run of waiting) {
        // A message for other agents only is theirs.
        if (agentIds.size && !agentIds.has(run.agentId)) continue;
        const answered = await answerRun.apply(tx, ctx, { runId: run.id, messageId: id });
        if (!answered.answered) continue;
        onRuns.add(run.agentId);
        const woken = await enqueueInSession(ctx, {
          burrowId: burrow.id,
          causedById: actor.id,
          conversationId: conv.id,
          conversation: conv,
          messageId: id,
          threadRootId: rootId,
          requests: [
            { agentId: run.agentId, trigger: conv.dmAgentId === run.agentId ? 'dm' : 'mention', mode: 'run' },
          ],
          at: createdAt,
          runId: run.id,
          ...behalf,
        });
        posted.dispatches.push(...woken.map((q) => ({ dispatchId: q.dispatchId, agentId: q.agentId })));
      }
    }
    const queued = await enqueueInSession(ctx, {
      burrowId: burrow.id,
      causedById: actor.id,
      conversationId: conv.id,
      conversation: conv,
      messageId: id,
      // A person's top-level message in a channel (channel-threads.md CH-01) or their Chat (chat-channel.md CHT-02) is
      // answered in a thread under it.
      threadRootId: rootId ?? (opensThread ? id : null),
      requests: requests.filter((r) => !onRuns.has(r.agentId)),
      at: createdAt,
      ...behalf,
      ...(args.planStep ? { planStep: args.planStep } : {}),
    });
    posted.dispatches.push(...queued.map((q) => ({ dispatchId: q.dispatchId, agentId: q.agentId })));
  });
  if (authorKind === 'person') {
    // A person's message may answer the agent's question: a waiting agent settles its status (agent-status.md AS-03),
    // which reads again whether a question is still open.
    ctx.after(async () => {
      const waiting = await services.db
        .select({ id: principals.id })
        .from(principals)
        .where(
          and(
            eq(principals.burrowId, burrow.id),
            eq(principals.kind, 'agent'),
            eq(principals.status, 'waiting'),
          ),
        );
      for (const agent of waiting)
        await services.pipeline.commit(settleAgentStatus, {}, { burrowId: burrow.id, actorId: agent.id });
    });
  }
  // Who hears about it (essentials-people.md EP-11): the person, by their level here, mentions, thread replies and the
  // DM's agent updates.
  const burrowRef = { id: burrow.id, slug: burrow.slug };
  const notifyDmPerson = args.notifyDmPerson ?? true;
  if (args.notify !== false)
    ctx.background('message notifications', () =>
      notifyForMessage(services, { burrow: burrowRef, messageId: id, notifyMentions, notifyDmPerson }),
    );
  return posted;
}

/** The background key of a room's unread badges: computed one after another (SV-02). */
export function unreadKey(conversationId: string): string {
  return `unread:${conversationId}`;
}

/** Pushes the person's fresh unread / mention badge (their `me:` topic), unless they wrote the message. */
export async function publishUnread(
  services: Services,
  burrowId: string,
  conversationId: string,
  exceptId: string | null,
) {
  const counts = await personUnreadCounts(services.db, burrowId, conversationId, exceptId);
  const at = services.clock().toISOString();
  for (const [personId, c] of counts) {
    services.bus.publish({
      topic: topics.me(personId),
      event: {
        type: 'conversation.unread',
        conversationId,
        unread: c.unread,
        mentions: c.mentions,
      },
      eventId: null,
      at,
      outboxId: null,
    });
  }
}

export { linkOfConversation };
