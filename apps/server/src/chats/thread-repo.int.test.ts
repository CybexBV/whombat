/**
 * A thread's repository and its icon in the Chat list (docs/decisions/chat-inbox.md): a thread an automation run started
 * carries the run's repository, a thread without one carries none, and the repository's own icon is found in its
 * default branch once, kept as a picture attachment the burrow's people can read, and not looked for again within the
 * day. Needs Postgres: a thread's repository is a join of its first message with the runs and jobs of the thread, and the
 * icon is an attachment row the attachment rules read.
 */
import { newId } from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { automationRuns, automations, repoIcons } from '../db/schema/index';
import { GitHubError } from '../github/adapter';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
let mine: PersonalSetup;
let cookie: string;

beforeAll(async () => {
  mine = await addPersonalAgent(t.services, t.burrowId, IDS.mara, {
    name: 'Dusty',
    services: null,
    grants: [],
  });
  ({ cookie } = await sessionFor(t.services, IDS.mara));
});

type Row = { rootId: string; repo?: { fullName: string; name: string; iconUrl?: string | null } | null };

async function send(text: string, threadRootId?: string) {
  const res = await t.commit(IDS.mara, sendMessage, {
    conversationId: mine.dmId,
    text,
    ...(threadRootId ? { threadRootId } : {}),
  });
  if (res.status !== 'ok') throw new Error(`send: ${res.status}`);
  return res.result.id as string;
}

/** The room's threads, after the looks the read started have ended. */
async function threads(): Promise<Row[]> {
  const res = await t.api.inject({
    method: 'GET',
    url: '/api/v1/burrows/burrow-hq/chats/threads?room=chat',
    headers: { cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  await t.services.github.repoIcons.idle();
  return res.json().threads as Row[];
}

/** A run of a repository automation whose thread is `rootId`. */
async function automationRun(rootId: string, repo: string) {
  const automationId = newId('automation');
  const now = new Date();
  await t.services.db.insert(automations).values({
    id: automationId,
    burrowId: t.burrowId,
    name: 'Hunt for bugs',
    principalId: mine.agentId,
    createdById: IDS.mara,
    createdAt: now,
    updatedAt: now,
  });
  const [{ n } = { n: 0 }] = await t.services.db
    .select({ n: sql<number>`coalesce(max(${automationRuns.number}), 0)::int` })
    .from(automationRuns)
    .where(eq(automationRuns.burrowId, t.burrowId));
  await t.services.db.insert(automationRuns).values({
    id: newId('automationRun'),
    burrowId: t.burrowId,
    number: n + 1,
    automationId,
    version: 1,
    definition: {
      recipe: { when: { kind: 'schedule' }, repo },
      steps: [{ id: 'ask', kind: 'dispatch_agent', workspace: { repo, access: 'read' } }],
    } as never,
    publishedById: IDS.mara,
    status: 'succeeded',
    trigger: {
      kind: 'schedule',
      summary: 'Every day',
      actorId: null,
      eventId: null,
      messageId: null,
      scheduledFor: null,
    },
    triggerKey: `sched:${automationId}`,
    conversationId: mine.dmId,
    threadRootId: rootId,
    createdAt: now,
    deadlineAt: now,
    updatedAt: now,
  });
}

async function kept(repo: string) {
  const [row] = await t.services.db
    .select()
    .from(repoIcons)
    .where(and(eq(repoIcons.burrowId, t.burrowId), eq(repoIcons.repo, repo)));
  return row;
}

describe('a thread’s repository and its icon', () => {
  it('reads a reply past its first line, and a link as its words', async () => {
    const root = await send('How did the release go?');
    await send('Done.\nIt shipped as [PR 69](https://github.com/whombat/web/pull/69) this morning.', root);
    const row = (await threads()).find((x) => x.rootId === root) as Row & { last?: { text: string } };
    expect(row.last?.text).toContain('Done.');
    expect(row.last?.text).toContain('PR 69');
    expect(row.last?.text).not.toContain('https://');
    expect(row.last?.text).not.toContain('](');
  });

  it('gives a thread an automation run started its repository, and finds the repository’s icon once', async () => {
    const fake = t.services.github.fake;
    if (!fake) throw new Error('the tests run on the fake GitHub');
    const plain = await send('Just a question');
    const root = await send('Hunt for bugs · web');
    await automationRun(root, 'whombat/web');
    const reads = fake.treeReads.length;

    // The first read answers at once with what is kept (nothing yet) and starts the look.
    const first = await threads();
    expect(first.find((x) => x.rootId === plain)?.repo).toBeUndefined();
    expect(first.find((x) => x.rootId === root)?.repo).toMatchObject({
      fullName: 'whombat/web',
      name: 'web',
    });
    expect(fake.treeReads.length).toBe(reads + 1);

    const second = await threads();
    const icon = second.find((x) => x.rootId === root)?.repo?.iconUrl;
    expect(icon).toMatch(/\/attachments\//);
    expect((await kept('whombat/web'))?.path).toBe('public/apple-touch-icon.png');
    // Kept for the day: GitHub isn't asked again.
    expect(fake.treeReads.length).toBe(reads + 1);
    await t.services.github.repoIcons.lookUp(t.burrowId, 'whombat/web');
    expect(fake.treeReads.length).toBe(reads + 1);

    const served = await t.api.inject({ method: 'GET', url: icon as string, headers: { cookie } });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toContain('image/png');

    // A day later the same file is listed again and not downloaded again.
    const blobs = fake.blobReads.length;
    await t.services.db
      .update(repoIcons)
      .set({ nextCheckAt: new Date(Date.now() - 1000) })
      .where(eq(repoIcons.repo, 'whombat/web'));
    await t.services.github.repoIcons.lookUp(t.burrowId, 'whombat/web');
    const later = await threads();
    expect(fake.treeReads.length).toBe(reads + 2);
    expect(fake.blobReads.length).toBe(blobs);
    expect(later.find((x) => x.rootId === root)?.repo?.iconUrl).toBe(icon);
  });

  it('keeps a repository without a fitting icon without one, and doesn’t ask again within the day', async () => {
    const fake = t.services.github.fake;
    if (!fake) throw new Error('the tests run on the fake GitHub');
    // An SVG is no picture the phones draw.
    fake.defaultFiles.set(
      'whombat/infra',
      new Map([['public/favicon.png', new TextEncoder().encode('<svg/>')]]),
    );
    const root = await send('Remove needless complexity · infra');
    await automationRun(root, 'whombat/infra');
    const reads = fake.treeReads.length;
    await threads();
    const row = (await threads()).find((x) => x.rootId === root);
    expect(row?.repo).toMatchObject({ fullName: 'whombat/infra' });
    expect(row?.repo?.iconUrl ?? null).toBeNull();
    expect(await kept('whombat/infra')).toMatchObject({ attachmentId: null });
    expect(fake.treeReads.length).toBe(reads + 1);
  });

  it('writes nothing when GitHub fails, so the repository is tried again later', async () => {
    const fake = t.services.github.fake;
    if (!fake) throw new Error('the tests run on the fake GitHub');
    fake.failNextTree = new GitHubError('API rate limit exceeded', 429);
    await expect(t.services.github.repoIcons.lookUp(t.burrowId, 'whombat/billing')).rejects.toThrow();
    expect(await kept('whombat/billing')).toBeUndefined();
    await t.services.github.repoIcons.lookUp(t.burrowId, 'whombat/billing');
    expect(await kept('whombat/billing')).toBeDefined();
  });
});
