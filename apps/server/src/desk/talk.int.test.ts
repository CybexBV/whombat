/**
 * Talk's way through Chat against Postgres (desk-display-talk.md DK-T04…DK-T06): a desk question is the person's own
 * message in their Chat through the commit pipeline — a new thread, a follow-up a reply in it — marked for the turn it
 * wakes, and the assistant's reply in that thread, as the bus carries it, is what the screen shows and says.
 */
import { DispatchContext, newId } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMessage } from '../commands/messages';
import { activities, dispatches, messages } from '../db/schema/index';
import { endFollowedTask, followTask } from '../hosts/followed';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { FAKE_TRANSCRIPT, fakeRecording } from '../voice/testing/fake-voice';
import { createDeskTalk, type DeskTalks, type DeskTalkTimers, deskClientId, deskTurnOf } from './talk';

const t = useTestServer({ seed: true, env: { WHOMBAT_VOICE: 'fake' } });
let mine: PersonalSetup;
let talks: DeskTalks;
let unlocked = true;
/** Every push the server would send (the managed hook is the first thing notify calls). */
const pushes: string[][] = [];

beforeAll(async () => {
  mine = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: null });
  t.services.push.control = async (to) => {
    pushes.push([...to]);
  };
  talks = createDeskTalk(
    t.services,
    {
      place: () => ({ burrowId: t.burrowId, personId: IDS.mara }),
      unlocked: () => unlocked,
      voiceOn: () => true,
      deskServerByName: () => null,
    },
    { timings: { settleMs: 20, replyMs: 10_000 } },
  );
});

afterAll(() => talks.close());

/** No runner here: the turns a case queued end before the next. */
beforeEach(async () => {
  await t.services.db
    .update(dispatches)
    .set({ state: 'cancelled', finishedAt: new Date() })
    .where(inArray(dispatches.state, ['queued', 'claimed', 'running']));
});

/** The person's message a desk talk posted, once it is there. */
async function postedFor(id: string, spoken: boolean) {
  const clientId = deskClientId(id, spoken);
  return vi.waitFor(
    async () => {
      const [m] = await t.services.db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, mine.dmId), eq(messages.clientId, clientId)));
      if (!m) throw new Error('not posted yet');
      return m;
    },
    { interval: 10, timeout: 5000 },
  );
}

/** The assistant answers in the thread, as its turn would. */
async function assistantSays(threadRootId: string, text: string) {
  const res = await t.commit(mine.agentId, sendMessage, { conversationId: mine.dmId, text, threadRootId });
  if (res.status !== 'ok') throw new Error(res.status);
}

async function answered(id: string) {
  return vi.waitFor(
    () => {
      const talk = talks.get(id);
      if (talk?.state !== 'answered') throw new Error(`still ${talk?.state}`);
      return talk;
    },
    { interval: 10, timeout: 5000 },
  );
}

describe('a desk question in Chat (DK-T04, DK-T05, DK-T13)', () => {
  beforeEach(() => {
    unlocked = true;
    pushes.length = 0;
  });

  it('opens a thread as the person, marks its turn, and the reply there is the answer', async () => {
    const { id } = await talks.start({ text: 'Is pve-02 okay?', continue: false });
    const root = await postedFor(id, false);
    expect(root).toMatchObject({ authorId: IDS.mara, threadRootId: null, text: 'Is pve-02 okay?' });
    // Its turn is queued after the commit (the pipeline's after hooks).
    const turn = await vi.waitFor(
      async () => {
        const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.messageId, root.id));
        if (!row) throw new Error('not queued yet');
        return row;
      },
      { interval: 10, timeout: 5000 },
    );
    expect(turn).toMatchObject({ agentId: mine.agentId, threadRootId: root.id });
    expect(deskTurnOf(turn, root)).toEqual({ spoken: false });
    // The runner gets it: the context as the claim's contract parses it carries `desk` (CT-527).
    expect(DispatchContext.parse(await buildDispatchContext(t.services, turn)).desk).toEqual({
      spoken: false,
    });
    expect(talks.get(id)?.state).toBe('thinking');

    await assistantSays(root.id, 'pve-02 is **fine**, up 41 days.');
    const talk = await answered(id);
    expect(talk).toMatchObject({
      question: 'Is pve-02 okay?',
      answer: 'pve-02 is fine, up 41 days.',
      audio: true,
    });
    expect(talks.audio(id)?.toString('latin1', 0, 4)).toBe('RIFF');
    // Mara reads it on the unlocked screen: no push to her phone (DK-T13).
    await t.services.background.settle();
    expect(pushes.filter((to) => to.includes(IDS.mara))).toEqual([]);
  });

  it('continues the open conversation, and a question not asked to go on starts its own', async () => {
    const first = await talks.start({ text: 'How warm is the attic?', continue: false });
    const root = await postedFor(first.id, false);
    await assistantSays(root.id, 'It’s 31 degrees up there.');
    await answered(first.id);

    const next = await talks.start({ text: 'And the cellar?', continue: true });
    const reply = await postedFor(next.id, false);
    expect(reply).toMatchObject({ authorId: IDS.mara, threadRootId: root.id });
    await assistantSays(root.id, 'The cellar is at 14 degrees.');
    expect((await answered(next.id)).answer).toBe('The cellar is at 14 degrees.');

    const spoken = await talks.start({ audioWav: fakeRecording(1.2), continue: false });
    const asked = await postedFor(spoken.id, true);
    expect(asked).toMatchObject({ threadRootId: null, text: FAKE_TRANSCRIPT });
    await assistantSays(asked.id, 'Yes, pve-02 is fine.');
    expect(await answered(spoken.id)).toMatchObject({
      question: FAKE_TRANSCRIPT,
      answer: 'Yes, pve-02 is fine.',
    });

    // Locked again, the usual rules: the assistant's next word in the thread reaches her phone.
    unlocked = false;
    await assistantSays(asked.id, 'And it’s been up for 41 days.');
    await t.services.background.settle();
    expect(pushes.filter((to) => to.includes(IDS.mara))).toHaveLength(1);
  });
});

/** Timers the test moves by hand (Talk's 90 s without sleeping). */
function manualTimers() {
  let now = Date.now();
  let due: { at: number; fn: () => void }[] = [];
  const timers: DeskTalkTimers & { advance(ms: number): void } = {
    now: () => now,
    after(ms, fn) {
      const entry = { at: now + ms, fn };
      due.push(entry);
      return () => {
        due = due.filter((e) => e !== entry);
      };
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = due.filter((e) => e.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        due = due.filter((e) => e !== next);
        now = next.at;
        next.fn();
      }
      now = end;
    },
  };
  return timers;
}

describe('work in the open conversation (task-feedback.md TF-16, TF-17, TF-18)', () => {
  it('is working after 90 s and answered when the turn says it; the session shows the turn and its task card', async () => {
    const timers = manualTimers();
    let uses = 0;
    const desk = createDeskTalk(
      t.services,
      {
        place: () => ({ burrowId: t.burrowId, personId: IDS.mara }),
        unlocked: () => true,
        voiceOn: () => false,
        deskServerByName: () => null,
        used: () => {
          uses++;
        },
      },
      { timings: { settleMs: 20 }, timers },
    );
    try {
      const { id } = await desk.start({ text: 'Update Home Assistant', continue: false });
      const root = await postedFor(id, false);
      const turn = await vi.waitFor(
        async () => {
          const [row] = await t.services.db
            .select()
            .from(dispatches)
            .where(eq(dispatches.messageId, root.id));
          if (!row) throw new Error('not queued yet');
          return row;
        },
        { interval: 10, timeout: 5000 },
      );
      // The question and its turn are in the database before the talk opens their conversation (it does once the
      // commit returns): wait for that. The 90 s below outlast the screen's cached read of it.
      await vi.waitFor(
        async () => {
          if (!(await desk.session()).open) throw new Error('not open yet');
        },
        { interval: 10, timeout: 5000 },
      );
      // The turn runs, doing something.
      const at = new Date();
      await t.services.db
        .update(dispatches)
        .set({ state: 'running', claimedAt: at })
        .where(eq(dispatches.id, turn.id));
      await t.services.db.insert(activities).values({
        id: newId('activity'),
        burrowId: t.burrowId,
        dispatchId: turn.id,
        agentId: mine.agentId,
        conversationId: mine.dmId,
        threadRootId: root.id,
        key: '1:call',
        attempt: 1,
        seq: 1,
        kind: 'whombat',
        tool: 'whombat.connection_call',
        status: 'running',
        title: 'Installing updates on Home Assistant',
        important: false,
        startedAt: at,
        updatedAt: at,
      });
      timers.advance(90_000);
      expect(desk.get(id)?.state).toBe('working');
      const working = await desk.session();
      expect(working.working).toEqual({
        since: at.toISOString(),
        doing: 'Installing updates on Home Assistant',
      });

      // A task card in the thread is a live row, and its change is read again at once (the bus).
      const followed = await t.commit(mine.agentId, followTask, {
        id: newId('followedTask'),
        serverId: 'home-assistant',
        taskId: 'pkg:1a2b',
        serverName: 'Home Assistant',
        conversationId: mine.dmId,
        threadRootId: root.id,
        personId: IDS.mara,
        approvalId: null,
        words: {
          what: 'Installing updates on Home Assistant',
          doing: 'Installing 23 updates on Home Assistant',
        },
        changeEnc: null,
      });
      if (followed.status !== 'ok') throw new Error(followed.status);
      await vi.waitFor(
        async () => expect((await desk.session()).messages.at(-1)?.task?.state).toBe('running'),
        { interval: 10, timeout: 5000 },
      );
      const before = uses;
      const ended = await t.commit(mine.agentId, endFollowedTask, {
        id: followed.result.id,
        state: 'ok',
        result: 'Home Assistant is up to date: 23 updates installed.',
        rebootRequired: false,
        installed: 23,
        endedAt: new Date().toISOString(),
      });
      expect(ended.status).toBe('ok');
      await vi.waitFor(
        async () => {
          const row = (await desk.session()).messages.find((m) => m.id === followed.result.messageId);
          expect(row?.task).toMatchObject({ state: 'ok', result: expect.stringContaining('23 updates') });
        },
        { interval: 10, timeout: 5000 },
      );
      // The card's change was the screen's use; the card isn't the talk's answer.
      expect(uses).toBeGreaterThan(before);
      expect(desk.get(id)?.state).toBe('working');

      // The assistant's own words, then its turn's end: the answer.
      await assistantSays(root.id, 'Done: Home Assistant is up to date.');
      await t.services.db
        .update(dispatches)
        .set({ state: 'done', finishedAt: new Date() })
        .where(eq(dispatches.id, turn.id));
      await vi.waitFor(
        () => {
          timers.advance(20);
          expect(desk.get(id)?.state).toBe('answered');
        },
        { interval: 10, timeout: 5000 },
      );
      expect(desk.get(id)?.answer).toBe('Done: Home Assistant is up to date.');
      expect(await desk.session()).not.toHaveProperty('working');
    } finally {
      desk.close();
    }
  });
});
