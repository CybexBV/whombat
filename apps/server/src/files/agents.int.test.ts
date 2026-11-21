/**
 * Attachments and agents (docs/decisions/bp-attachments.md): the dispatch context lists only what the agent
 * may read, the runner fetch needs the live lease and re-checks the set, a provider gets verified bytes on
 * disk, and agents read text attachments and publish artifacts the person can open.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProvider, TurnEvent, TurnInput } from '@whombat/agent-runtime';
import { BASIC_CAPABILITIES } from '@whombat/agent-runtime';
import { type DispatchContext, runnerApi } from '@whombat/core';
import { createRunnerApi, type ProviderRegistry, Runner, testPolicy } from '@whombat/runner';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { dispatches, events, messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { makePng, upload } from '../test/files';
import { connectGitHubAs, signInsEnv } from '../test/github';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { makeRoom } from '../test/rooms';
import { waitFor } from '../test/runner';
import { SCRIPTED_ENV, scripted } from '../test/scripted';
import { agentTokenFor, sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, listen: true, env: { ...SCRIPTED_ENV, ...signInsEnv() } });
// Agents' git and gh run on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
beforeAll(() => connectGitHubAs(t.services, IDS.mara));
const RUNNER = { authorization: 'Bearer dev-runner-token' };
let mara: Record<string, string> = {};

beforeAll(async () => {
  Object.assign(t.services.runtime.options, { retryBackoffMs: 40, pollMs: 20 });
  mara = { cookie: (await sessionFor(t.services, IDS.mara)).cookie };
});

async function claim(runnerId: string): Promise<DispatchContext | null> {
  const res = await t.api.inject({
    method: 'POST',
    url: '/internal/runner/claim',
    headers: RUNNER,
    payload: { runnerId, providers: ['claude'], waitMs: 2000 },
  });
  expect(res.statusCode).toBe(200);
  return runnerApi.claim.response.parse(res.json()).dispatch;
}

async function complete(id: string, runnerId: string, attempt: number) {
  await t.api.inject({
    method: 'POST',
    url: `/internal/runner/dispatches/${id}/complete`,
    headers: RUNNER,
    payload: { outcome: 'done', runnerId, attempt },
  });
}

function fetchUrl(dispatchId: string, attachmentId: string, lease: Record<string, string | number> = {}) {
  const q = new URLSearchParams(Object.entries(lease).map(([k, v]) => [k, String(v)]));
  return `/internal/runner/dispatches/${dispatchId}/attachments/${attachmentId}${q.size ? `?${q}` : ''}`;
}

describe('the runner protocol', () => {
  const png = makePng(16, 16);
  const log = Buffer.from('boot ok\nERROR: VAT rounding off by 0.01\n');
  let ctx: DispatchContext;
  let imageId = '';
  let logId = '';
  let elsewhereId = '';
  let unsentId = '';

  it('lists only attachments on messages the agent reads in this dispatch', async () => {
    const elsewhere = await upload(t.api, mara, IDS.general, 'general.txt', Buffer.from('not for Dusty'));
    await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.general,
      text: 'in general',
      attachmentIds: [elsewhere.id],
    });
    elsewhereId = elsewhere.id;
    unsentId = (await upload(t.api, mara, IDS.billing, 'draft.txt', Buffer.from('not sent'))).id;
    const image = await upload(t.api, mara, IDS.billing, 'screen.png', png, 'image/png');
    const text = await upload(t.api, mara, IDS.billing, 'build.log', log);
    imageId = image.id;
    logId = text.id;
    const sent = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: '@Dusty what does the log say?',
      attachmentIds: [image.id, text.id],
    });
    expect(sent.status).toBe('ok');
    const claimed = await claim('rnr_files');
    expect(claimed).not.toBeNull();
    ctx = claimed as DispatchContext;
    expect(ctx.agent.handle).toBe('dusty');
    expect(ctx.attachments.map((a) => a.id).sort()).toEqual([image.id, text.id].sort());
    expect(ctx.attachments.find((a) => a.id === image.id)).toMatchObject({
      kind: 'image',
      contentType: 'image/png',
      width: 16,
      height: 16,
      conversationId: IDS.billing,
    });
    expect(ctx.attachments.map((a) => a.id)).not.toContain(elsewhereId);
    expect(ctx.attachments.map((a) => a.id)).not.toContain(unsentId);
  });

  it('fetching needs the runner token and the live lease, and only serves the dispatch’s set', async () => {
    const lease = { runnerId: 'rnr_files', attempt: ctx.dispatch.attempts ?? 1 };
    const ok = await t.api.inject({
      method: 'GET',
      url: fetchUrl(ctx.dispatch.id, imageId, lease),
      headers: RUNNER,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload.equals(png)).toBe(true);
    expect(ok.headers['x-whombat-sha256']).toBe(ctx.attachments.find((a) => a.id === imageId)?.sha256);
    expect(ok.headers['content-disposition']).toMatch(/^attachment;/);
    expect(
      (await t.api.inject({ method: 'GET', url: fetchUrl(ctx.dispatch.id, imageId, lease) })).statusCode,
    ).toBe(401);
    const stolen = await t.api.inject({
      method: 'GET',
      url: fetchUrl(ctx.dispatch.id, imageId, { runnerId: 'rnr_other', attempt: 1 }),
      headers: RUNNER,
    });
    expect(stolen.statusCode).toBe(409);
    for (const id of [elsewhereId, unsentId]) {
      const res = await t.api.inject({
        method: 'GET',
        url: fetchUrl(ctx.dispatch.id, id, lease),
        headers: RUNNER,
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('agents read text attachments of their dispatch a chunk at a time', async () => {
    const mcp = await mcpClient(t.baseUrl, ctx.agentToken.token);
    try {
      const first = await mcp.call('read_attachment', { attachmentId: logId, maxBytes: 8 });
      expect(first.body).toMatchObject({ status: 'ok', text: 'boot ok\n', offset: 0, nextOffset: 8 });
      const rest = await mcp.call('read_attachment', { attachmentId: logId, offset: 8 });
      expect(rest.body).toMatchObject({ text: 'ERROR: VAT rounding off by 0.01\n', nextOffset: null });
      const image = await mcp.call('read_attachment', { attachmentId: imageId });
      expect(image.body).toMatchObject({
        text: null,
        note: 'screen.png is an image; it can’t be read as text here.',
      });
      const other = await mcp.call('read_attachment', { attachmentId: elsewhereId });
      expect(other.isError).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  it('a finished turn can no longer fetch', async () => {
    const lease = { runnerId: 'rnr_files', attempt: ctx.dispatch.attempts ?? 1 };
    await complete(ctx.dispatch.id, 'rnr_files', lease.attempt);
    const gone = await t.api.inject({
      method: 'GET',
      url: fetchUrl(ctx.dispatch.id, imageId, lease),
      headers: RUNNER,
    });
    expect(gone.statusCode).toBe(409);
  });
});

/** A provider that records what it was given, reading the turn's files while they exist. */
class RecordingProvider implements AgentProvider {
  readonly kind = 'claude' as const;
  inputs: { input: TurnInput; bytes: Map<string, Buffer> }[] = [];
  capabilities() {
    return { ...BASIC_CAPABILITIES, images: true };
  }
  async available() {
    return { ok: true as const, version: 'test' };
  }
  async *runTurn(input: TurnInput): AsyncGenerator<TurnEvent> {
    const bytes = new Map<string, Buffer>();
    for (const a of input.attachments ?? []) bytes.set(a.id, await readFile(a.path));
    this.inputs.push({ input, bytes });
    yield { type: 'final', text: 'Seen it.' };
  }
}

describe('a provider turn with attachments', () => {
  it('gets verified bytes in a per-turn directory, removed after the turn', async () => {
    const provider = new RecordingProvider();
    const registry: ProviderRegistry = scripted({
      claims: () => ['claude'],
      for: () => provider,
      report: () => [],
    });
    const workspacesRoot = await mkdtemp(join(tmpdir(), 'whombat-files-ws-'));
    const runner = new Runner({
      api: createRunnerApi(t.baseUrl, 'dev-runner-token'),
      registry,
      managed: testPolicy(),
      serverUrl: t.baseUrl,
      workspacesRoot,
      concurrency: 1,
      waitMs: 300,
      heartbeatMs: 200,
      progressMs: 40,
    });
    const png = makePng(24, 12, [10, 20, 30]);
    const pdf = Buffer.from('%PDF-1.4\n% not really\n');
    const image = await upload(t.api, mara, IDS.incidents, 'error.png', png, 'image/png');
    const doc = await upload(t.api, mara, IDS.incidents, 'report.pdf', pdf);
    const notes = await upload(
      t.api,
      mara,
      IDS.incidents,
      'notes.md',
      Buffer.from('# Notes\nRestart the worker.\n'),
    );
    runner.start();
    try {
      const sent = await t.commit(IDS.mara, sendMessage, {
        conversationId: IDS.incidents,
        text: '@Dusty see these',
        attachmentIds: [image.id, doc.id, notes.id],
      });
      expect(sent.status).toBe('ok');
      const turn = await waitFor(() => provider.inputs[0], 10_000, 'the provider turn');
      const given = turn.input.attachments ?? [];
      expect(given.map((a) => a.id).sort()).toEqual([image.id, notes.id].sort());
      expect(turn.bytes.get(image.id)?.equals(png)).toBe(true);
      const path = given.find((a) => a.id === image.id)?.path ?? '';
      expect(path.startsWith(join(workspacesRoot, '.scratch'))).toBe(true);
      expect(turn.input.prompt).toContain(`${image.id} · error.png (image/png, `);
      expect(turn.input.prompt).toContain('attached to this message as an image you can see.');
      expect(turn.input.prompt).toContain(
        'report.pdf is attached; you can’t open PDFs here. Say so if it matters, and don’t guess what it contains.',
      );
      expect(turn.input.prompt).toContain(
        `----- begin attachment ${notes.id} (notes.md) -----\n# Notes\nRestart the worker.\n`,
      );
      await waitFor(async () => {
        const [row] = await t.services.db
          .select()
          .from(dispatches)
          .where(eq(dispatches.id, turn.input.context.dispatch.id));
        return row?.state === 'done';
      });
      // The runner removes the turn's files right after it reports the turn done.
      await waitFor(async () =>
        readFile(path).then(
          () => false,
          () => true,
        ),
      );
    } finally {
      await runner.stop(2000);
    }
  });
});

describe('agent artifacts', () => {
  it('an agent uploads a file into its own rooms, attaches it, and the person opens it', async () => {
    // A pull request's room nobody posted in: the person's, so the agent's too.
    const elsewhere = await makeRoom(t.services, t.burrowId, 'feat/elsewhere');
    const { token } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.general);
    const mcp = await mcpClient(t.baseUrl, token);
    try {
      const up = await mcp.call('upload_file', {
        conversationId: IDS.general,
        name: 'summary.md',
        text: '# Summary\nAll green.\n',
      });
      expect(up.body).toMatchObject({
        status: 'ok',
        attachment: { name: 'summary.md', kind: 'text', contentType: 'text/markdown' },
      });
      const attachmentId = up.body.attachmentId as string;
      const bin = await mcp.call('upload_file', {
        conversationId: IDS.general,
        name: 'dot.png',
        contentBase64: makePng(2, 2).toString('base64'),
      });
      expect(bin.body).toMatchObject({ status: 'ok', attachment: { kind: 'image', width: 2 } });
      const posted = await mcp.call('post_message', {
        conversationId: IDS.general,
        text: 'Summary attached.',
        attachmentIds: [attachmentId, bin.body.attachmentId],
      });
      expect(posted.body.status).toBe('ok');
      const url = (up.body.attachment as { url: string }).url;
      const got = await t.api.inject({ method: 'GET', url, headers: mara });
      expect(got.statusCode).toBe(200);
      expect(got.body).toBe('# Summary\nAll green.\n');
      const there = await mcp.call('upload_file', { conversationId: elsewhere, name: 'x.txt', text: 'hi' });
      expect(there.body).toMatchObject({ status: 'ok' });
      const nowhere = await mcp.call('upload_file', {
        conversationId: 'cnv_nowhere',
        name: 'x.txt',
        text: 'hi',
      });
      expect(nowhere.isError).toBe(true);
      const both = await mcp.call('upload_file', {
        conversationId: IDS.general,
        name: 'x.txt',
        text: 'a',
        contentBase64: 'YQ==',
      });
      expect(both.isError).toBe(true);
    } finally {
      await mcp.close();
    }
    const signed = await t.services.db.select().from(events).where(eq(events.actorId, IDS.dusty));
    expect(JSON.stringify(signed.map((e) => [e.text, e.payload]))).not.toContain('summary.md');
  });

  it('an SVG file and the same drawing in an svg block show once: the file (MS-D01)', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><polyline points="0,30 50,10 100,20" fill="none" stroke="#2563eb"/></svg>';
    const text = `Here’s the 24-hour CPU graph.\n\n\`\`\`svg\n${svg}\n\`\`\``;
    const { token } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.incidents);
    const mcp = await mcpClient(t.baseUrl, token);
    let messageId = '';
    let attachmentId = '';
    try {
      const up = await mcp.call('upload_file', {
        conversationId: IDS.incidents,
        name: 'cpu-24h.svg',
        text: svg,
      });
      expect(up.body).toMatchObject({ status: 'ok', attachment: { contentType: 'image/svg+xml' } });
      attachmentId = up.body.attachmentId as string;
      const posted = await mcp.call('post_message', {
        conversationId: IDS.incidents,
        text,
        attachmentIds: [attachmentId],
      });
      messageId = posted.body.messageId as string;
    } finally {
      await mcp.close();
    }
    const [row] = await t.services.db.select().from(messages).where(eq(messages.id, messageId));
    expect(row).toMatchObject({ text: 'Here’s the 24-hour CPU graph.', attachmentIds: [attachmentId] });

    // A person's message is kept as written.
    const own = await upload(t.api, mara, IDS.incidents, 'cpu-24h.svg', Buffer.from(svg), 'image/svg+xml');
    const sent = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.incidents,
      text,
      attachmentIds: [own.id],
    });
    if (sent.status !== 'ok') throw new Error('not sent');
    const [mine] = await t.services.db.select().from(messages).where(eq(messages.id, sent.result.id));
    expect(mine?.text).toBe(text);
  });
});
