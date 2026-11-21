/**
 * The person's prompts through the commit pipeline (docs/decisions/prompts.md): keeping one, changing one, removing one,
 * bringing back the shipped ones, and using one on a T3 Code project. All the person's own, in Settings, in Chat, or by
 * the assistant's settings tools on their word (which run as them).
 */
import {
  ConversationId,
  MessageId,
  newId,
  PROMPTS_MAX,
  type Prompt,
  PromptAi,
  PromptId,
  promptLastRun,
  promptLine,
  promptTask,
  SavePromptBody,
  STARTER_PROMPTS,
  type StarterPrompt,
  starterPromptOf,
} from '@whombat/core';
import { and, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { chatRoomOf } from '../chats/rooms';
import { sendMessage } from '../commands/messages';
import { defineCommand } from '../commit/types';
import { councilConnection } from '../council/run';
import type { Db, Tx } from '../db/client';
import { type PromptRow, prompts } from '../db/schema/index';
import { briefAgent } from '../domain/agent-brief';
import { conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow } from '../read/messages';
import { promptBrief } from './brief';
import { ownView, promptList, starterView, withRun } from './view';

/** Settings, Chat and the assistant change prompts as the person; nobody else does. */
function personOnly(kind: string) {
  if (kind !== 'person') throw forbidden('Only you keep your prompts.');
}

/** What the apps show when a prompt can't go to a project because T3 Code isn't connected with Manage. */
export const T3_NOT_CONNECTED = 'Connect T3 Code with Manage at Connections to run a prompt on a repository.';

export async function promptRows(db: Db | Tx, burrowId: string): Promise<PromptRow[]> {
  return db.select().from(prompts).where(eq(prompts.burrowId, burrowId));
}

export async function listPrompts(db: Db | Tx, burrowId: string): Promise<Prompt[]> {
  return promptList(await promptRows(db, burrowId));
}

type Found =
  | { kind: 'starter'; starter: StarterPrompt; row: PromptRow | null; prompt: Prompt }
  | { kind: 'own'; row: PromptRow; prompt: Prompt };

/** A prompt by its id as the list shows it; a shipped one the person removed is not found. */
async function findPrompt(tx: Tx, burrowId: string, id: string): Promise<Found> {
  const starter = starterPromptOf(id);
  if (starter) {
    const [row] = await tx
      .select()
      .from(prompts)
      .where(and(eq(prompts.burrowId, burrowId), eq(prompts.starterKey, starter.key)));
    if (row?.hidden) throw notFound('Prompt');
    return { kind: 'starter', starter, row: row ?? null, prompt: starterView(starter, row ?? null) };
  }
  const [row] = await tx
    .select()
    .from(prompts)
    .where(and(eq(prompts.burrowId, burrowId), eq(prompts.id, id)));
  if (!row || row.starterKey) throw notFound('Prompt');
  return { kind: 'own', row, prompt: ownView(row) };
}

/** A shipped prompt's row, made when the person first touches it. */
async function starterRow(tx: Tx, burrowId: string, starter: StarterPrompt, now: Date): Promise<PromptRow> {
  const [row] = await tx
    .insert(prompts)
    .values({
      id: newId('prompt'),
      burrowId,
      starterKey: starter.key,
      onRepository: starter.onRepository,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [kept] = await tx
    .select()
    .from(prompts)
    .where(and(eq(prompts.burrowId, burrowId), eq(prompts.starterKey, starter.key)));
  if (!kept) throw new Error('prompt row not kept');
  return kept;
}

/** The merge switch as saved: only on a prompt for a repository, and kept as it was when an older app leaves it out. */
function mergeOf(input: Pick<SavePromptBody, 'onRepository' | 'merge'>, was: boolean): boolean {
  return input.onRepository && (input.merge ?? was);
}

export const createPrompt = defineCommand({
  name: 'prompts.create',
  schema: SavePromptBody,
  async apply(tx, ctx, input): Promise<Prompt> {
    personOnly(ctx.actor.kind);
    if ((await listPrompts(tx, ctx.burrow.id)).length >= PROMPTS_MAX)
      throw conflict(`You keep ${PROMPTS_MAX} prompts at most: remove one first.`);
    const [last] = await tx
      .select({ position: max(prompts.position) })
      .from(prompts)
      .where(eq(prompts.burrowId, ctx.burrow.id));
    const [row] = await tx
      .insert(prompts)
      .values({
        id: newId('prompt'),
        burrowId: ctx.burrow.id,
        title: input.title,
        text: input.text,
        onRepository: input.onRepository,
        ownIt: input.ownIt,
        merge: input.onRepository && input.merge === true,
        ai: input.ai,
        position: (last?.position ?? -1) + 1,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning();
    if (!row) throw new Error('prompt not kept');
    return ownView(row);
  },
});

export const savePrompt = defineCommand({
  name: 'prompts.save',
  schema: SavePromptBody.extend({ promptId: PromptId }),
  async apply(tx, ctx, input): Promise<Prompt> {
    personOnly(ctx.actor.kind);
    const found = await findPrompt(tx, ctx.burrow.id, input.promptId);
    if (found.kind === 'own') {
      const [row] = await tx
        .update(prompts)
        .set({
          title: input.title,
          text: input.text,
          onRepository: input.onRepository,
          ownIt: input.ownIt,
          merge: mergeOf(input, found.row.merge),
          ai: input.ai,
          updatedAt: ctx.now,
        })
        .where(eq(prompts.id, found.row.id))
        .returning();
      if (!row) throw notFound('Prompt');
      return ownView(row);
    }
    // Words left as shipped stay null, so they keep following what Whombat ships.
    const { starter } = found;
    const row = found.row ?? (await starterRow(tx, ctx.burrow.id, starter, ctx.now));
    const [saved] = await tx
      .update(prompts)
      .set({
        title: input.title === starter.title ? null : input.title,
        text: input.text === starter.text.trim() ? null : input.text,
        onRepository: input.onRepository,
        ownIt: input.ownIt,
        merge: mergeOf(input, row.merge),
        ai: input.ai,
        updatedAt: ctx.now,
      })
      .where(eq(prompts.id, row.id))
      .returning();
    if (!saved) throw notFound('Prompt');
    return starterView(starter, saved);
  },
});

export const removePrompt = defineCommand({
  name: 'prompts.remove',
  schema: z.object({ promptId: PromptId }),
  async apply(tx, ctx, input): Promise<Prompt[]> {
    personOnly(ctx.actor.kind);
    const found = await findPrompt(tx, ctx.burrow.id, input.promptId);
    if (found.kind === 'own') await tx.delete(prompts).where(eq(prompts.id, found.row.id));
    else {
      // A shipped prompt stays away until the shipped ones are brought back; its runs stay with it.
      const row = found.row ?? (await starterRow(tx, ctx.burrow.id, found.starter, ctx.now));
      await tx.update(prompts).set({ hidden: true, updatedAt: ctx.now }).where(eq(prompts.id, row.id));
    }
    return listPrompts(tx, ctx.burrow.id);
  },
});

export const restorePrompts = defineCommand({
  name: 'prompts.restore',
  schema: z.object({}),
  async apply(tx, ctx): Promise<Prompt[]> {
    personOnly(ctx.actor.kind);
    // Each shipped prompt as shipped again: its words, settings and place in the list; where it ran stays.
    for (const starter of STARTER_PROMPTS)
      await tx
        .update(prompts)
        .set({
          title: null,
          text: null,
          onRepository: starter.onRepository,
          ownIt: false,
          merge: false,
          ai: null,
          hidden: false,
          updatedAt: ctx.now,
        })
        .where(and(eq(prompts.burrowId, ctx.burrow.id), eq(prompts.starterKey, starter.key)));
    return listPrompts(tx, ctx.burrow.id);
  },
});

/** The AI the thread runs on, as the route found it against what T3 Code runs now. */
const LaunchAi = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('default') }),
  z.object({
    kind: z.literal('chosen'),
    modelSelection: z.object({
      instanceId: z.string().min(1),
      model: z.string().min(1),
      options: z.array(z.unknown()),
    }),
  }),
  z.object({ kind: z.literal('unavailable'), ai: PromptAi }),
]);

export const usePrompt = defineCommand({
  name: 'prompts.use',
  schema: z.object({
    promptId: PromptId,
    conversationId: ConversationId,
    rootId: MessageId.optional(),
    project: z.object({ id: z.string().min(1).max(200), title: z.string().trim().min(1).max(200) }),
    ai: LaunchAi.default({ kind: 'default' }),
  }),
  async apply(tx, ctx, input): Promise<{ messageId: string; rootId: string }> {
    personOnly(ctx.actor.kind);
    const found = await findPrompt(tx, ctx.burrow.id, input.promptId);
    const { prompt } = found;
    if (!prompt.onRepository)
      throw conflict('This prompt isn’t for a repository: its words go into your message instead.');
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (
      !conversation ||
      conversation.burrowId !== ctx.burrow.id ||
      chatRoomOf(conversation) !== 'chat' ||
      conversation.dmPersonId !== ctx.actor.id ||
      !conversation.dmAgentId
    )
      throw notFound('Chat');
    const connection = await councilConnection(tx, ctx.burrow.id);
    if (!connection) throw conflict(T3_NOT_CONNECTED);
    // When it last ran here, read before this run is recorded: the thread can start from what changed since.
    const task = promptTask(prompt, promptLastRun(prompt, input.project.id));
    // The person's own message, as if they had typed it: the thread, unread state and the agent's turn as for any other.
    const posted = await sendMessage.apply(tx, ctx, {
      conversationId: conversation.id,
      text: promptLine(prompt.title, input.project.title),
      ...(input.rootId ? { threadRootId: input.rootId } : {}),
    });
    await briefAgent(ctx, {
      messageId: posted.id,
      agentId: conversation.dmAgentId,
      brief: promptBrief({
        person: ctx.actor.shortName,
        title: prompt.title,
        project: input.project,
        handle: connection.handle,
        task,
        ai: input.ai,
        merge: prompt.merge,
      }),
    });
    const run = { projectId: input.project.id, title: input.project.title, at: ctx.at };
    const row =
      found.kind === 'own'
        ? found.row
        : (found.row ?? (await starterRow(tx, ctx.burrow.id, found.starter, ctx.now)));
    await tx
      .update(prompts)
      .set({ runs: withRun(row.runs, run) })
      .where(eq(prompts.id, row.id));
    const message = await loadMessageRow(tx, posted.id);
    return { messageId: posted.id, rootId: message?.threadRootId ?? posted.id };
  },
});

export const PROMPT_COMMANDS = [createPrompt, savePrompt, removePrompt, restorePrompts, usePrompt];
