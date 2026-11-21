/**
 * The collaboration server end to end: headless Yjs clients (the Hocuspocus provider the web editor uses) against
 * the collaboration service on a real server and database (through a loopback transport standing in for a session's
 * collab stream, `test/collab.ts`) — auth, convergence, persistence across a restart, awareness, the plan block round
 * trip, agent edits over MCP, comment anchors and search.
 */
import { anchorForQuote, planStepsFromDoc, resolveAnchor } from '@whombat/canvas-schema';
import { api, buildPath, collabDocumentName } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { buildApp } from '../app';
import { addCanvasComment, createCanvas, resolveCanvasComment } from '../commands/content';
import { updatePlanStep } from '../commands/plans';
import { loadConfig } from '../config';
import { canvases, canvasUpdates, events } from '../db/schema/index';
import { MemoryMailer } from '../mail/mailer';
import { loadPlan } from '../read/work';
import { loadSeedWorld } from '../seed/load';
import { IDS, TEST_BURROW_ID, testWorld } from '../seed/test-world';
import { createServices, type Services } from '../services';
import { inProcessApi } from '../test/api';
import {
  type CollabClientOptions,
  type CollabTransport,
  collabClient,
  collabTransport,
  eventually,
  type TestCollabClient,
} from '../test/collab';
import { createTestDb, type TestDb } from '../test/db';
import { logServerErrors, testLogger } from '../test/log';
import { mcpClient } from '../test/mcp';
import { agentTokenFor, sessionFor } from '../test/tokens';

const SLUG = 'invoice-pdf-export-plan';
const CANVAS_ID = 'cvs_invoice-pdf-plan';
const PLAN_ID = 'pln_invoice-pdf';

let testDb: TestDb & { drop: () => Promise<void> };
let services: Services;
let app: FastifyInstance;
let baseUrl = '';
let transport: CollabTransport;
const caller = inProcessApi(
  () => services,
  () => app,
);
const clients: TestCollabClient[] = [];
const cookies = new Map<string, string>();

async function start() {
  const config = loadConfig({ DATABASE_URL: testDb.url, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  services = createServices({
    config,
    sql: testDb.sql,
    mailer: new MemoryMailer(),
    log: testLogger(),
    collab: { storeDebounceMs: 40, storeMaxDebounceMs: 150, writingMs: 400, presenceMs: 3000, indexMs: 30 },
  });
  app = await buildApp({ services, logger: false });
  logServerErrors(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address && typeof address === 'object') baseUrl = `http://127.0.0.1:${address.port}`;
  transport = await collabTransport(services.collab);
}

async function stop() {
  for (const c of clients.splice(0)) c.close();
  await transport.close();
  await app.close();
  services.typing.close();
}

let pendingDb: ReturnType<typeof createTestDb> | undefined;

beforeAll(async () => {
  pendingDb = createTestDb();
  testDb = await pendingDb;
  await start();
  await loadSeedWorld(services, testWorld());
});

afterAll(async () => {
  if (app) await stop();
  // Also when beforeAll failed or timed out: drop the database once it exists.
  await (await pendingDb?.catch(() => undefined))?.drop();
});

async function cookieOf(principalId: string) {
  let cookie = cookies.get(principalId);
  if (!cookie) {
    cookie = (await sessionFor(services, principalId)).cookie;
    cookies.set(principalId, cookie);
  }
  return cookie;
}

async function tokenFor(principalId: string, slug = SLUG) {
  const ep = api.canvases.collabToken;
  const res = await caller.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', slug })}`,
    headers: { cookie: await cookieOf(principalId) },
  });
  return { status: res.statusCode, body: res.json() as Record<string, string> };
}

async function join(principalId: string, extra: Partial<CollabClientOptions> = {}) {
  const { body } = await tokenFor(principalId);
  const client = await collabClient(transport, {
    token: body.token as string,
    documentName: body.documentName as string,
    ...extra,
  });
  clients.push(client);
  return client;
}

async function stored() {
  const [row] = await services.db.select().from(canvases).where(eq(canvases.id, CANVAS_ID));
  if (!row) throw new Error('no canvas');
  return row;
}

async function signed(type: string, actorId: string) {
  return services.db
    .select()
    .from(events)
    .where(and(eq(events.type, type), eq(events.actorId, actorId)));
}

describe('collab tokens and auth', () => {
  it('issues a short-lived token for members of the canvas conversation', async () => {
    const { status, body } = await tokenFor(IDS.mara);
    expect(status).toBe(200);
    expect(body).toMatchObject({ documentName: collabDocumentName(CANVAS_ID), url: '/collab' });
    expect(body.token).toMatch(/^wct_/);
    expect(new Date(body.expiresAt as string).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  });

  it('rejects bad, forged, expired and misdirected tokens', async () => {
    const good = (await tokenFor(IDS.mara)).body;
    const tampered = `${(good.token as string).slice(0, -3)}AAA`;
    await expect(
      collabClient(transport, { token: tampered, documentName: collabDocumentName(CANVAS_ID) }),
    ).rejects.toThrow(/authentication failed/);
    await expect(
      collabClient(transport, {
        token: good.token as string,
        documentName: collabDocumentName('cvs_service-map'),
      }),
    ).rejects.toThrow(/authentication failed/);
    const expired = services.collab.tokens.issue(
      { c: CANVAS_ID, b: TEST_BURROW_ID, p: IDS.mara, d: null },
      new Date(Date.now() - 10 * 60_000),
    );
    await expect(
      collabClient(transport, { token: expired.token, documentName: collabDocumentName(CANVAS_ID) }),
    ).rejects.toThrow(/authentication failed/);
  });
});

describe('the seeded document', () => {
  it('opens with its content, the plan block bound to the Plan and re-anchored comments', async () => {
    const mara = await join(IDS.mara);
    expect(mara.text()).toContain('Goal: PDF invoices by 14 Oct.');
    const steps = planStepsFromDoc(mara.read(), PLAN_ID);
    expect(steps?.map((s) => [s.stepId, s.state])).toEqual([
      ['stp_pdf-1', 'done'],
      ['stp_pdf-2', 'active'],
      ['stp_pdf-3', 'active'],
      ['stp_pdf-4', 'gate'],
    ]);
    const detail = await caller.inject({
      method: 'GET',
      url: `/api/v1/burrows/burrow-hq/canvases/${SLUG}`,
      headers: { cookie: await cookieOf(IDS.mara) },
    });
    const [thread] = detail.json().comments as {
      id: string;
      anchor: { relativePosition: string; quote: string };
    }[];
    expect(thread?.anchor.quote).toBe('round per line');
    expect(resolveAnchor(mara.doc, thread?.anchor as never)).toMatchObject({ intact: true });
    // Mara is on the canvas now.
    expect(detail.json().presentIds).toContain(IDS.mara);
  });
});

describe('two clients', () => {
  it('converge through the server, and each author’s edits are stored, signed and credited', async () => {
    const mara = await join(IDS.mara);
    const other = await join(IDS.mara);
    mara.edit([{ op: 'append', markdown: 'Mara was here.' }]);
    other.edit([{ op: 'replace', find: 'PDF invoices by 14 Oct.', markdown: 'PDF invoices by 14 October.' }]);
    await eventually(() => {
      expect(mara.text()).toContain('PDF invoices by 14 October.');
      expect(other.text()).toContain('Mara was here.');
      expect(mara.text()).toBe(other.text());
    });
    await eventually(async () => {
      expect((await signed('canvas.edited', IDS.mara)).length).toBeGreaterThan(0);
    });
    const [edit] = await signed('canvas.edited', IDS.mara);
    expect(edit).toMatchObject({ text: null, kind: 'Messages' });
    expect(edit?.payload).toMatchObject({
      canvasId: CANVAS_ID,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const row = await stored();
    // "edited by …": most recent editor first; Dusty drafted it and is named apart.
    expect(row.provenance.editorIds[0]).toBe(IDS.mara);
    expect(row.markdown).toContain('Mara was here.');
  });

  it('relays awareness with the identity the server knows, not the one a client claims', async () => {
    const mara = await join(IDS.mara);
    const other = await join(IDS.mara);
    mara.provider.setAwarenessField('user', { principalId: IDS.dusty, name: 'Dusty', kind: 'person' });
    mara.provider.setAwarenessField('writing', true);
    await eventually(() => {
      const peer = other.peers().find((p) => (p.user as { principalId?: string })?.principalId === IDS.mara);
      expect(peer).toMatchObject({ writing: true, user: { name: 'Mara Okafor', kind: 'person' } });
      expect(other.peers().some((p) => (p.user as { principalId?: string })?.principalId === IDS.dusty)).toBe(
        false,
      );
    });
  });

  it('strips a forged collabUser field instead of relaying it to other clients', async () => {
    // collaborators() (apps/web/.../canvas/collab/users.ts) reads `state.collabUser ?? state.user`, so a
    // client publishing an unstamped `collabUser` alongside the real (server-stamped) `user` is a way to
    // impersonate another principal and inject arbitrary CSS through the forged `color`.
    const mara = await join(IDS.mara);
    const other = await join(IDS.mara);
    mara.provider.setAwarenessField('collabUser', {
      principalId: IDS.dusty,
      name: 'Dusty',
      kind: 'person',
      role: null,
      color: 'red; background:url(https://evil/beacon)',
    });
    mara.provider.setAwarenessField('writing', true);
    await eventually(() => {
      const peer = other.peers().find((p) => (p.user as { principalId?: string })?.principalId === IDS.mara);
      expect(peer).toMatchObject({ writing: true, user: { name: 'Mara Okafor', kind: 'person' } });
      expect(peer && 'collabUser' in peer).toBe(false);
      expect(other.peers().some((p) => (p.user as { principalId?: string })?.principalId === IDS.dusty)).toBe(
        false,
      );
    });
  });
});

describe('persistence', () => {
  it('survives a restart and compacts updates into the snapshot', async () => {
    const mara = await join(IDS.mara);
    mara.edit([{ op: 'append', markdown: 'Written before the restart.' }]);
    await eventually(async () => expect((await stored()).markdown).toContain('Written before the restart.'));
    await stop();
    // Documents unloaded on shutdown are compacted.
    await eventually(async () => {
      const rows = await services.db
        .select()
        .from(canvasUpdates)
        .where(eq(canvasUpdates.canvasId, CANVAS_ID));
      expect(rows.length).toBe(0);
    });
    await start();
    const again = await join(IDS.mara);
    expect(again.text()).toContain('Written before the restart.');
    expect(again.text()).toContain('Mara was here.');
  });
});

describe('plan block (11.2)', () => {
  it('follows step changes from the pipeline', async () => {
    const mara = await join(IDS.mara);
    const res = await services.pipeline.commit(
      updatePlanStep,
      { planId: PLAN_ID, stepId: 'stp_pdf-2', state: 'done' },
      { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
    );
    expect(res.status).toBe('ok');
    await eventually(() =>
      expect(planStepsFromDoc(mara.read(), PLAN_ID)?.[1]).toMatchObject({
        stepId: 'stp_pdf-2',
        state: 'done',
      }),
    );
  });

  it('turns edits to the block into Plan changes, signed by the editor', async () => {
    const editor = await join(IDS.mara);
    // What the editor does when someone retypes step 3 and adds a line to the block.
    editor.write((doc) => {
      const json = doc.toJSON();
      const blockJson = json.content.find(
        (n: { type: string; attrs?: { planId?: string } }) =>
          n.type === 'planBlock' && n.attrs?.planId === PLAN_ID,
      );
      blockJson.content[2].content = [{ type: 'text', text: 'Review against the brief and the rules' }];
      blockJson.content.push({
        type: 'planStep',
        attrs: { stepId: null, ownerId: null, state: 'queued', stateLabel: 'Queued' },
        content: [{ type: 'text', text: 'Check the Dutch copy' }],
      });
      return doc.type.schema.nodeFromJSON(json);
    });
    await eventually(async () => {
      const plan = await loadPlan(services.db, PLAN_ID);
      expect(plan?.steps.map((s) => s.title)).toEqual([
        'Pick a PDF library',
        'Build the export endpoint',
        'Review against the brief and the rules',
        'Deploy to staging',
        'Check the Dutch copy',
      ]);
      expect(plan?.steps[4]).toMatchObject({ state: 'queued' });
    });
    expect((await signed('plan.updated', IDS.mara)).length).toBeGreaterThan(0);
    // The new line gets the step id the Plan gave it.
    const plan = await loadPlan(services.db, PLAN_ID);
    await eventually(() =>
      expect(planStepsFromDoc(editor.read(), PLAN_ID)?.[4]?.stepId).toBe(plan?.steps[4]?.id),
    );
  });
});

describe('agent edits', () => {
  it('Dusty edits over MCP: collaborators see the text, "Dusty is writing" and a caret', async () => {
    const mara = await join(IDS.mara);
    const { token } = await agentTokenFor(services, TEST_BURROW_ID, IDS.dusty, IDS.billing);
    const agentMcp = await mcpClient(baseUrl, token);
    try {
      const res = await agentMcp.call('canvas_edit', {
        canvas: SLUG,
        edits: [
          {
            op: 'append',
            markdown:
              '## Rules to keep\n\n- PDFs are cached for 24 hours, keyed by invoice number and locale',
          },
        ],
      });
      expect(res.body.status).toBe('ok');
      await eventually(() => {
        expect(mara.text()).toContain('PDFs are cached for 24 hours, keyed by invoice number and locale');
        const peer = mara
          .peers()
          .find((p) => (p.user as { principalId?: string })?.principalId === IDS.dusty);
        expect(peer).toMatchObject({
          writing: true,
          user: { name: 'Dusty', kind: 'agent', color: 'var(--brand)' },
        });
        const cursor = (peer as { cursor?: { head?: unknown } }).cursor;
        expect(cursor?.head).toBeTruthy();
        // The caret rests right after what Dusty wrote.
        const pos = Y.createAbsolutePositionFromRelativePosition(
          Y.createRelativePositionFromJSON(cursor?.head),
          mara.doc,
        );
        expect(pos?.type.toString()).toContain('keyed by invoice number and locale');
      });
      // "Writing" lapses a moment after the last edit; Dusty stays present.
      await eventually(() => {
        const peer = mara
          .peers()
          .find((p) => (p.user as { principalId?: string })?.principalId === IDS.dusty);
        expect(peer).toMatchObject({ writing: false });
      });
      const detail = await caller.inject({
        method: 'GET',
        url: `/api/v1/burrows/burrow-hq/canvases/${SLUG}`,
        headers: { cookie: await cookieOf(IDS.mara) },
      });
      expect(detail.json().presentIds).toEqual(expect.arrayContaining([IDS.mara, IDS.dusty]));
      const read = await agentMcp.call('canvas_read', { canvas: SLUG });
      expect(read.body.markdown).toContain(
        '- PDFs are cached for 24 hours, keyed by invoice number and locale',
      );
      // The phone's read-only canvas reads the same text (`canvases.content`, review-features.md RF-07).
      const content = await caller.inject({
        method: 'GET',
        url: `/api/v1/burrows/burrow-hq/canvases/${SLUG}/content`,
        headers: { cookie: await cookieOf(IDS.mara) },
      });
      expect(content.statusCode, content.body).toBe(200);
      expect(content.json()).toMatchObject({
        canvas: { id: CANVAS_ID, slug: SLUG },
        markdown: read.body.markdown,
        updatedAt: expect.any(String),
      });
      const [edited] = await signed('canvas.edited', IDS.dusty);
      expect(edited?.payload).toMatchObject({ canvasId: CANVAS_ID, edits: 1 });
      const refused = await agentMcp.call('canvas_edit', {
        canvas: SLUG,
        edits: [{ op: 'delete', find: 'nowhere at all' }],
      });
      expect(refused.isError).toBe(true);
    } finally {
      await agentMcp.close();
    }
  });
});

describe('comments (11.3)', () => {
  it('anchors survive edits around them; open comments are marked, resolved ones unmarked', async () => {
    const mara = await join(IDS.mara);
    const other = await join(IDS.mara);
    const anchor = anchorForQuote(mara.doc, 'half-up, before formatting');
    if (!anchor) throw new Error('quote not found');
    const res = await services.pipeline.commit(
      addCanvasComment,
      { slug: SLUG, anchor, text: 'Keep this one.' },
      { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
    );
    if (res.status !== 'ok') throw new Error('comment not added');
    const commentId = res.result.commentId;
    const marked = () => {
      let text = '';
      other.read().descendants((n) => {
        if (n.marks.some((m) => m.type.name === 'commentAnchor' && m.attrs.commentId === commentId))
          text += n.text;
      });
      return text;
    };
    await eventually(() => expect(marked()).toBe('half-up, before formatting'));
    other.edit([
      { op: 'insert_after', after: 'Invoice PDF export', markdown: 'A new first paragraph.' },
      { op: 'replace', find: 'Goal: PDF', markdown: 'Goal: printable PDF' },
    ]);
    await eventually(() => expect(mara.text()).toContain('A new first paragraph.'));
    expect(resolveAnchor(mara.doc, anchor)).toMatchObject({
      intact: true,
      current: 'half-up, before formatting',
    });
    // A fresh client (after the edits were stored) resolves the same anchor.
    await services.collab.settle();
    const later = await join(IDS.mara);
    expect(resolveAnchor(later.doc, anchor)?.intact).toBe(true);

    await services.pipeline.commit(
      resolveCanvasComment,
      { slug: SLUG, commentId, resolved: true },
      { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
    );
    await eventually(() => expect(marked()).toBe(''));
  });

  it('refuses anchors that are not relative positions', async () => {
    await expect(
      services.pipeline.commit(
        addCanvasComment,
        { slug: SLUG, anchor: { relativePosition: 'not-a-position', quote: 'x' }, text: 'Hm.' },
        { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
      ),
    ).rejects.toThrow(/not a position/);
  });
});

describe('search and membership', () => {
  it('indexes the canvas text shortly after it changes', async () => {
    const mara = await join(IDS.mara);
    mara.edit([{ op: 'append', markdown: 'The zebracorn clause stays.' }]);
    await eventually(async () => {
      await services.collab.settle();
      const res = await caller.inject({
        method: 'GET',
        url: '/api/v1/burrows/burrow-hq/search?q=zebracorn',
        headers: { cookie: await cookieOf(IDS.mara) },
      });
      const hit = (res.json().results as { type: string; link: { slug?: string } }[]).find(
        (r) => r.type === 'CANVAS',
      );
      expect(hit?.link.slug).toBe(SLUG);
    });
  });
});

describe('storage', () => {
  it('builds the document of a canvas created without one on first open, and stores it', async () => {
    const res = await services.pipeline.commit(
      createCanvas,
      { title: 'Moss notes', conversationId: IDS.general },
      { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
    );
    if (res.status !== 'ok') throw new Error('canvas not created');
    const [row] = await services.db.select().from(canvases).where(eq(canvases.id, res.result.canvasId));
    expect(row?.ydoc).toBeNull();
    const ep = api.canvases.collabToken;
    const token = await caller.inject({
      method: ep.method,
      url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', slug: res.result.slug })}`,
      headers: { cookie: await cookieOf(IDS.mara) },
    });
    const fresh = await collabClient(transport, {
      token: token.json().token,
      documentName: token.json().documentName,
    });
    clients.push(fresh);
    expect(fresh.read().firstChild?.textContent).toBe('Moss notes');
    const [after] = await services.db.select().from(canvases).where(eq(canvases.id, res.result.canvasId));
    expect(after?.ydoc).not.toBeNull();
  });
});
