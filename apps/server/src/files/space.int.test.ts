/**
 * A conversation's Files end to end (docs/decisions/files-space.md FS-01…FS-08, FS-11, FS-14…FS-18): saving an upload
 * straight into Files, the summary and listing the person sees, rename/move/remove rules, what message deletes and
 * channel clears do, `files.changed` to the person, what an agent in a turn may list, fetch and read, and Save to Files
 * on a message's file (an agent's file is in the person's Files only then).
 */
import { api, type DispatchContext, endpointUrl } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { deleteMessage } from '../commands/message-edits';
import { sendMessage } from '../commands/messages';
import { attachments, dispatches } from '../db/schema/index';
import { loadMessage } from '../read/messages';
import type { BusFrame } from '../realtime/bus';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { BURROW, makePng, upload } from '../test/files';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { agentTokenFor, sessionFor } from '../test/tokens';
import { saveFile } from './space-commands';

const t = useTestServer({ seed: true, listen: true });
const auth: Record<string, Record<string, string>> = {};
const who = (name: string) => auth[name] as Record<string, string>;
const frames: BusFrame[] = [];

beforeAll(async () => {
  auth.mara = { cookie: (await sessionFor(t.services, IDS.mara)).cookie };
  t.services.bus.onFrame((f) => frames.push(f));
});

const B = { burrow: BURROW };

async function save(as: string, attachmentId: string, folder?: string) {
  return t.api.inject({
    method: 'POST',
    url: endpointUrl(api.files.save, B),
    headers: who(as),
    payload: { attachmentId, ...(folder !== undefined ? { folder } : {}) },
  });
}

async function list(as: string, conversationId: string, query: Record<string, string | number> = {}) {
  return t.api.inject({
    method: 'GET',
    url: endpointUrl(api.files.list, { ...B, conversationId }, query),
    headers: who(as),
  });
}

async function summary(as: string) {
  const res = await t.api.inject({ method: 'GET', url: endpointUrl(api.files.summary, B), headers: who(as) });
  expect(res.statusCode).toBe(200);
  return res.json().conversations as { conversationId: string; count: number; bytes: number }[];
}

async function update(as: string, attachmentId: string, body: Record<string, unknown>) {
  return t.api.inject({
    method: 'PATCH',
    url: endpointUrl(api.files.update, { ...B, attachmentId }),
    headers: who(as),
    payload: body,
  });
}

async function remove(as: string, attachmentId: string) {
  return t.api.inject({
    method: 'DELETE',
    url: endpointUrl(api.files.remove, { ...B, attachmentId }),
    headers: who(as),
  });
}

/** `files.changed` frames for a conversation since `from`, by recipient. */
function changedFor(conversationId: string, from: number): string[] {
  return frames
    .slice(from)
    .filter((f) => f.event.type === 'files.changed' && f.event.conversationId === conversationId)
    .map((f) => f.topic.replace(/^me:/, ''))
    .sort();
}

const ids = (res: { json(): { files: { attachment: { id: string } }[] } }) =>
  res.json().files.map((f) => f.attachment.id);

describe('Files for the person', () => {
  let drawing = '';
  let photo = '';
  let sentLog = '';

  it('saves an upload straight into Files and tells the person', async () => {
    expect(await summary('mara')).toEqual([]);
    const att = await upload(
      t.api,
      who('mara'),
      IDS.billing,
      '1904Technischmodel.skp',
      Buffer.from('skp bytes'),
    );
    drawing = att.id;
    const from = frames.length;
    const res = await save('mara', drawing, 'Drawings');
    expect(res.statusCode).toBe(200);
    expect(res.json().file).toMatchObject({
      attachment: { id: drawing, name: '1904Technischmodel.skp' },
      conversationId: IDS.billing,
      folder: 'Drawings',
      uploadedById: IDS.mara,
      messageId: null,
      threadRootId: null,
    });
    // The person in #billing-v2 (agents have no `me` subscriptions), nobody else.
    expect(changedFor(IDS.billing, from)).toEqual([IDS.mara]);
    // Saving again is a retry: it ends where it is.
    expect((await save('mara', drawing, 'Other')).json().file.folder).toBe('Drawings');
  });

  it('shows the file and its folder', async () => {
    expect(await summary('mara')).toEqual([
      expect.objectContaining({ conversationId: IDS.billing, count: 1, bytes: 9 }),
    ]);
    const listed = await list('mara', IDS.billing);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().files[0]).toMatchObject({ folder: 'Drawings' });
    const url = `/api/v1/burrows/${BURROW}/attachments/${drawing}`;
    expect((await t.api.inject({ method: 'GET', url, headers: who('mara') })).statusCode).toBe(200);
  });

  it('lists a sent message’s files newest first and pages through them', async () => {
    const log = await upload(t.api, who('mara'), IDS.billing, 'build.log', Buffer.from('ok\n'));
    sentLog = log.id;
    const from = frames.length;
    await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: 'log',
      attachmentIds: [log.id],
    });
    expect(changedFor(IDS.billing, from)).toContain(IDS.mara);
    photo = (await upload(t.api, who('mara'), IDS.billing, 'pool.txt', Buffer.from('pool'))).id;
    expect((await save('mara', photo, 'drawings/Pool')).json().file.folder).toBe('Drawings/Pool');
    const first = await list('mara', IDS.billing, { limit: 2 });
    expect(ids(first)).toEqual([photo, sentLog]);
    const entry = first.json().files[1];
    expect(entry.messageId).not.toBeNull();
    const next = await list('mara', IDS.billing, { limit: 2, cursor: first.json().nextCursor });
    expect(ids(next)).toEqual([drawing]);
    expect(next.json().nextCursor).toBeNull();
    expect((await list('mara', IDS.billing, { cursor: 'bogus' })).statusCode).toBe(400);
  });

  it('lets the uploader rename and move; a message’s file keeps its name', async () => {
    const renamed = await update('mara', drawing, { name: '../pool.skp', folder: 'drawings' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().file).toMatchObject({ attachment: { name: 'pool.skp' }, folder: 'Drawings' });
    expect((await update('mara', sentLog, { name: 'renamed.log' })).statusCode).toBe(403);
    const moved = await update('mara', sentLog, { folder: 'Logs' });
    expect(moved.json().file).toMatchObject({ folder: 'Logs', attachment: { name: 'build.log' } });
    expect((await update('mara', sentLog, { folder: '../x' })).statusCode).toBe(400);
  });

  it('removes a message’s file from Files only, and deletes a file saved straight into Files', async () => {
    expect((await remove('mara', sentLog)).statusCode).toBe(200);
    expect(ids(await list('mara', IDS.billing))).not.toContain(sentLog);
    // The message keeps it.
    const onMessage = `/api/v1/burrows/${BURROW}/attachments/${sentLog}`;
    expect((await t.api.inject({ method: 'GET', url: onMessage, headers: who('mara') })).statusCode).toBe(
      200,
    );

    expect((await remove('mara', drawing)).statusCode).toBe(200);
    const [row] = await t.services.db.select().from(attachments).where(eq(attachments.id, drawing));
    expect(row).toMatchObject({ state: 'deleted', blobKey: null, filesRemovedById: IDS.mara });
    const gone = `/api/v1/burrows/${BURROW}/attachments/${drawing}`;
    expect((await t.api.inject({ method: 'GET', url: gone, headers: who('mara') })).statusCode).toBe(404);
    expect((await remove('mara', drawing)).statusCode).toBe(404);
    await t.services.files.sweep();
    expect(await t.services.db.select().from(attachments).where(eq(attachments.id, drawing))).toEqual([]);
  });

  it('keeps a file saved into Files and later sent when its message is deleted', async () => {
    const kept = (await upload(t.api, who('mara'), IDS.billing, 'kept.txt', Buffer.from('kept'))).id;
    await save('mara', kept);
    const posted = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: 'both',
      attachmentIds: [kept],
    });
    if (posted.status !== 'ok') throw new Error('send failed');
    const listed = (await list('mara', IDS.billing))
      .json()
      .files.find((f: { attachment: { id: string } }) => f.attachment.id === kept);
    expect(listed).toMatchObject({ messageId: posted.result.id });
    const from = frames.length;
    await t.commit(IDS.mara, deleteMessage, { messageId: posted.result.id });
    expect(changedFor(IDS.billing, from)).toContain(IDS.mara);
    const after = (await list('mara', IDS.billing))
      .json()
      .files.find((f: { attachment: { id: string } }) => f.attachment.id === kept);
    expect(after).toMatchObject({ messageId: null });
  });

  it('in a DM the person tidies', async () => {
    const att = (await upload(t.api, who('mara'), IDS.dmDusty, 'dm.txt', Buffer.from('dm'))).id;
    const res = await save('mara', att, 'a/b/c/d');
    expect(res.json().file).toMatchObject({ folder: 'a/b/c/d' });
    expect((await save('mara', att, 'a/b/c/d/e')).statusCode).toBe(400);
  });
});

describe('Files for agents', () => {
  let billingFile = '';
  let generalFile = '';

  async function contextFor(agentId: string, conversationId: string, options = {}) {
    const { dispatchId } = await agentTokenFor(t.services, t.burrowId, agentId, conversationId, options);
    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    if (!row) throw new Error('no dispatch');
    return { ctx: (await buildDispatchContext(t.services, row)) as DispatchContext, dispatchId };
  }

  it('lists only the turn conversation’s Files, fetchable by the runner', async () => {
    billingFile = (
      await upload(t.api, who('mara'), IDS.billing, 'notes.md', Buffer.from('# Pool\n12 x 4 m\n'))
    ).id;
    await save('mara', billingFile, 'Specs');
    generalFile = (await upload(t.api, who('mara'), IDS.general, 'general.txt', Buffer.from('no'))).id;
    await save('mara', generalFile);
    const { ctx, dispatchId } = await contextFor(IDS.dusty, IDS.billing);
    expect(ctx.files).toMatchObject({ conversationId: IDS.billing, truncated: false });
    const listed = ctx.files?.entries.map((e) => e.id) ?? [];
    expect(listed).toContain(billingFile);
    expect(listed).not.toContain(generalFile);
    expect(ctx.files?.count).toBe(listed.length);
    expect(ctx.files?.entries.find((e) => e.id === billingFile)).toMatchObject({
      folder: 'Specs',
      messageId: null,
    });

    // The runner that holds the turn fetches with its lease (a fencing token, MSB-10).
    await t.services.db
      .update(dispatches)
      .set({ runnerId: 'rnr_files', attempts: 1 })
      .where(eq(dispatches.id, dispatchId));
    const RUNNER = { authorization: 'Bearer dev-runner-token' };
    const fetch = (id: string) =>
      t.api.inject({
        method: 'GET',
        url: `/internal/runner/dispatches/${dispatchId}/attachments/${id}?runnerId=rnr_files&attempt=1`,
        headers: RUNNER,
      });
    const got = await fetch(billingFile);
    expect(got.statusCode, got.body).toBe(200);
    expect(got.rawPayload.toString()).toBe('# Pool\n12 x 4 m\n');
    // Dusty is in #general too, but this turn is in #billing-v2.
    expect((await fetch(generalFile)).statusCode).toBe(404);
  });

  it('gives search answers and assessments no Files', async () => {
    const search = await contextFor(IDS.dusty, IDS.billing, {
      mode: 'answer',
      search: { query: 'pool', answerId: 'ans_none' },
    });
    expect(search.ctx.files ?? null).toBeNull();
  });

  it('list_files, read_attachment, and upload_file no longer saves into Files (FS-18)', async () => {
    // Building the context issues the turn's token.
    const { ctx } = await contextFor(IDS.dusty, IDS.billing);
    const mcp = await mcpClient(t.baseUrl, ctx.agentToken.token);
    try {
      const all = await mcp.call('list_files', {});
      expect(all.isError).toBe(false);
      const names = (all.body.files as { attachmentId: string; uploadedBy: string }[]).map(
        (f) => f.attachmentId,
      );
      expect(names).toContain(billingFile);
      expect(names).not.toContain(generalFile);
      const specs = await mcp.call('list_files', { folder: 'specs' });
      expect(specs.body.files).toEqual([
        expect.objectContaining({ attachmentId: billingFile, folder: 'Specs', uploadedBy: 'Mara Okafor' }),
      ]);
      const read = await mcp.call('read_attachment', { attachmentId: billingFile });
      expect(read.body).toMatchObject({ text: '# Pool\n12 x 4 m\n' });
      const other = await mcp.call('read_attachment', { attachmentId: generalFile });
      expect(other.isError).toBe(true);

      // An older runner's `saveToFiles` is dropped: the file waits to be attached, Files are untouched.
      const from = frames.length;
      const up = await mcp.call('upload_file', {
        conversationId: IDS.billing,
        name: 'pool-size.txt',
        text: 'The pool is 12 × 4 m.',
        saveToFiles: true,
        folder: 'specs/Results',
      });
      expect(up.body.status).toBe('ok');
      const id = up.body.attachmentId as string;
      expect(changedFor(IDS.billing, from)).toEqual([]);
      expect(ids(await list('mara', IDS.billing))).not.toContain(id);
      const [row] = await t.services.db.select().from(attachments).where(eq(attachments.id, id));
      expect(row).toMatchObject({ filedAt: null, messageId: null, folder: '' });
    } finally {
      await mcp.close();
    }
  });
});

describe('Save to Files (FS-14…FS-17)', () => {
  let render = '';
  let renderMessage = '';

  const inFilesOn = async (messageId: string) =>
    (await loadMessage(t.services.db, messageId, IDS.mara))?.attachments.map((a) => a.inFiles);
  /** `message.updated` frames for a message since `from`: its files' `inFiles`. */
  const updatesOf = (messageId: string, from: number) =>
    frames
      .slice(from)
      .flatMap((f) =>
        f.event.type === 'message.updated' && f.event.message.id === messageId
          ? [f.event.message.attachments.map((a) => a.inFiles)]
          : [],
      );

  it('an agent’s posted file isn’t in the person’s Files, agents still reach it', async () => {
    const { token, dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
    const mcp = await mcpClient(t.baseUrl, token);
    try {
      const up = await mcp.call('upload_file', {
        conversationId: IDS.billing,
        name: 'render.png',
        contentBase64: makePng(4, 3).toString('base64'),
      });
      render = up.body.attachmentId as string;
      const from = frames.length;
      const posted = await mcp.call('post_message', {
        conversationId: IDS.billing,
        text: 'The render.',
        attachmentIds: [render],
      });
      renderMessage = posted.body.messageId as string;
      expect(changedFor(IDS.billing, from)).toEqual([]);
    } finally {
      await mcp.close();
    }
    expect(ids(await list('mara', IDS.billing))).not.toContain(render);
    expect(await inFilesOn(renderMessage)).toEqual([false]);
    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    const ctx = (await buildDispatchContext(
      t.services,
      row as typeof dispatches.$inferSelect,
    )) as DispatchContext;
    expect(ctx.files?.entries.map((e) => e.id)).toContain(render);
  });

  it('the person saves it; it stays on its message', async () => {
    const from = frames.length;
    const res = await save('mara', render, 'renders');
    expect(res.statusCode).toBe(200);
    expect(res.json().file).toMatchObject({
      attachment: { id: render, name: 'render.png' },
      folder: 'renders',
      uploadedById: IDS.dusty,
      messageId: renderMessage,
    });
    expect(changedFor(IDS.billing, from)).toEqual([IDS.mara]);
    expect(updatesOf(renderMessage, from)).toEqual([[true]]);
    expect(await inFilesOn(renderMessage)).toEqual([true]);
    expect(ids(await list('mara', IDS.billing))).toContain(render);
    // Saving again answers it as it is.
    const again = frames.length;
    expect((await save('mara', render, 'Other')).json().file.folder).toBe('renders');
    expect(frames.slice(again).filter((f) => f.event.type === 'message.updated')).toEqual([]);
  });

  it('agents can’t save a message’s file', async () => {
    await expect(t.commit(IDS.dusty, saveFile, { attachmentId: render, folder: '' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('removing an agent’s file only un-saves it', async () => {
    const from = frames.length;
    expect((await remove('mara', render)).statusCode).toBe(200);
    expect(updatesOf(renderMessage, from)).toEqual([[false]]);
    const [row] = await t.services.db.select().from(attachments).where(eq(attachments.id, render));
    expect(row).toMatchObject({ state: 'ready', filedAt: null, filedById: null, filesRemovedAt: null });
    expect(ids(await list('mara', IDS.billing))).not.toContain(render);
    expect(await inFilesOn(renderMessage)).toEqual([false]);
  });

  it('a person’s file removed from Files comes back with Save to Files', async () => {
    const shared = (await upload(t.api, who('mara'), IDS.billing, 'quote.txt', Buffer.from('quote'))).id;
    const posted = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: 'quote',
      attachmentIds: [shared],
    });
    if (posted.status !== 'ok') throw new Error('send failed');
    expect(await inFilesOn(posted.result.id)).toEqual([true]);
    const from = frames.length;
    expect((await remove('mara', shared)).statusCode).toBe(200);
    expect(updatesOf(posted.result.id, from)).toEqual([[false]]);
    expect((await save('mara', shared)).statusCode).toBe(200);
    expect(await inFilesOn(posted.result.id)).toEqual([true]);
    const [row] = await t.services.db.select().from(attachments).where(eq(attachments.id, shared));
    expect(row).toMatchObject({ filesRemovedAt: null, filesRemovedById: null, filedById: IDS.mara });
  });

  it('a saved agent’s file stays in Files when its message is deleted', async () => {
    await save('mara', render);
    await t.commit(IDS.mara, deleteMessage, { messageId: renderMessage });
    const entry = (await list('mara', IDS.billing))
      .json()
      .files.find((f: { attachment: { id: string } }) => f.attachment.id === render);
    expect(entry).toMatchObject({ messageId: null, uploadedById: IDS.dusty });
  });
});
