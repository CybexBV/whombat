/**
 * A Chat thread's Hermes session (hermes-engine.md HE-18, HE-40, HE-S116…HE-S119), against Postgres: which session a
 * turn resumes (the thread's, the same person's, never after it failed), what a resumed session is sent (only what is
 * new since its last turn), and how a deleted thread, an edited message and Clear chats forget the sessions and have the
 * runner delete them from the person's Hermes profile (the runner's Hermes-home service in this process, the scripted
 * Hermes answering `hermes sessions delete`).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesPersonProfile } from '@whombat/agent-runtime';
import { scriptedHermesLauncher } from '@whombat/agent-runtime/testing/hermes';
import { type DispatchContext, runnerApi } from '@whombat/core';
import { HermesHomeService } from '@whombat/runner';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { clearChat } from '../chats/clear';
import { deleteMessage, editMessage } from '../commands/message-edits';
import { sendMessage } from '../commands/messages';
import { dispatches, hermesSessionDrops } from '../db/schema/index';
import { hermesHomeRestored, hermesHousekeeping, kickHermesHousekeeping } from '../hermes-home/housekeeping';
import { PRUNE_EVERY_MS } from '../hermes-home/prune';
import { useHermesHome } from '../hermes-home/service';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { waitFor } from '../test/runner';

const t = useTestServer({ seed: true, app: true });
const RUNNER = { authorization: 'Bearer dev-runner-token' };
let root = '';
let home: HermesHomeService;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-sessions-'));
  // Private, as the runner makes it: the service refuses a home others can read, whatever the umask.
  root = join(dir, 'root');
  mkdirSync(root, { mode: 0o700 });
  home = new HermesHomeService({ root, bin: await scriptedHermesLauncher(dir) });
  useHermesHome(t.services, home);
});

async function claim(): Promise<DispatchContext> {
  const res = await t.api.inject({
    method: 'POST',
    url: runnerApi.claim.path.replace(/^/, '/internal/runner'),
    headers: RUNNER,
    payload: { runnerId: 'rnr_sessions', providers: ['claude'], waitMs: 2000 },
  });
  expect(res.statusCode).toBe(200);
  const dispatch = runnerApi.claim.response.parse(res.json()).dispatch;
  if (!dispatch) throw new Error('nothing to claim');
  return dispatch;
}

async function beat(ctx: DispatchContext, providerSessionId: string) {
  const res = await t.api.inject({
    method: 'POST',
    url: `/internal/runner/dispatches/${ctx.dispatch.id}/progress`,
    headers: RUNNER,
    payload: {
      runnerId: 'rnr_sessions',
      attempt: ctx.dispatch.attempts,
      state: 'running',
      providerSessionId,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function complete(
  ctx: DispatchContext,
  body: { outcome: 'done' | 'failed'; providerSessionId?: string; error?: string },
) {
  const res = await t.api.inject({
    method: 'POST',
    url: `/internal/runner/dispatches/${ctx.dispatch.id}/complete`,
    headers: RUNNER,
    payload: { runnerId: 'rnr_sessions', attempt: ctx.dispatch.attempts, ...body },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function say(actor: string, conversationId: string, text: string, threadRootId?: string) {
  const res = await t.commit(actor, sendMessage, {
    conversationId,
    text,
    ...(threadRootId ? { threadRootId } : {}),
  });
  if (res.status !== 'ok') throw new Error('send failed');
  return res.result.id as string;
}

/** A session file as the scripted Hermes keeps it, in the person's profile. */
function hermesSession(id: string): string {
  const dir = join(hermesPersonProfile(root), 'scripted-hermes', 'sessions');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, cwd: '/', history: [] }));
  return path;
}

const shown = (ctx: DispatchContext) => [
  ...ctx.window.map((m) => m.text),
  ...(ctx.thread ? [ctx.thread.root.text, ...ctx.thread.replies.map((m) => m.text)] : []),
];

describe('a Chat thread’s Hermes session', () => {
  it('a thread’s next turn resumes its session with only what is new; a failed resume starts fresh', async () => {
    const root = await say(IDS.mara, IDS.dmDusty, 'Can you check the backups tonight?');
    const first = await claim();
    expect(first.dispatch.threadRootId).toBe(root);
    expect(first.dispatch.providerSessionId).toBeNull();
    expect(first.session).toMatchObject({ resumed: false });
    expect(shown(first)).toContain('Can you check the backups tonight?');
    await complete(first, { outcome: 'done', providerSessionId: 'hermes:local-backups' });

    await say(IDS.mara, IDS.dmDusty, 'And the photos share too.', root);
    const second = await claim();
    expect(second.dispatch.providerSessionId).toBe('hermes:local-backups');
    expect(second.session).toMatchObject({ resumed: true });
    // The session has the question already: the thread's first message, then only the new one, which is the request.
    expect(second.trigger?.text).toBe('And the photos share too.');
    expect(second.window).toEqual([]);
    expect(second.thread?.replies.map((m) => m.text)).toEqual(['And the photos share too.']);

    // Hermes lost the session: the turn fails, and its retry starts a fresh one with the whole thread.
    await complete(second, { outcome: 'failed', error: 'couldn’t pick up this conversation again' });
    const [requeued] = await t.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, second.dispatch.id));
    expect(requeued).toMatchObject({ state: 'queued', providerSessionId: null });
    await t.services.db
      .update(dispatches)
      .set({ notBefore: null })
      .where(eq(dispatches.id, second.dispatch.id));
    const retry = await claim();
    expect(retry.dispatch.id).toBe(second.dispatch.id);
    expect(retry.dispatch.providerSessionId).toBeNull();
    expect(retry.session).toMatchObject({ resumed: false });
    await complete(retry, { outcome: 'done', providerSessionId: 'hermes:local-fresh' });

    // The thread goes on in the fresh session.
    await say(IDS.mara, IDS.dmDusty, 'Thanks!', root);
    const third = await claim();
    expect(third.dispatch.providerSessionId).toBe('hermes:local-fresh');
    await complete(third, { outcome: 'done', providerSessionId: 'hermes:local-fresh' });
  });

  it('a turn served a tool its session never had starts a fresh one', async () => {
    const root = await say(IDS.mara, IDS.dmDusty, 'Clean up my inbox later.');
    const first = await claim();
    await complete(first, { outcome: 'done', providerSessionId: 'hermes:local-inbox' });
    const [row] = await t.services.db
      .select({ served: dispatches.servedTools })
      .from(dispatches)
      .where(eq(dispatches.id, first.dispatch.id));
    expect(row?.served).toContain('post_message');

    // The session began before an update added a tool: Hermes would keep it from the model.
    const before = (row?.served ?? []).filter((name) => name !== 'post_message');
    await t.services.db
      .update(dispatches)
      .set({ servedTools: before })
      .where(eq(dispatches.id, first.dispatch.id));
    await say(IDS.mara, IDS.dmDusty, 'Now, please.', root);
    const second = await claim();
    expect(second.dispatch.providerSessionId).toBeNull();
    expect(second.session).toMatchObject({ resumed: false });
    expect(shown(second)).toContain('Clean up my inbox later.');
    await complete(second, { outcome: 'done', providerSessionId: 'hermes:local-inbox-2' });

    // The fresh session has every tool: the thread goes on in it.
    await say(IDS.mara, IDS.dmDusty, 'Thanks!', root);
    const third = await claim();
    expect(third.dispatch.providerSessionId).toBe('hermes:local-inbox-2');
    await complete(third, { outcome: 'done', providerSessionId: 'hermes:local-inbox-2' });
  });

  it('another thread starts its own session', async () => {
    await say(IDS.mara, IDS.dmDusty, 'Something else: what time is it in Tokyo?');
    const other = await claim();
    expect(other.dispatch.providerSessionId).toBeNull();
    await complete(other, { outcome: 'done', providerSessionId: 'hermes:local-tokyo' });
  });

  it('deleting a thread forgets its sessions and the runner deletes them from Mara’s profile', async () => {
    const root = await say(IDS.mara, IDS.dmDusty, 'Draft a note to the landlord.');
    const turn = await claim();
    await complete(turn, { outcome: 'done', providerSessionId: 'hermes:local-landlord' });
    const file = hermesSession('local-landlord');

    expect((await t.commit(IDS.mara, deleteMessage, { messageId: root })).status).toBe('ok');
    await t.services.background.settle();
    await home.idle();
    await waitFor(() => !existsSync(file), 5_000, 'the session deleted');
    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, turn.dispatch.id));
    expect(row?.providerSessionId).toBeNull();
  });

  it('an edited message drops the sessions that saw it', async () => {
    const root = await say(IDS.mara, IDS.dmDusty, 'My door code is 1234, remember it.');
    const turn = await claim();
    await complete(turn, { outcome: 'done', providerSessionId: 'hermes:local-door' });
    const file = hermesSession('local-door');
    expect(
      (await t.commit(IDS.mara, editMessage, { messageId: root, text: 'My door code is secret.' })).status,
    ).toBe('ok');
    await t.services.background.settle();
    await home.idle();
    await waitFor(() => !existsSync(file), 5_000, 'the session deleted');
    // The thread's next turn starts fresh, with the words as they are now.
    await say(IDS.mara, IDS.dmDusty, 'What is it?', root);
    const next = await claim();
    expect(next.dispatch.providerSessionId).toBeNull();
    expect(shown(next)).toContain('My door code is secret.');
    await complete(next, { outcome: 'done' });
  });

  it('Clear chats deletes the room’s top-level sessions and keeps the threads’', async () => {
    const [thread] = await t.services.db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(eq(dispatches.providerSessionId, 'hermes:local-tokyo'));
    expect(thread).toBeTruthy();
    // A top-level turn of the room (as before threads), in a session of its own.
    const topLevel = await t.services.db
      .update(dispatches)
      .set({ threadRootId: null, providerSessionId: 'hermes:local-top' })
      .where(eq(dispatches.providerSessionId, 'hermes:local-fresh'))
      .returning({ id: dispatches.id });
    expect(topLevel.length).toBeGreaterThan(0);
    const top = hermesSession('local-top');
    const kept = hermesSession('local-tokyo');
    expect((await t.commit(IDS.mara, clearChat, { room: 'chat' })).status).toBe('ok');
    await t.services.background.settle();
    await home.idle();
    await waitFor(() => !existsSync(top), 5_000, 'the top-level session deleted');
    expect(existsSync(kept)).toBe(true);
  });
});

/** What the server keeps of a forgotten session of Mara's. */
async function forgotten(session: string) {
  const [row] = await t.services.db
    .select()
    .from(hermesSessionDrops)
    .where(and(eq(hermesSessionDrops.home, 'person'), eq(hermesSessionDrops.sessionId, session)));
  return row ?? null;
}

describe('Hermes housekeeping (hermes-native.md HN-K02, HN-K03, HN-K10, HN-K11)', () => {
  it('a delete the runner couldn’t take waits, and is handed over once the runner takes steps again', async () => {
    const root = await say(IDS.mara, IDS.dmDusty, 'Plan the garden party.');
    const turn = await claim();
    await complete(turn, { outcome: 'done', providerSessionId: 'hermes:local-garden' });
    const file = hermesSession('local-garden');
    // The runner takes no step now.
    useHermesHome(t.services, {
      handle: async (req) => ({ id: req.id, ok: false, code: 'unavailable', error: 'no runner' }),
    });
    try {
      expect((await t.commit(IDS.mara, deleteMessage, { messageId: root })).status).toBe('ok');
      await t.services.background.settle();
      expect(existsSync(file)).toBe(true);
      expect(await forgotten('local-garden')).toMatchObject({ handedAt: null });
    } finally {
      useHermesHome(t.services, home);
    }
    await hermesHousekeeping(t.services).run();
    await home.idle();
    expect(existsSync(file)).toBe(false);
    expect((await forgotten('local-garden'))?.handedAt).toBeInstanceOf(Date);
  });

  it('a turn that reports a session after it was forgotten doesn’t name it again', async () => {
    const root = await say(IDS.mara, IDS.dmDusty, 'Book the car for Friday.');
    const turn = await claim();
    await beat(turn, 'hermes:local-car');
    expect(
      (await t.commit(IDS.mara, editMessage, { messageId: root, text: 'Book the car for Saturday.' })).status,
    ).toBe('ok');
    await t.services.background.settle();
    expect(await forgotten('local-car')).not.toBeNull();
    // The turn ends and names the session it ran in: the server doesn't take it back.
    await complete(turn, { outcome: 'done', providerSessionId: 'hermes:local-car' });
    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, turn.dispatch.id));
    expect(row?.providerSessionId).toBeNull();
  });

  it('a restored home has the sessions forgotten since deleted again', async () => {
    const back = hermesSession('local-garden');
    await t.services.pipeline.transactAccount((tx) => hermesHomeRestored(tx, 'person'));
    await hermesHousekeeping(t.services).run();
    await home.idle();
    expect(existsSync(back)).toBe(false);
    expect((await forgotten('local-garden'))?.handedAt).toBeInstanceOf(Date);
  });

  it('prunes Whombat’s sessions no turn names once idle; named, running, recent and others’ stay', async () => {
    await say(IDS.mara, IDS.dmDusty, 'Water the plants on Sunday.');
    const ended = await claim();
    await complete(ended, { outcome: 'done', providerSessionId: 'hermes:local-plants' });
    await say(IDS.mara, IDS.dmDusty, 'Find the train times.');
    const running = await claim();
    await beat(running, 'hermes:local-train');
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const listing = {
      sessions: [
        { id: 'local-orphan', source: 'acp', lastActiveAt: ago(30) },
        { id: 'local-plants', source: 'acp', lastActiveAt: ago(30) },
        { id: 'local-train', source: 'acp', lastActiveAt: ago(20) },
        { id: 'local-cli', source: 'cli', lastActiveAt: ago(40) },
        { id: 'local-new', source: 'acp', lastActiveAt: ago(2) },
      ],
      more: false,
    };
    const orphan = hermesSession('local-orphan');
    const asked: (string | null)[] = [];
    useHermesHome(t.services, {
      handle: async (req) => {
        if (req.method !== 'sessions.list') return home.handle(req);
        const which = (req.params as { home: string }).home;
        asked.push(which);
        return {
          id: req.id,
          ok: true,
          result: which === 'person' ? listing : { sessions: [], more: false },
        };
      },
    });
    const housekeeping = hermesHousekeeping(t.services);
    try {
      // Every home was tried when the scripted Hermes answered `unavailable`; the person's is due again now.
      housekeeping.pruneSoon('person');
      await housekeeping.run();
      await home.idle();
      expect(asked).toEqual(['person']);
      expect(existsSync(orphan)).toBe(false);
      const dropped = await forgotten('local-orphan');
      expect(dropped?.handedAt).toBeInstanceOf(Date);
      for (const kept of ['local-plants', 'local-train', 'local-cli', 'local-new'])
        expect(await forgotten(kept), kept).toBeNull();
      // Listed again while the runner may still be deleting it: not recorded again.
      housekeeping.pruneSoon('person');
      await housekeeping.run();
      expect(await forgotten('local-orphan')).toEqual(dropped);

      // Not listed again before its time; a restored home is listed in the round after its commit.
      asked.length = 0;
      await housekeeping.run();
      expect(asked).toEqual([]);
      await t.services.pipeline.transactAccount(async (tx, session) => {
        await hermesHomeRestored(tx, 'person');
        kickHermesHousekeeping(session, { home: 'person' });
      });
      await t.services.background.settle();
      expect(asked).toEqual(['person']);

      // Hours later both homes are listed again: the person's and the outsiders'.
      asked.length = 0;
      const clock = t.services.clock;
      t.services.clock = () => new Date(clock().getTime() + PRUNE_EVERY_MS + 60_000);
      try {
        await housekeeping.run();
      } finally {
        t.services.clock = clock;
      }
      expect(asked).toEqual(expect.arrayContaining(['person', 'outside']));
    } finally {
      useHermesHome(t.services, home);
      await complete(running, { outcome: 'done', providerSessionId: 'hermes:local-train' });
    }
  });
});
