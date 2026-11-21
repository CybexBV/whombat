/**
 * `show_pages` end to end (docs/decisions/page-sets.md): the tool asks the turn's runner for the folder, the runner's
 * PUT of the set's bytes is checked and kept as the agent's file with its thumbnail, the agent posts it, and a set shown
 * again with `replaces` takes the earlier one's place on its message. Needs Postgres: the file is a row the commit
 * pipeline writes and the message it lands on.
 */
import {
  PAGES_CONTENT_TYPE,
  PAGES_COVER,
  PAGES_MANIFEST,
  type PageSetManifest,
  type PreviewRequest,
  zipStored,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { previewsFor } from '../browser/previews';
import { attachments, dispatches, messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { makePng } from '../test/files';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { SCRIPTED_ENV } from '../test/scripted';
import { agentTokenFor } from '../test/tokens';

const t = useTestServer({ seed: true, listen: true, env: { ...SCRIPTED_ENV } });
const RUNNER = { authorization: 'Bearer dev-runner-token' };
const LEASE = { runnerId: 'rnr_pages', attempt: 1 };

/** A set as the runner packs it: the folder's files, the cover, the manifest last. */
function pageSet(title: string, extra: Partial<PageSetManifest> = {}): Buffer {
  const files = [
    { path: 'index.html', bytes: Buffer.from('<a href="round-2/">Round 2</a>') },
    { path: 'round-2/index.html', bytes: Buffer.from('<img src="shot.png">') },
  ];
  const manifest: PageSetManifest = {
    v: 1,
    title,
    open: 'index.html',
    files: files.length,
    pages: 2,
    cover: true,
    problems: ['round-2/index.html: shot.png isn’t in the folder.'],
    ...extra,
  };
  const parts = zipStored([
    ...files,
    { path: PAGES_COVER, bytes: makePng(1280, 800) },
    { path: PAGES_MANIFEST, bytes: Buffer.from(JSON.stringify(manifest)) },
  ]);
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

/** The request the runner hears on its beat, once the tool asked. */
async function asked(dispatchId: string): Promise<PreviewRequest> {
  for (let i = 0; i < 200; i++) {
    const [request] = previewsFor(t.services).forRunner(dispatchId);
    if (request) return request;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the tool never asked the runner');
}

/** A turn of Dusty's in #general that a runner holds (the PUT needs its lease). */
async function turn() {
  const made = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.general);
  await t.services.db
    .update(dispatches)
    .set({ runnerId: LEASE.runnerId, attempts: LEASE.attempt })
    .where(eq(dispatches.id, made.dispatchId));
  return made;
}

function put(dispatchId: string, previewId: string, body: Buffer) {
  return t.api.inject({
    method: 'PUT',
    url: `/internal/runner/dispatches/${dispatchId}/previews/${previewId}/pages?runnerId=${LEASE.runnerId}&attempt=${LEASE.attempt}`,
    headers: { ...RUNNER, 'content-type': 'application/zip' },
    payload: body,
  });
}

async function show(mcp: TestMcp, dispatchId: string, args: Record<string, unknown>, body: Buffer) {
  const call = mcp.call('show_pages', args);
  const request = await asked(dispatchId);
  const res = await put(dispatchId, request.id, body);
  return { request, put: res, result: await call };
}

describe('show_pages', () => {
  it('keeps the runner’s set as the agent’s file with its cover, and replaces it in place', async () => {
    const { token, dispatchId } = await turn();
    const mcp = await mcpClient(t.baseUrl, token);
    try {
      const first = await show(
        mcp,
        dispatchId,
        { folder: 'mockups', title: 'Council mockups' },
        pageSet('Council mockups'),
      );
      expect(first.request).toMatchObject({
        dir: 'mockups',
        pages: { open: 'index.html', title: 'Council mockups' },
        render: { path: '/index.html', online: false },
      });
      expect(first.put.statusCode).toBe(200);
      expect(first.result.isError).toBe(false);
      expect(first.result.body).toMatchObject({
        status: 'ok',
        name: 'Council mockups.zip',
        files: 2,
        pages: 2,
        problems: [expect.stringContaining('shot.png')],
      });
      const firstId = first.result.body.attachmentId as string;
      const [row] = await t.services.db.select().from(attachments).where(eq(attachments.id, firstId));
      expect(row).toMatchObject({
        contentType: PAGES_CONTENT_TYPE,
        kind: 'file',
        state: 'ready',
        messageId: null,
      });
      expect(row?.thumbnailWidth).toBe(720);
      expect(row?.thumbnailHeight).toBe(450);

      const posted = await mcp.call('post_message', {
        conversationId: IDS.general,
        text: 'Here are the mockups.',
        attachmentIds: [firstId],
      });
      expect(posted.body.status).toBe('ok');
      const messageId = posted.body.messageId as string;

      const second = await show(
        mcp,
        dispatchId,
        { folder: 'mockups', title: 'Council mockups, round 2', replaces: firstId },
        pageSet('Council mockups, round 2', { problems: [] }),
      );
      expect(second.result.body).toMatchObject({ status: 'ok', messageId, problems: [] });
      const secondId = second.result.body.attachmentId as string;
      const [message] = await t.services.db.select().from(messages).where(eq(messages.id, messageId));
      expect(message?.attachmentIds).toEqual([secondId]);
      expect(await t.services.db.select().from(attachments).where(eq(attachments.id, firstId))).toEqual([]);

      // Only the agent's own set on a message of this conversation is replaced.
      const third = await mcp.call('show_pages', { folder: 'mockups', title: 'Again', replaces: firstId });
      expect(third.body).toMatchObject({
        status: 'refused',
        reason: expect.stringContaining('isn’t a set of pages'),
      });
      expect(previewsFor(t.services).forRunner(dispatchId)).toEqual([]);
    } finally {
      await mcp.close();
    }
  });

  it('says why when the runner sends something that isn’t a set, and refuses a PUT nobody waits for', async () => {
    const { token, dispatchId } = await turn();
    const mcp = await mcpClient(t.baseUrl, token);
    try {
      const bad = await show(mcp, dispatchId, { folder: 'x', title: 'X' }, Buffer.from('not a zip at all'));
      expect(bad.result.isError).toBe(true);
      expect(bad.result.body).toMatchObject({
        status: 'refused',
        reason: expect.stringContaining('isn’t a page set'),
      });
      expect((await put(dispatchId, 'pvw_nobodywaits1', pageSet('X'))).statusCode).toBe(404);
      const refused = await mcp.call('show_pages', { folder: 'x', title: 'X', open: '../outside.html' });
      expect(refused.body).toMatchObject({ status: 'refused' });
    } finally {
      await mcp.close();
    }
  });
});
