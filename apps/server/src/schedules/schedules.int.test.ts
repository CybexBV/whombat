/**
 * Agents schedule their own turns (docs/decisions/resourceful-agents.md RA-30, RA-DC12…RA-DC15; RA-DS34…RA-DS38):
 * the MCP `schedule` tool (create, list, cancel) for the person the turn is for, with a card in the room resolved per
 * viewer; the ticker (a fake clock) queuing `schedule` turns that carry `DispatchContext.schedule`, collapsing missed
 * runs, ending one-offs and expired ones (both keep the turn they queued last, RA-DS43;
 * a cancel or Remove takes a queued one with it); people's `schedules.*` (list, pause, resume, remove: the person it is
 * for only, one-agent.md OA-S13); and a reminder in a person's Chat.
 */
import { api, buildPath, SCHEDULES_ACTIVE_MAX } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentAuth } from '../auth/agent-tokens';
import { agentSchedules, dispatches, events, messages } from '../db/schema/index';
import { callTool } from '../mcp/server';
import { loadMessages } from '../read/messages';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent } from '../test/personal';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { schedulesFor } from './ticker';

const t = useTestServer({ seed: true, app: true });
const MIN = 60_000;
const accounts: Record<string, string> = {};

beforeAll(async () => {
  accounts[IDS.mara] = await accountOf(t.services, IDS.mara);
});

type Out = Record<string, unknown> & {
  status?: string;
  schedule?: Record<string, unknown> & { id: string };
  schedules?: { id: string }[];
  others?: number;
  problems?: string[];
  message?: string;
  error?: { code: string; message: string };
};

/** A turn of `agentId` in `conversationId` for `forId` (null: nobody), and the `schedule` tool in it. */
async function turn(agentId: string, conversationId: string, forId: string | null, threadRootId?: string) {
  const { dispatchId } = await agentTokenFor(t.services, t.burrowId, agentId, conversationId, {
    onBehalfOfAccountId: forId ? accounts[forId] : null,
    threadRootId: threadRootId ?? null,
  });
  const auth: AgentAuth = { dispatchId, agentId, burrowId: t.burrowId };
  return {
    dispatchId,
    schedule: async (args: Record<string, unknown>) =>
      (await callTool(t.services, auth, 'schedule', args)).structuredContent as Out,
  };
}

async function scheduleRow(id: string) {
  const [row] = await t.services.db.select().from(agentSchedules).where(eq(agentSchedules.id, id));
  if (!row) throw new Error('no schedule');
  return row;
}

/** The turns a schedule queued. */
const turnsOf = (scheduleId: string) =>
  t.services.db.select().from(dispatches).where(eq(dispatches.scheduleId, scheduleId));

async function rest(who: string, method: 'GET' | 'POST' | 'DELETE', path: string) {
  const { cookie } = await sessionFor(t.services, who);
  const res = await t.api.inject({ method, url: `/api/v1${path}`, headers: { cookie } });
  return {
    status: res.statusCode,
    body: res.json() as Record<string, unknown> & { error?: { code: string } },
  };
}

const PROMPT = 'Check whether the staging deploy finished and tell Mara how it went.';

describe('the schedule tool (RA-30)', () => {
  let made = '';

  it('makes one for the person the turn is for, active at once, with a card in the room', async () => {
    const dusty = await turn(IDS.dusty, IDS.billing, IDS.mara);
    const res = await dusty.schedule({
      action: 'create',
      when: { kind: 'every', minutes: 30 },
      prompt: PROMPT,
    });
    expect(res).toMatchObject({
      status: 'ok',
      schedule: { status: 'active', description: 'Every 30 minutes', prompt: PROMPT, runs: 0 },
      others: 0,
    });
    made = res.schedule?.id as string;
    const row = await scheduleRow(made);
    expect(row).toMatchObject({
      agentId: IDS.dusty,
      conversationId: IDS.billing,
      threadRootId: null,
      forAccountId: accounts[IDS.mara],
      status: 'active',
      createdByDispatchId: dusty.dispatchId,
    });
    expect((row.nextAt?.getTime() ?? 0) - row.anchorAt.getTime()).toBe(30 * MIN);
    expect((row.endsAt?.getTime() ?? 0) - row.createdAt.getTime()).toBe(90 * 86_400_000);
    // The card: when, never the prompt, in its words; the schedule filled in for a reader (one-person.md OP-S79).
    const [card] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, row.messageId as string));
    expect(card).toMatchObject({
      authorId: IDS.dusty,
      text: 'I’ll come back to this every 30 minutes.',
      card: { kind: 'schedule', scheduleId: made },
    });
    const [forMara] = await loadMessages(t.services.db, [card as NonNullable<typeof card>], IDS.mara);
    expect(forMara?.card).toMatchObject({
      kind: 'schedule',
      schedule: { id: made, prompt: PROMPT, status: 'active' },
    });
    const [forNobody] = await loadMessages(t.services.db, [card as NonNullable<typeof card>], null);
    expect(forNobody?.card).toMatchObject({ kind: 'schedule', schedule: null });
    // Signed by the agent, without the prompt.
    const [signed] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'schedule.created'), eq(events.actorId, IDS.dusty)));
    expect(signed).toMatchObject({ kind: 'System', text: 'Scheduled a turn' });
    expect(JSON.stringify(signed?.payload)).not.toContain('staging deploy');
  });

  it('says what to fix, and that a turn for nobody can’t schedule', async () => {
    const dusty = await turn(IDS.dusty, IDS.billing, IDS.mara);
    const past = await dusty.schedule({
      action: 'create',
      when: { kind: 'at', at: new Date(Date.now() - MIN).toISOString() },
      prompt: 'Too late',
    });
    expect(past).toEqual({
      status: 'invalid',
      problems: ['That time has passed. Pick a time in the future.'],
    });
    const often = await dusty.schedule({
      action: 'create',
      when: { kind: 'cron', expr: '* * * * *', zone: 'Europe/Amsterdam' },
      prompt: 'Every minute',
    });
    expect(often).toEqual({ status: 'invalid', problems: ['It may run at most every 5 minutes.'] });
    const short = await dusty.schedule({
      action: 'create',
      when: { kind: 'every', minutes: 2 },
      prompt: 'x',
    });
    expect(short.error?.code).toBe('validation_failed');
    // An outsiders' turn isn't served the tool (outsiders-turns.md OT-03): it neither sees the person's schedules in the
    // room nor makes or cancels one.
    const mine = await dusty.schedule({
      action: 'create',
      when: { kind: 'every', minutes: 90 },
      prompt: 'Check the invoices',
    });
    expect(mine).toMatchObject({ status: 'ok' });
    const nobody = await turn(IDS.dusty, IDS.billing, null);
    const listed = await nobody.schedule({ action: 'list' });
    expect(listed).toMatchObject({ error: { code: 'forbidden' } });
    expect(JSON.stringify(listed)).not.toContain('Check the invoices');
    expect(
      await nobody.schedule({ action: 'create', when: { kind: 'every', minutes: 60 }, prompt: 'x' }),
    ).toMatchObject({ error: { code: 'forbidden' } });
    const id = (mine as { schedule?: { id?: string } }).schedule?.id ?? '';
    expect(await nobody.schedule({ action: 'cancel', scheduleId: id })).toMatchObject({
      error: { code: 'forbidden' },
    });
    expect(await dusty.schedule({ action: 'cancel', scheduleId: id })).toMatchObject({ status: 'ok' });
  });

  it('keeps at most 20 active for the agent', async () => {
    const active = async () =>
      (await t.services.db.select().from(agentSchedules).where(eq(agentSchedules.status, 'active'))).length;
    const mara = await turn(IDS.dusty, IDS.billing, IDS.mara);
    const mine: string[] = [];
    for (let i = await active(); i < SCHEDULES_ACTIVE_MAX; i++) {
      const res = await mara.schedule({
        action: 'create',
        when: { kind: 'every', minutes: 60 + i },
        prompt: `#${i}`,
      });
      expect(res.status).toBe('ok');
      mine.push(res.schedule?.id as string);
    }
    const over = await mara.schedule({
      action: 'create',
      when: { kind: 'every', minutes: 600 },
      prompt: 'x',
    });
    expect(over.status).toBe('invalid');
    expect(over.problems).toHaveLength(1);
    // Mara keeps one of these; the rest end, so the next tests have room.
    for (const id of mine.slice(1))
      await t.services.db
        .update(agentSchedules)
        .set({ status: 'ended', endedReason: 'cancelled', nextAt: null })
        .where(eq(agentSchedules.id, id));
  });
});

describe('people’s schedules.* (RA-30)', () => {
  it('lists the schedules for the person, ended ones of the last week too', async () => {
    const inDm = await (await turn(IDS.dusty, IDS.dmDusty, IDS.mara)).schedule({
      action: 'create',
      when: { kind: 'every', minutes: 120 },
      prompt: 'Mara’s private reminder',
    });
    const dmId = inDm.schedule?.id as string;
    const path = buildPath(api.schedules.list.path, { burrow: 'burrow-hq' });
    const mara = (await rest(IDS.mara, 'GET', path)).body.schedules as Record<string, unknown>[];
    expect(mara.find((s) => s.id === dmId)).toMatchObject({ prompt: 'Mara’s private reminder' });
    expect(mara.every((s) => !('forName' in s) && !('canChange' in s))).toBe(true);
    expect(mara.some((s) => s.status === 'ended')).toBe(true);
  });

  it('pauses, resumes and removes, for the person it is for only', async () => {
    const listed = (await rest(IDS.mara, 'GET', buildPath(api.schedules.list.path, { burrow: 'burrow-hq' })))
      .body.schedules as { id: string; status: string; prompt: string }[];
    // Not the one the ticker's tests below run.
    const id = listed.find((s) => s.status === 'active' && s.prompt !== PROMPT)?.id as string;
    const at = (action: 'pause' | 'resume' | 'remove') =>
      buildPath(api.schedules[action].path, { burrow: 'burrow-hq', scheduleId: id });
    const paused = await rest(IDS.mara, 'POST', at('pause'));
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ schedule: { id, status: 'paused', nextAt: null } });
    const resumed = await rest(IDS.mara, 'POST', at('resume'));
    expect(resumed.body).toMatchObject({ schedule: { id, status: 'active' } });
    expect((await scheduleRow(id)).nextAt).not.toBeNull();
    const removed = await rest(IDS.mara, 'DELETE', at('remove'));
    expect(removed.body).toMatchObject({ schedule: { id, status: 'ended', endedReason: 'cancelled' } });
    expect((await rest(IDS.mara, 'DELETE', at('remove'))).status).toBe(409);
    const signed = await t.services.db
      .select({ type: events.type, text: events.text })
      .from(events)
      .where(eq(events.type, 'schedule.paused'));
    expect(signed.map((e) => e.text)).toContain('Paused Dusty’s schedule');
  });
});

describe('the ticker (RA-30)', () => {
  it('queues the turn at its time, for its person, carrying the schedule; missed runs collapse', async () => {
    const [row] = await t.services.db
      .select()
      .from(agentSchedules)
      .where(and(eq(agentSchedules.agentId, IDS.dusty), eq(agentSchedules.prompt, PROMPT)));
    if (!row) throw new Error('no schedule');
    const first = new Date(row.anchorAt.getTime() + 30 * MIN + 1000);
    // Not due before its time.
    expect(await schedulesFor(t.services).tick(new Date(row.anchorAt.getTime() + 29 * MIN))).toBe(0);
    expect(await schedulesFor(t.services).tick(first)).toBeGreaterThanOrEqual(1);
    const turns = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.scheduleId, row.id), eq(dispatches.trigger, 'schedule')));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      agentId: IDS.dusty,
      conversationId: IDS.billing,
      threadRootId: null,
      onBehalfOfAccountId: accounts[IDS.mara],
      state: 'queued',
    });
    const after = await scheduleRow(row.id);
    expect(after).toMatchObject({ runs: 1, status: 'active' });
    expect(after.nextAt?.getTime()).toBe(row.anchorAt.getTime() + 60 * MIN);
    const context = await buildDispatchContext(t.services, turns[0] as NonNullable<(typeof turns)[0]>);
    expect(context.schedule).toEqual({
      id: row.id,
      prompt: PROMPT,
      when: { kind: 'every', minutes: 30 },
      runs: 1,
      nextAt: after.nextAt?.toISOString(),
    });
    // Five hours later: one turn, not nine; the next run after now.
    const later = new Date(row.anchorAt.getTime() + 5 * 60 * MIN + 1000);
    await schedulesFor(t.services).tick(later);
    const ran = async () =>
      (await t.services.db.select().from(dispatches).where(eq(dispatches.scheduleId, row.id))).length;
    expect(await ran()).toBe(2);
    const collapsed = await scheduleRow(row.id);
    expect(collapsed.runs).toBe(2);
    expect(collapsed.nextAt?.getTime()).toBe(row.anchorAt.getTime() + 5.5 * 60 * MIN);
    // A tick again at the same moment runs nothing twice.
    expect(await schedulesFor(t.services).tick(later)).toBe(0);
    expect(await ran()).toBe(2);
  });

  it('ends a one-off after it ran and a repeating one after its 90 days', async () => {
    const mara = await turn(IDS.dusty, IDS.billing, IDS.mara);
    const at = new Date(Date.now() + 10 * MIN);
    const once = await mara.schedule({
      action: 'create',
      when: { kind: 'at', at: at.toISOString() },
      prompt: 'Once',
    });
    const onceId = once.schedule?.id as string;
    await schedulesFor(t.services).tick(new Date(at.getTime() + 1000));
    expect(await scheduleRow(onceId)).toMatchObject({
      status: 'ended',
      endedReason: 'done',
      runs: 1,
      nextAt: null,
    });
    // Ending it doesn't take its run with it: the turn the tick queued stays queued, for its person (RA-DS43).
    expect(await turnsOf(onceId)).toMatchObject([
      {
        agentId: IDS.dusty,
        trigger: 'schedule',
        conversationId: IDS.billing,
        onBehalfOfAccountId: accounts[IDS.mara],
        state: 'queued',
        error: null,
      },
    ]);

    const daily = await mara.schedule({
      action: 'create',
      when: { kind: 'every', minutes: 1440 },
      prompt: 'Daily',
    });
    const dailyId = daily.schedule?.id as string;
    const ends = (await scheduleRow(dailyId)).endsAt as Date;
    await schedulesFor(t.services).tick(new Date(ends.getTime() + MIN));
    expect(await scheduleRow(dailyId)).toMatchObject({ status: 'ended', endedReason: 'expired', runs: 1 });
    // Its last run, queued as its 90 days ran out, runs too.
    expect(await turnsOf(dailyId)).toMatchObject([{ trigger: 'schedule', state: 'queued', error: null }]);
  });

  it('the agent’s cancel and a person’s Remove still take a queued run with them (RA-DS43)', async () => {
    const queuedRun = async (prompt: string) => {
      const made = await (await turn(IDS.dusty, IDS.billing, IDS.mara)).schedule({
        action: 'create',
        when: { kind: 'every', minutes: 45 },
        prompt,
      });
      const id = made.schedule?.id as string;
      const row = await scheduleRow(id);
      await schedulesFor(t.services).tick(new Date(row.anchorAt.getTime() + 45 * MIN + 1000));
      expect(await turnsOf(id)).toMatchObject([{ trigger: 'schedule', state: 'queued' }]);
      return id;
    };
    const stopped = [{ trigger: 'schedule', state: 'cancelled', error: 'schedule_stopped' }];

    const byAgent = await queuedRun('Check the queue');
    const cancelled = await (await turn(IDS.dusty, IDS.billing, IDS.mara)).schedule({
      action: 'cancel',
      scheduleId: byAgent,
    });
    expect(cancelled).toMatchObject({ status: 'ok', schedule: { id: byAgent, status: 'ended' } });
    expect(await scheduleRow(byAgent)).toMatchObject({ status: 'ended', endedReason: 'cancelled' });
    expect(await turnsOf(byAgent)).toMatchObject(stopped);

    const byPerson = await queuedRun('Check the backlog');
    const removed = await rest(
      IDS.mara,
      'DELETE',
      buildPath(api.schedules.remove.path, { burrow: 'burrow-hq', scheduleId: byPerson }),
    );
    expect(removed.body).toMatchObject({
      schedule: { id: byPerson, status: 'ended', endedReason: 'cancelled' },
    });
    expect(await turnsOf(byPerson)).toMatchObject(stopped);
  });
});

describe('renewing (RA-30)', () => {
  it('renews one of Mara’s that ran its 90 days', async () => {
    const [expired] = await t.services.db
      .select()
      .from(agentSchedules)
      .where(
        and(
          eq(agentSchedules.forAccountId, accounts[IDS.mara] as string),
          eq(agentSchedules.endedReason, 'expired'),
        ),
      );
    const res = await rest(
      IDS.mara,
      'POST',
      buildPath(api.schedules.resume.path, { burrow: 'burrow-hq', scheduleId: expired?.id as string }),
    );
    expect(res.body).toMatchObject({ schedule: { status: 'active', endedReason: null } });
    const renewed = await scheduleRow(expired?.id as string);
    expect((renewed.endsAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(89 * 86_400_000);
  });
});

describe('a reminder in a person’s Chat (RA-30, RA-04)', () => {
  it('schedules for them and wakes the agent for them at its time', async () => {
    const chat = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: null });
    const reminder = await (await turn(chat.agentId, chat.dmId, IDS.mara)).schedule({
      action: 'create',
      when: { kind: 'every', minutes: 60 },
      prompt: 'Remind Mara to call the accountant.',
    });
    expect(reminder.status).toBe('ok');
    const id = reminder.schedule?.id as string;
    const row = await scheduleRow(id);
    await schedulesFor(t.services).tick(new Date(row.anchorAt.getTime() + 61 * MIN));
    expect(await turnsOf(id)).toMatchObject([
      {
        agentId: IDS.dusty,
        trigger: 'schedule',
        conversationId: chat.dmId,
        onBehalfOfAccountId: accounts[IDS.mara],
      },
    ]);
    const path = buildPath(api.schedules.list.path, { burrow: 'burrow-hq' });
    const ids = async (who: string) =>
      ((await rest(who, 'GET', path)).body.schedules as { id: string }[]).map((s) => s.id);
    expect(await ids(IDS.mara)).toContain(id);
  });
});
