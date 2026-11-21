/**
 * Getting one thing back from a backup (backup-look.md BKO-40…) against a fake backup service: the seeded world with a
 * Chat thread about the roof is copied as the backup opened for reading (a throwaway `whombat_peek_…` database, an
 * empty folder), the thread is deleted here, and the ops find it, bring it back — only it, through the restorer — and a
 * second bring-back says it was here already. The refusals people read come from the service's answers. Needs Postgres:
 * the backup is a second database next to the box's, read through its own read-only pool.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, count, eq, isNull, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval } from '../../commands/approvals';
import { deleteMessage } from '../../commands/message-edits';
import { sendMessage } from '../../commands/messages';
import {
  approvals,
  attachments,
  automations,
  backupRestores,
  conversations,
  dispatches,
  messages,
} from '../../db/schema/index';
import type { BackupPort } from '../../managed/backup';
import { useBoxBackup } from '../../managed/box-backup';
import type { DispatchRow } from '../../runtime/context';
import { IDS, TEST_BURROW_ID } from '../../seed/test-world';
import { setGrant } from '../../test/approvals';
import { useManagedRuntime } from '../../test/managed';
import { copyAsPeek } from '../../test/peek';
import { addPersonalAgent, type PersonalSetup } from '../../test/personal';
import { waitFor } from '../../test/runner';
import { accountOf } from '../../test/tokens';
import { looksFor } from './service';
import { backupBringBackTool } from './tool';

const m = useManagedRuntime({ seed: true });
const calls: { method: string; path: string; body: unknown }[] = [];
let peek: Awaited<ReturnType<typeof copyAsPeek>> | null = null;
let root = '';
/** The service's answer to opening one; the peek stays opening for one read, then is ready. */
let openAnswer: () => { status: number; body: unknown } = () => ({ status: 202, body: { id: 'pk_1' } });
let reads = 0;

const fake: BackupPort = {
  async call(method, path, body) {
    calls.push({ method, path, body });
    if (path === '/v1/checkpoints')
      return {
        status: 200,
        body: {
          checkpoints: [
            {
              id: 'ck-1',
              seq: 1,
              snapshotId: 'aaaa',
              createdAt: '2026-11-03T06:00:00Z',
              reason: 'scheduled',
              schemaVersion: 120,
              bytes: 1,
              bytesAdded: 1,
              applianceId: 'wb-home',
              own: true,
              check: null,
            },
          ],
          unauthentic: 0,
          local: null,
        },
      };
    if (path === '/v1/peeks' && method === 'POST') return openAnswer();
    if (path === '/v1/peeks/pk_1' && method === 'GET') {
      reads++;
      return {
        status: 200,
        body: {
          id: 'pk_1',
          checkpointId: 'ck-1',
          state: reads === 1 ? 'opening' : 'ready',
          database: reads === 1 ? null : peek?.name,
          root: reads === 1 ? null : root,
          expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
          error: null,
        },
      };
    }
    if (path === '/v1/peeks/pk_1' && method === 'DELETE') return { status: 200, body: { state: 'closed' } };
    return { status: 404, body: null };
  },
};

const FILE_ID = 'att_lookquote1';
const FILE_BYTES = Buffer.from('Roof repair: 1,240 euro, two days.\n');
const FILE_SHA = createHash('sha256').update(FILE_BYTES).digest('hex');
let owner: Awaited<ReturnType<typeof m.enroll>>;
let rootId = '';
let replyId = '';
let heatingId = '';
let mine: PersonalSetup;
let accountId = '';

beforeAll(async () => {
  m.runtime.dispatcher.backup = fake;
  owner = await m.enroll(IDS.mara);
  const t = m.t;
  // A thread in Mara's Chat, and Dusty's answer in it.
  const asked = await t.commit(IDS.mara, sendMessage, {
    conversationId: IDS.dmDusty,
    text: 'Our roof is leaking again above the kitchen',
  });
  if (asked.status !== 'ok') throw new Error('the question was refused');
  rootId = (asked.result as { id: string }).id;
  const answered = await t.commit(IDS.dusty, sendMessage, {
    conversationId: IDS.dmDusty,
    threadRootId: rootId,
    text: 'I’ll find a roofer who can come this week.',
  });
  if (answered.status !== 'ok') throw new Error('the answer was refused');
  replyId = (answered.result as { id: string }).id;
  // Another one, which the assistant finds and brings back.
  mine = await addPersonalAgent(t.services, TEST_BURROW_ID, IDS.mara, { services: null });
  accountId = (await accountOf(t.services, IDS.mara)) as string;
  const heating = await t.commit(IDS.mara, sendMessage, {
    conversationId: mine.dmId,
    text: 'The heating invoice from Acme looks too high',
  });
  if (heating.status !== 'ok') throw new Error('the second question was refused');
  heatingId = (heating.result as { id: string }).id;
  // A file in Files, which the backup has and this Whombat then loses.
  await t.services.db.insert(attachments).values({
    id: FILE_ID,
    burrowId: TEST_BURROW_ID,
    conversationId: IDS.dmDusty,
    name: 'roofer-quote.txt',
    contentType: 'text/plain',
    size: FILE_BYTES.length,
    sha256: FILE_SHA,
    blobKey: `sha256/${FILE_SHA.slice(0, 2)}/${FILE_SHA.slice(2, 4)}/${FILE_SHA}`,
    state: 'ready',
    url: `/b/burrow-hq/files/${FILE_ID}`,
    uploadedById: IDS.mara,
    filedAt: new Date('2026-11-02T10:00:00Z'),
    filedById: IDS.mara,
  });
  // The backup: the world as it is now.
  peek = await copyAsPeek(t.services.config.DATABASE_URL);
  root = await mkdtemp(join(tmpdir(), 'wb-look-root-'));
  // Its folder holds the file's bytes where the file store keeps them.
  const blobDir = join(root, 'home', 'files', 'sha256', FILE_SHA.slice(0, 2), FILE_SHA.slice(2, 4));
  await mkdir(blobDir, { recursive: true });
  await writeFile(join(blobDir, FILE_SHA), FILE_BYTES);
  await t.services.db.delete(attachments).where(eq(attachments.id, FILE_ID));
  // Then the thread is deleted here (its turn is over first: a thread with work going on stays).
  await t.services.db.update(dispatches).set({ state: 'done' });
  for (const messageId of [rootId, heatingId]) {
    const gone = await t.commit(IDS.mara, deleteMessage, { messageId });
    if (gone.status !== 'ok') throw new Error('the thread wasn’t deleted');
  }
}, 120_000);

afterAll(async () => {
  await looksFor(m.t.services).stop();
  await peek?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

/** What is here that a bring-back could change. */
async function counts() {
  const db = m.t.services.db;
  const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  return {
    messages: await n(db.select({ n: count() }).from(messages)),
    conversations: await n(db.select({ n: count() }).from(conversations)),
    files: await n(db.select({ n: count() }).from(attachments)),
    automations: await n(db.select({ n: count() }).from(automations).where(isNull(automations.deletedAt))),
  };
}

type Result =
  | { t: 'result'; output: Record<string, unknown> }
  | { t: 'error'; message: string; details?: unknown };

type Client = Awaited<ReturnType<typeof m.client>>;

/** An op's answer, which must be a result. */
async function output<T>(c: Client, op: string, input: Record<string, unknown>): Promise<T> {
  const r = (await c.request(op, input)) as unknown as Result;
  if (r.t !== 'result') throw new Error(`${op} refused: ${JSON.stringify(r)}`);
  return r.output as T;
}

type Items = { items: { id: string; title: string; here: boolean | null; detail: string | null }[] };
type Brought = { look: { bring: Record<string, unknown> }; say: string };

async function ready(c: Client, lookId: string) {
  for (let i = 0; i < 20; i++) {
    const r = (await c.request('backup.lookContents', { lookId })) as unknown as Result;
    if (r.t !== 'result') throw new Error(`lookContents refused: ${JSON.stringify(r)}`);
    const look = r.output.look as { state: string };
    if (look.state !== 'opening') return r.output;
  }
  throw new Error('the backup never opened');
}

describe('getting one thing back', () => {
  it('opens the backup, finds the deleted thread, brings only it back, and a second time says it was here', async () => {
    const c = await m.client(owner);
    const opened = await output<{ lookId: string }>(c, 'backup.look', { checkpointId: 'ck-1' });
    expect(opened).toMatchObject({ checkpointId: 'ck-1', madeAt: '2026-11-03T06:00:00.000Z' });
    const lookId = opened.lookId;
    expect(calls.find((x) => x.path === '/v1/peeks')?.body).toEqual({ checkpointId: 'ck-1' });

    const contents = await ready(c, lookId);
    expect(contents.look).toMatchObject({ state: 'ready' });
    const chats = (contents.categories as { id: string; count: number }[]).find((x) => x.id === 'messages');
    expect(chats?.count).toBeGreaterThan(0);

    const found = await output<Items>(c, 'backup.lookContents', {
      lookId,
      category: 'messages',
      query: 'roof kitchen',
    });
    expect(found.items).toHaveLength(1);
    const item = found.items[0];
    expect(item).toMatchObject({ id: `thread:${rootId}`, here: false });
    expect(item?.title).toContain('roof');

    const before = await counts();
    const brought = await output<Brought>(c, 'backup.lookBring', { lookId, items: [`thread:${rootId}`] });
    expect(brought.look.bring).toMatchObject({
      state: 'done',
      picked: 1,
      back: 1,
      already: 0,
      notBack: 0,
    });
    expect(brought.say).toContain('roof');

    // The thread is back in Mara's Chat — its question and Dusty's answer under it — and nothing else changed.
    const db = m.t.services.db;
    const [question] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, IDS.dmDusty), like(messages.text, 'Our roof is leaking%')));
    expect(question?.threadRootId).toBeNull();
    const replies = await db
      .select()
      .from(messages)
      .where(eq(messages.threadRootId, question?.id ?? ''));
    expect(replies.map((r) => r.text)).toEqual(['I’ll find a roofer who can come this week.']);
    expect(await counts()).toEqual({ ...before, messages: before.messages + 2 });
    // A look's restore isn't a backup file's: it names the look, not an upload.
    const [row] = await db.select().from(backupRestores).where(like(backupRestores.uploadId, 'bkl_%'));
    expect(row).toMatchObject({ status: 'done', onDifferent: 'keep' });

    // Listed again it is here; brought back again, nothing is added.
    const again = await output<Items>(c, 'backup.lookContents', {
      lookId,
      category: 'messages',
      query: 'roof',
    });
    expect(again.items[0]?.here).toBe(true);
    const twice = await output<Brought>(c, 'backup.lookBring', { lookId, items: [`thread:${rootId}`] });
    expect(twice.look.bring).toMatchObject({ state: 'done', back: 0, already: 1 });
    expect(await counts()).toEqual({ ...before, messages: before.messages + 2 });
    expect(replies[0]?.id).not.toBe(replyId);

    // Done: closed at the service.
    expect(await output(c, 'backup.lookClose', { lookId })).toMatchObject({ state: 'closed' });
    expect(calls.some((x) => x.method === 'DELETE' && x.path === '/v1/peeks/pk_1')).toBe(true);
    expect(await c.request('backup.lookContents', { lookId })).toMatchObject({
      t: 'result',
      output: { look: { state: 'closed' }, items: [] },
    });
  }, 120_000);

  it('says why a backup can’t be opened: no room (with the size), busy, an older box', async () => {
    const c = await m.client(owner);
    openAnswer = () => ({
      status: 507,
      body: { error: { code: 'no_space', message: 'x', needBytes: 3_200_000_000, freeBytes: 1_100_000_000 } },
    });
    expect(await c.request('backup.look', { checkpointId: 'ck-1' })).toMatchObject({
      t: 'result',
      output: {
        state: 'failed',
        problem: { code: 'no_room', needBytes: 3_200_000_000, freeBytes: 1_100_000_000 },
      },
    });
    openAnswer = () => ({
      status: 409,
      body: { error: { code: 'busy', message: 'another backup is open' } },
    });
    expect(await c.request('backup.look', { checkpointId: 'ck-1' })).toMatchObject({
      t: 'result',
      output: { state: 'failed', problem: { code: 'busy' } },
    });
    openAnswer = () => ({ status: 404, body: null });
    expect(await c.request('backup.look', { checkpointId: 'ck-1' })).toMatchObject({
      t: 'result',
      output: { state: 'failed', problem: { code: 'not_supported' } },
    });
  });

  it('the assistant finds “the heating invoice” in yesterday’s backup and brings it back on the person’s yes', async () => {
    openAnswer = () => ({ status: 202, body: { id: 'pk_1' } });
    useBoxBackup(m.t.services, { port: fake, status: () => null });
    await setGrant(m.t.services, mine.agentId, 'settings.change', 'ask');
    const ctx = {
      services: m.t.services,
      agentId: mine.agentId,
      burrowId: TEST_BURROW_ID,
      dispatch: {
        id: 'dsp_look',
        burrowId: TEST_BURROW_ID,
        agentId: mine.agentId,
        onBehalfOfAccountId: accountId,
        conversationId: mine.dmId,
        threadRootId: null,
      } as DispatchRow,
      onBehalfOf: {},
    };
    const found = await backupBringBackTool(ctx, { find: 'heating invoice', before: '2026-11-04T00:00:00Z' });
    expect(found).toMatchObject({ status: 'found', items: [{ id: `thread:${heatingId}`, here: false }] });
    const say = found.status === 'found' ? found.say : '';
    // What the agent passes on carries no ids or paths.
    expect(say).not.toMatch(/bkl_|msg_|thread:|\//);

    const asked = await backupBringBackTool(ctx, { bring: [`thread:${heatingId}`] });
    expect(asked.status).toBe('pending_approval');
    const [approval] = await m.t.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, asked.status === 'pending_approval' ? asked.approvalId : ''));
    expect(approval?.title).toBe('Bring things back from a backup');
    // The card names it by its title in the backup, never by an id.
    const visible = JSON.stringify([
      approval?.title,
      approval?.question,
      approval?.whatHappens,
      approval?.explainer,
    ]);
    expect(visible).toContain('heating invoice');
    expect(visible).not.toMatch(/bkl_|msg_|thread:/);
    // Nothing comes back before the yes.
    const back = async () =>
      (
        await m.t.services.db
          .select({ id: messages.id })
          .from(messages)
          .where(like(messages.text, 'The heating invoice%'))
      ).length;
    expect(await back()).toBe(0);
    const res = await m.t.services.pipeline.commit(
      decideApproval,
      { number: approval?.number as number, decision: 'approve' },
      { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
    );
    expect(res.status).toBe('ok');
    await waitFor(async () => ((await back()) === 1 ? true : null), 30_000, 'the thread back');
  }, 120_000);

  it('brings back a file from Files with its bytes', async () => {
    openAnswer = () => ({ status: 202, body: { id: 'pk_1' } });
    const c = await m.client(owner);
    const opened = await output<{ lookId: string }>(c, 'backup.look', { checkpointId: 'ck-1' });
    await ready(c, opened.lookId);
    const files = await output<Items>(c, 'backup.lookContents', {
      lookId: opened.lookId,
      category: 'files',
      query: 'roofer',
    });
    expect(files.items).toMatchObject([{ id: `file:${FILE_ID}`, title: 'roofer-quote.txt', here: false }]);
    const brought = await output<Brought>(c, 'backup.lookBring', {
      lookId: opened.lookId,
      items: [`file:${FILE_ID}`],
    });
    expect(brought.look.bring).toMatchObject({ state: 'done', back: 1, already: 0 });
    const [back] = await m.t.services.db
      .select()
      .from(attachments)
      .where(eq(attachments.name, 'roofer-quote.txt'));
    expect(back).toMatchObject({ sha256: FILE_SHA, state: 'ready' });
    expect(await m.t.services.files.store.size(back?.blobKey ?? '')).toBe(FILE_BYTES.length);
  }, 120_000);
});
