/**
 * A care plan when a server is added (docs/decisions/care-plan.md), the signed commands:
 *
 * - **`care.baseline`** (the watcher, as the agent): a Whombat from before care plans writes down the servers it has as
 *   known, once, so only servers added from now on get a plan.
 * - **`care.known`** (the watcher): a server that gets no plan (a temporary machine, nothing to look after, a second
 *   copy of the server this Whombat runs on) is written down as known.
 * - **`care.start`** (the watcher): a new server's first report: the assistant's line in the server's thread of the
 *   person's Chat (a new thread titled by the server the first time), quiet, and a `look` turn there that reads the
 *   server and proposes one plan from Whombat's defaults (`look_researches.care`); the plan's card, *Go ahead* and Done
 *   today are the look's (`looks/research.ts`). Once per server, and once for the server this Whombat runs on.
 *
 * Events carry ids only.
 */
import { careKey, careOpeningText, newId } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { burrows, type LookPlanStepRow, lookResearches, serverCares } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { ensurePersonalDm } from '../domain/personal-dm';
import { wakeQuietly } from '../domain/wake';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { forbidden, notFound } from '../lib/errors';
import { openingClientId, thingThread } from '../looks/research';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow } from '../read/principals';
import { setChangeWindow } from './window';

const ServerId = z.string().min(1).max(200);

/** A server's row key: the hosts service's id, in lower case. */
export const serverKey = (id: string) => id.toLowerCase();

export const careBaseline = defineCommand({
  name: 'care.baseline',
  schema: z.object({ servers: z.array(z.object({ id: ServerId, self: z.boolean() })).max(500) }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only Whombat writes down the servers it knows.');
    for (const s of input.servers)
      await tx
        .insert(serverCares)
        .values({
          burrowId: ctx.burrow.id,
          serverId: serverKey(s.id),
          state: 'known',
          self: s.self,
          createdAt: ctx.now,
        })
        .onConflictDoNothing();
    await tx.update(burrows).set({ careBaselineDue: false }).where(eq(burrows.id, ctx.burrow.id));
    await ctx.emit({
      type: 'care.baseline',
      kind: 'System',
      text: null,
      where: null,
      payload: { servers: input.servers.length },
    });
    return { known: input.servers.length };
  },
});

export const careKnown = defineCommand({
  name: 'care.known',
  schema: z.object({ server: ServerId, self: z.boolean() }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only Whombat writes down the servers it knows.');
    await tx
      .insert(serverCares)
      .values({
        burrowId: ctx.burrow.id,
        serverId: serverKey(input.server),
        state: 'known',
        self: input.self,
        createdAt: ctx.now,
      })
      .onConflictDoNothing();
    return { server: input.server };
  },
});

const CareStepRowSchema = z.custom<LookPlanStepRow>(
  (v) => typeof v === 'object' && v !== null && typeof (v as LookPlanStepRow).text === 'string',
);

export const startCare = defineCommand({
  name: 'care.start',
  // A new turn: a lapsed appliance refuses it up front (LC-10).
  licence: 'agentTurn',
  schema: z.object({
    server: z.object({ id: ServerId, name: z.string().min(1).max(120), self: z.boolean() }),
    /** The server's key as the desk and Home name it (`server:pve-01`). */
    thingKey: z.string().min(1).max(120),
    steps: z.array(CareStepRowSchema).min(1).max(6),
    personId: z.string().min(1).max(64),
  }),
  async apply(tx, ctx, input): Promise<{ researchId: string; dispatchId: string } | null> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant offers to look after a server.');
    const id = serverKey(input.server.id);
    const [known] = await tx
      .select()
      .from(serverCares)
      .where(and(eq(serverCares.burrowId, ctx.burrow.id), eq(serverCares.serverId, id)))
      .for('update');
    // Once per server.
    if (known) return null;
    // The server this Whombat runs on gets its plan once, whatever id it comes back with.
    if (input.server.self) {
      const [selfDone] = await tx
        .select({ id: serverCares.serverId })
        .from(serverCares)
        .where(
          and(
            eq(serverCares.burrowId, ctx.burrow.id),
            eq(serverCares.self, true),
            eq(serverCares.state, 'offered'),
          ),
        )
        .limit(1);
      if (selfDone) {
        await careKnown.apply(tx, ctx, { server: input.server.id, self: true });
        return null;
      }
    }
    const agent = await loadPrincipalRow(tx, ctx.actor.id);
    const person = await loadPrincipalRow(tx, input.personId);
    if (!agent || person?.kind !== 'person' || person.burrowId !== ctx.burrow.id || !person.accountId)
      return null;
    const chatId = await ensurePersonalDm(ctx, agent, person);
    const chat = await loadConversationRow(tx, chatId);
    if (!chat) return null;
    const researchId = newId('lookResearch');
    const name = input.server.name;
    const earlier = await thingThread(tx, ctx.burrow.id, input.thingKey, chat);
    const posted = await postMessage(ctx, {
      conversation: chat,
      text: careOpeningText(name),
      threadRootId: earlier,
      clientId: openingClientId(researchId),
      // The thread is the server's: its title is the server's name (CHT-05).
      subject: { kind: 'server', id: input.server.id.slice(0, 200), name: name.slice(0, 120) },
      // The plan's card tells the person, once (its push): the line itself is quiet.
      mentions: [],
      dispatch: false,
      notifyMentions: false,
      notifyDmPerson: false,
    });
    const threadRootId = earlier ?? posted.id;
    const woken = await wakeQuietly(ctx, {
      agentId: agent.id,
      conversationId: chat.id,
      threadRootId,
      person: person.accountId,
      trigger: 'look',
      coalesce: false,
      own: true,
      messageId: posted.id,
      background: true,
    });
    // Nobody to plan it for here: nothing is posted either (the commit rolls back).
    if (!woken) throw notFound('Chat');
    await tx.insert(lookResearches).values({
      id: researchId,
      burrowId: ctx.burrow.id,
      agentId: agent.id,
      personId: person.id,
      lookKey: careKey(input.thingKey),
      kind: 'server',
      name: name.slice(0, 120),
      checkId: null,
      subject: '',
      rank: 2,
      reason: null,
      question: null,
      since: null,
      lines: [],
      care: { new: true, steps: input.steps },
      state: 'looking',
      conversationId: chat.id,
      threadRootId,
      dispatchId: woken.dispatchId,
      startedAt: ctx.now,
      stateAt: ctx.now,
    });
    await tx.insert(serverCares).values({
      burrowId: ctx.burrow.id,
      serverId: id,
      state: 'offered',
      self: input.server.self,
      researchId,
      createdAt: ctx.now,
    });
    await ctx.emit({
      type: 'care.offered',
      kind: 'System',
      text: null,
      where: null,
      payload: { lookResearchId: researchId, conversationId: chat.id, dispatchId: woken.dispatchId },
    });
    publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['needsYou', 'things']);
    return { researchId, dispatchId: woken.dispatchId };
  },
});

export const CARE_COMMANDS = [careBaseline, careKnown, startCare, setChangeWindow];
