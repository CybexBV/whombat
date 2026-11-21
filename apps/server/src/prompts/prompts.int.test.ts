/**
 * The person's prompts (docs/decisions/prompts.md): the list with the shipped ones, keeping, changing, removing and
 * bringing them back, and using one on a T3 Code project, which posts the person's line in their Chat, briefs the agent
 * with the prompt's words for a new T3 Code thread and records the run. Needs Postgres: every write goes through the
 * commit pipeline, and using one stores the message, its turn and the brief event the turn reads.
 */
import { api, buildPath, newId, PROMPT_MERGE_MARK, STARTER_PROMPTS } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { catalogConnections, dispatches, messages, prompts, t3Watches } from '../db/schema/index';
import { agentBriefOf } from '../domain/agent-brief';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { followT3Call } from '../t3code/follow';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { PROMPT_WORDS_BEGIN, PROMPT_WORDS_END } from './brief';
import { createPrompt } from './commands';

const t = useTestServer({ seed: true });
let cookie = '';
const db = () => t.services.db;

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON answers in a test
type Json = Record<string, any>;

async function call(
  op: keyof typeof api.prompts,
  params: Record<string, string> = {},
  payload?: Json,
): Promise<{ status: number; body: Json }> {
  const ep = api.prompts[op];
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', ...params })}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: res.json() as Json };
}

const PROJECT = { id: 'proj-fusebox', title: 'Fusebox' };
const audit = STARTER_PROMPTS[0];

beforeAll(async () => {
  ({ cookie } = await sessionFor(t.services, IDS.mara));
});

describe('the person’s prompts', () => {
  it('lists the shipped prompts without writing anything', async () => {
    const { status, body } = await call('list');
    expect(status).toBe(200);
    expect(body.prompts.map((p: Json) => p.id)).toEqual(STARTER_PROMPTS.map((s) => `starter-${s.key}`));
    expect(await db().select().from(prompts)).toHaveLength(0);
  });

  it('keeps, changes, removes and brings back prompts', async () => {
    const made = await call(
      'create',
      {},
      {
        title: 'Tidy the CSS',
        text: 'Remove unused CSS.',
        onRepository: true,
        ownIt: false,
        ai: null,
      },
    );
    expect(made.status).toBe(201);
    expect(made.body.prompt).toMatchObject({ title: 'Tidy the CSS', starter: false });
    expect(made.body.prompt.id).toMatch(/^prm_/);

    const changed = await call(
      'save',
      { promptId: 'starter-audit' },
      {
        title: audit?.title,
        text: 'Only look, change nothing.',
        onRepository: true,
        ownIt: true,
        ai: null,
      },
    );
    expect(changed.body.prompt).toMatchObject({ id: 'starter-audit', edited: true, ownIt: true });
    const [kept] = await db().select().from(prompts).where(eq(prompts.starterKey, 'audit'));
    // The title as shipped stays the shipped one's.
    expect(kept).toMatchObject({ title: null, text: 'Only look, change nothing.' });

    const removed = await call('remove', { promptId: 'starter-bugs' });
    expect(removed.body.prompts.map((p: Json) => p.id)).not.toContain('starter-bugs');
    expect(
      (await call('remove', { promptId: made.body.prompt.id })).body.prompts.map((p: Json) => p.id),
    ).not.toContain(made.body.prompt.id);
    expect(
      (
        await call(
          'save',
          { promptId: 'starter-bugs' },
          { title: 'x', text: 'y', onRepository: true, ownIt: false, ai: null },
        )
      ).status,
    ).toBe(404);

    const back = await call('restore', {}, {});
    expect(back.body.prompts.map((p: Json) => p.id)).toEqual(STARTER_PROMPTS.map((s) => `starter-${s.key}`));
    expect(back.body.prompts[0]).toMatchObject({ text: audit?.text, ownIt: false, edited: false });
  });

  it('is the person’s own: the agent can’t keep one', async () => {
    await expect(
      t.commit(IDS.dusty, createPrompt, {
        title: 'Mine',
        text: 'Words',
        onRepository: false,
        ownIt: false,
        ai: null,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('says when T3 Code isn’t connected, and refuses to use a prompt then', async () => {
    expect((await call('projects')).body).toEqual({ projects: null, t3: 'not_connected' });
    const res = await call(
      'use',
      { promptId: 'starter-audit' },
      { conversationId: IDS.dmDusty, project: PROJECT },
    );
    expect(res.status).toBe(409);
    expect(res.body.message ?? res.body.error?.message).toMatch(/T3 Code/);
  });

  describe('with T3 Code connected', () => {
    const connectionId = newId('connection');
    beforeAll(async () => {
      await db()
        .insert(catalogConnections)
        .values({
          id: connectionId,
          catalogId: 't3code',
          burrowId: t.burrowId,
          label: 'T3 Code',
          handle: 't3',
          transport: 'mcp' as never,
          signIn: 'token' as never,
          baseUrl: 'http://127.0.0.1:1',
        });
    });

    it('says when T3 Code can’t be asked for its projects', async () => {
      expect((await call('projects')).body).toEqual({ projects: null, t3: 'unreachable' });
    });

    it('posts the person’s line, briefs the agent with the words unchanged, and records the run', async () => {
      const res = await call(
        'use',
        { promptId: 'starter-audit' },
        { conversationId: IDS.dmDusty, project: PROJECT },
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const { messageId, rootId } = res.body;
      expect(rootId).toBe(messageId);
      const [m] = await db().select().from(messages).where(eq(messages.id, messageId));
      expect(m).toMatchObject({
        authorId: IDS.mara,
        conversationId: IDS.dmDusty,
        text: `${audit?.title} · Fusebox`,
      });

      const brief = await agentBriefOf(db(), t.burrowId, messageId, IDS.dusty);
      const words = brief?.split(`${PROMPT_WORDS_BEGIN}\n`)[1]?.split(`\n${PROMPT_WORDS_END}`)[0];
      expect(words).toBe(audit?.text);
      expect(brief).toContain('"proj-fusebox"');

      // The agent's turn for it reads the line and the brief.
      const [turn] = await db()
        .select()
        .from(dispatches)
        .where(and(eq(dispatches.messageId, messageId), eq(dispatches.agentId, IDS.dusty)));
      expect(turn).toBeDefined();
      const context = await buildDispatchContext(t.services, turn as NonNullable<typeof turn>);
      expect(context.trigger?.text).toContain(audit?.text);
      await db().update(dispatches).set({ state: 'done' });

      const listed = (await call('list')).body.prompts.find((p: Json) => p.id === 'starter-audit');
      expect(listed.runs).toEqual([expect.objectContaining({ projectId: PROJECT.id, title: 'Fusebox' })]);
      expect(listed.edited).toBe(false);
    });

    it('tells the next thread when it last ran there, as a reply in the thread', async () => {
      const [root] = await db()
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, IDS.dmDusty), eq(messages.text, `${audit?.title} · Fusebox`)));
      const res = await call(
        'use',
        { promptId: 'starter-audit' },
        { conversationId: IDS.dmDusty, rootId: root?.id, project: PROJECT },
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.rootId).toBe(root?.id);
      const brief = await agentBriefOf(db(), t.burrowId, res.body.messageId, IDS.dusty);
      expect(brief).toContain(`${audit?.text}\n\n`);
      expect(brief).toMatch(/\d{4}-\d{2}-\d{2}/);
      await db().update(dispatches).set({ state: 'done' });
    });

    it('has Whombat merge the thread’s work when the prompt says so, and only then', async () => {
      const saved = await call(
        'save',
        { promptId: 'starter-audit' },
        { title: audit?.title, text: audit?.text, onRepository: true, ownIt: false, merge: true, ai: null },
      );
      expect(saved.body.prompt).toMatchObject({ merge: true, edited: true });
      // An app from before the switch leaves it out: the prompt keeps it.
      const older = await call(
        'save',
        { promptId: 'starter-audit' },
        { title: audit?.title, text: audit?.text, onRepository: true, ownIt: false, ai: null },
      );
      expect(older.body.prompt.merge).toBe(true);

      // Dusty starts each thread with the words it was briefed; only the merge prompt's is merged by Whombat.
      const launch = async (merge: boolean, threadId: string) => {
        const used = await call(
          'use',
          { promptId: 'starter-audit' },
          { conversationId: IDS.dmDusty, project: PROJECT },
        );
        const brief = (await agentBriefOf(db(), t.burrowId, used.body.messageId, IDS.dusty)) ?? '';
        const words = brief.split(`${PROMPT_WORDS_BEGIN}\n`)[1]?.split(`\n${PROMPT_WORDS_END}`)[0] ?? '';
        expect(words.includes(PROMPT_MERGE_MARK)).toBe(merge);
        const [turn] = await db()
          .select()
          .from(dispatches)
          .where(and(eq(dispatches.messageId, used.body.messageId), eq(dispatches.agentId, IDS.dusty)));
        if (!turn) throw new Error('no turn');
        await followT3Call(t.services, {
          burrowId: t.burrowId,
          agentId: IDS.dusty,
          connectionId,
          dispatch: turn,
          personId: IDS.mara,
          tool: 't3_thread_launch',
          args: { projectId: PROJECT.id, title: 'Find what’s broken', message: words },
          output: { content: JSON.stringify({ threadId }), isError: false },
        });
        await db().update(dispatches).set({ state: 'done' });
        const [watch] = await db().select().from(t3Watches).where(eq(t3Watches.threadId, threadId));
        expect(watch, 'the thread is watched').toBeDefined();
        return watch?.merge ?? null;
      };
      expect(await launch(true, 'mcp:prompt-merge')).toEqual({ state: 'wanted' });
      await call(
        'save',
        { promptId: 'starter-audit' },
        { title: audit?.title, text: audit?.text, onRepository: true, ownIt: false, merge: false, ai: null },
      );
      expect(await launch(false, 'mcp:prompt-plain')).toBeNull();
    });

    it('refuses a prompt that isn’t for a repository, and another person’s room', async () => {
      const own = await call(
        'create',
        {},
        { title: 'Say hi', text: 'Hi!', onRepository: false, ownIt: false, ai: null },
      );
      const res = await call(
        'use',
        { promptId: own.body.prompt.id },
        { conversationId: IDS.dmDusty, project: PROJECT },
      );
      expect(res.status).toBe(409);
      const elsewhere = await call(
        'use',
        { promptId: 'starter-audit' },
        { conversationId: IDS.dmDusty.replace('dusty', 'nobody'), project: PROJECT },
      );
      expect(elsewhere.status).toBe(404);
    });
  });
});
