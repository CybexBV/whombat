/**
 * Background jobs wake their agent (docs/decisions/resourceful-agents.md RA-31; one-person.md OP-S43): a job's
 * `whombat notify`, handed over by the runner, posts the job's words in the thread of the turn that started it, as the
 * agent under a pill, and queues a `notify` turn there for the person whose context carries them; an unknown, old or
 * outsiders' turn, the eleventh in an hour and an event handed over twice are not taken.
 */
import { NOTIFY_PER_HOUR_MAX, newId } from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { dispatches, messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { buildDispatchContext } from './context';
import { type JobNotify, notifyClientId, notifyContextOf, notifyOrigin, takeJobNotify } from './job-notify';

const t = useTestServer({ seed: true });

let seq = 0;
const event = (over: Partial<JobNotify> = {}): JobNotify => ({
  eventId: `c0ffee00-${++seq}`,
  fromDispatchId: 'dsp_none',
  text: 'docs built: 0 errors',
  ...over,
});

/** Mara asks Dusty in a thread of #billing: the turn a job is started from. */
async function origin(text = '@Dusty build the docs') {
  // Dusty's earlier turns are over (a queued one would take the new ask over).
  await t.services.db
    .update(dispatches)
    .set({ state: 'done' })
    .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.state, 'queued')));
  const root = await t.commit(IDS.mara, sendMessage, { conversationId: IDS.billing, text: 'Docs, anyone?' });
  if (root.status !== 'ok') throw new Error('no root');
  const asked = await t.commit(IDS.mara, sendMessage, {
    conversationId: IDS.billing,
    text,
    threadRootId: root.result.id,
  });
  if (asked.status !== 'ok') throw new Error('not asked');
  const [row] = await t.services.db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.messageId, asked.result.id)));
  if (!row) throw new Error('Dusty was not asked');
  // That turn ran and is over.
  await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, row.id));
  return { ...row, rootId: root.result.id };
}

/** Earlier notify turns out of the hour's count. */
const longAgo = () =>
  t.services.db
    .update(dispatches)
    .set({ createdAt: new Date(Date.now() - 2 * 60 * 60_000) })
    .where(eq(dispatches.trigger, 'notify'));

const notifyTurns = (conversationId: string) =>
  t.services.db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.conversationId, conversationId), eq(dispatches.trigger, 'notify')))
    .orderBy(asc(dispatches.createdAt));

describe('a background job wakes its agent (RA-31)', () => {
  it('posts the job’s words in the turn’s thread and wakes the agent there, for the same person', async () => {
    const from = await origin();
    const first = event({ fromDispatchId: from.id, text: '  docs built: 0 errors, ask @Dusty to review  ' });
    const out = await takeJobNotify(t.services, first);
    expect(out).toMatchObject({ outcome: 'woken', created: true });
    if (out?.outcome !== 'woken') throw new Error('not woken');
    const [post] = await t.services.db.select().from(messages).where(eq(messages.id, out.messageId));
    expect(post).toMatchObject({
      authorId: IDS.dusty,
      conversationId: IDS.billing,
      threadRootId: from.rootId,
      text: 'docs built: 0 errors, ask @Dusty to review',
      // Nobody is mentioned or woken by a job's words.
      mentions: [],
      card: { kind: 'pill', tone: 'neutral' },
    });
    expect(notifyOrigin(post?.clientId)).toBe(from.id);
    const turns = await notifyTurns(IDS.billing);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: out.dispatchId,
      agentId: IDS.dusty,
      state: 'queued',
      mode: 'reply',
      messageId: out.messageId,
      threadRootId: from.rootId,
      onBehalfOfAccountId: from.onBehalfOfAccountId,
    });
    expect(from.onBehalfOfAccountId).toBeTruthy();
    // The @Dusty in the job's words wakes nothing more: the notify turn is the only one on that post.
    const woken = await t.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.messageId, out.messageId));
    expect(woken.map((d) => d.id)).toEqual([out.dispatchId]);
    // The turn knows what woke it.
    const context = await buildDispatchContext(t.services, turns[0] as (typeof turns)[number]);
    expect(context.dispatch.trigger).toBe('notify');
    expect(context.notify).toEqual({
      text: 'docs built: 0 errors, ask @Dusty to review',
      fromDispatchId: from.id,
    });
    expect(context.trigger?.id).toBe(out.messageId);

    // The same event again (the runner didn't hear the answer): taken once.
    const again = await takeJobNotify(t.services, { ...first, text: 'docs built again' });
    expect(again).toEqual({ outcome: 'duplicate', messageId: out.messageId });
    // Another while that turn waits: posted, and the waiting turn takes it.
    const second = await takeJobNotify(t.services, event({ fromDispatchId: from.id, text: 'tests passed' }));
    expect(second).toMatchObject({ outcome: 'woken', created: false, dispatchId: out.dispatchId });
    expect(await notifyTurns(IDS.billing)).toHaveLength(1);
  });

  it('refuses an old turn, no turn, empty words and the eleventh in an hour', async () => {
    const from = await origin('@Dusty back up the invoices');
    const posts = async () =>
      (await t.services.db.select().from(messages).where(eq(messages.authorId, IDS.dusty))).length;
    const before = await posts();
    expect(await takeJobNotify(t.services, event({ fromDispatchId: 'dsp_nothere' }))).toEqual({
      outcome: 'refused',
      reason: 'unknown_turn',
    });
    expect(await takeJobNotify(t.services, event({ fromDispatchId: from.id, text: '   ' }))).toEqual({
      outcome: 'refused',
      reason: 'empty',
    });
    expect(await posts()).toBe(before);
    // A turn of 8 days ago.
    await t.services.db
      .update(dispatches)
      .set({ createdAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(dispatches.id, from.id));
    expect(await takeJobNotify(t.services, event({ fromDispatchId: from.id }))).toEqual({
      outcome: 'refused',
      reason: 'too_old',
    });
    // Ten notify turns in the last hour already.
    const fresh = await origin('@Dusty rebuild the index');
    const already = (await notifyTurns(IDS.billing)).length;
    await t.services.db.insert(dispatches).values(
      Array.from({ length: NOTIFY_PER_HOUR_MAX - already }, () => ({
        id: newId('dispatch'),
        burrowId: t.burrowId,
        agentId: IDS.dusty,
        trigger: 'notify' as const,
        conversationId: IDS.general,
        state: 'done' as const,
        createdAt: new Date(),
      })),
    );
    expect(await takeJobNotify(t.services, event({ fromDispatchId: fresh.id }))).toEqual({
      outcome: 'refused',
      reason: 'too_many',
    });
  });

  it('posts nothing for a job of an outsiders’ turn (OP-17)', async () => {
    await longAgo();
    const from = await origin('@Dusty import the archive');
    await t.services.db
      .update(dispatches)
      .set({ onBehalfOfAccountId: null })
      .where(eq(dispatches.id, from.id));
    const e = event({ fromDispatchId: from.id });
    expect(await takeJobNotify(t.services, e)).toEqual({ outcome: 'refused', reason: 'outside' });
    const posted = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.clientId, notifyClientId(from.id, e.eventId)));
    expect(posted).toEqual([]);
  });

  it('reads the context only from a notify turn’s own post', () => {
    const clientId = notifyClientId('dsp_abc', 'c0ffee00-1');
    expect(clientId).toMatch(/^notify:dsp_abc:[0-9a-f]{12}$/);
    expect(clientId.length).toBeLessThanOrEqual(64);
    expect(notifyContextOf({ trigger: 'notify' }, { text: 'done', clientId })).toEqual({
      text: 'done',
      fromDispatchId: 'dsp_abc',
    });
    expect(notifyContextOf({ trigger: 'mention' }, { text: 'done', clientId })).toBeNull();
    expect(notifyContextOf({ trigger: 'notify' }, { text: 'done', clientId: 'c-1' })).toBeNull();
    expect(notifyContextOf({ trigger: 'notify' }, null)).toBeNull();
    // At most 2 000 UTF-16 units, never half a character.
    const long = notifyContextOf({ trigger: 'notify' }, { text: '😀'.repeat(1500), clientId });
    expect(long?.text).toHaveLength(2000);
  });
});
