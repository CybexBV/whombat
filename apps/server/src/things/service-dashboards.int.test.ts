/**
 * Service dashboards' core on a real database (service-dashboards.md SD-06…SD-10, SD-S03, SD-S04, SD-S08): it needs
 * Postgres for who may see a thing (the burrow's), the commit that records a button's change, Done recently's
 * filter over stored changes, and the sibling lookup over stored connections. A local picture server stands behind a
 * home-network name, so pictures are fetched as the connection (its bearer token) through the real policy and worker.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ThingPage, thingHref, thingId } from '@whombat/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvalThread } from '../approvals/wake';
import { decideApproval } from '../commands/approvals';
import { signingOnlyAs } from '../connections/bound-targets';
import { callTarget, changedSinceYesText } from '../connections/call-target';
import { sealConnectionSecret } from '../connections/crypto';
import {
  accounts,
  approvals,
  catalogConnections,
  changes,
  events,
  messages,
  principals,
  vaultNetworks,
} from '../db/schema/index';
import { sniffBuffer } from '../files/sniff';
import { recordChange } from '../home/registry';
import { ApiError, badRequest } from '../lib/errors';
import { forAssistant } from '../managed/acting-assistant';
import { SessionDispatcher } from '../managed/dispatcher';
import { CommandReceipts } from '../managed/receipts';
import { openDownload, type StreamContext } from '../managed/resources';
import type { SessionStream } from '../managed/session/streams';
import type { SessionPrincipal } from '../managed/trust';
import { IDS } from '../seed/test-world';
import { changeSetting, runBound } from '../settings/command';
import { insertConnection } from '../test/connections';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { askThingAction, runThingAction, thingActionTargets } from './actions';
import { imageRef } from './images';
import { actAs } from './kinds/act';
import { pageButton } from './kinds/buttons';
import { KIND_MODULES } from './kinds/index';
import type { KindModule } from './kinds/registry';
import { settingChanges } from './kinds/settings';
import { siblingThing } from './siblings';

const t = useTestServer({ seed: true, app: true });

const TOKEN = 'glsa_pictures';
const served = new Map<string, number>();
let pictures: http.Server;
let shared = '';
let personal = '';
let sab = '';
let mara = '';
let maraAccount = '';

function png(width: number, height: number): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(180);
  return PNG.sync.write(image);
}
const POSTER = png(100, 150);
const LARGE = png(960, 480);

const quality = { value: 8000 };
/** What the signed button does between the press's check and its request (a token replaced there), when set. */
let midway: (() => Promise<void>) | null = null;

/** The test kind's buttons (SD-S04): one a person would want to find, one everyday switch; both say what they got. */
const testKind: KindModule = {
  page: async (ctx) => ({
    kpis: [{ key: 'waiting', label: 'Waiting for you', value: '2' }],
    charts: [],
    machine: 'after',
    refreshS: 5,
    notices: [],
    panels: [],
    tabs: [],
    facts: [],
    actions: [],
    buttons: [pageButton(ctx, { action: 'approve', target: 'req-12', label: 'Approve', tone: 'primary' })],
    readAt: ctx.now,
    suggestions: [],
  }),
  actions: {
    approve: async (_ctx, input) => {
      if (input.target !== 'req-12') throw badRequest('That request isn’t waiting any more.');
      return { message: 'Approved.', title: 'Approved Dune: Part Two' };
    },
    // A declared setting (service-settings.md SST-02, SST-03): put back only while it still has the value set.
    setting: async (_ctx, input) => {
      const old = quality.value;
      if (input.expect !== undefined && input.expect !== old) throw badRequest('It was changed again since.');
      quality.value = Number(input.value);
      return {
        message: `Quality is now ${quality.value}.`,
        title: `Changed Quality from ${old} to ${quality.value}`,
        changeKind: 'setting.quality',
        detail: String(old),
        undo: { target: 'quality', value: old, expect: quality.value },
      };
    },
    // A button that changes something on the service as the connection (`actAs`).
    signed: async (ctx) => {
      await midway?.();
      await actAs(ctx.services, ctx.row, 'Grafana', { method: 'POST', path: '/act', body: {} });
      return { message: 'Done.', title: 'Did it on Grafana' };
    },
    light: async (_ctx, input) => ({
      message: `Turned ${input.value ? 'on' : 'off'} the kitchen light.`,
      title: `Turned ${input.value ? 'on' : 'off'} ${input.target}`,
      everyday: true,
    }),
  },
  // The approval card's words, read from the service as the connection (a setting's old value, SST-04).
  describe: async (ctx, action) => {
    await midway?.();
    await actAs(ctx.services, ctx.row, 'Grafana', { method: 'GET', path: '/describe' });
    return { title: `Do ${action} on Grafana`, lines: ['As it reads now'] };
  },
};
const kinds = KIND_MODULES as Record<string, KindModule | undefined>;
const before = kinds.grafana;

beforeAll(async () => {
  pictures = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    served.set(path, (served.get(path) ?? 0) + 1);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    const body =
      path === '/poster.png' || path === '/snap.png' ? POSTER : path === '/large.png' ? LARGE : null;
    if (body) res.writeHead(200, { 'content-type': 'image/png' }).end(body);
    else res.writeHead(200, { 'content-type': 'application/json' }).end('{"not":"a picture"}');
  });
  await new Promise<void>((resolve) => pictures.listen(0, '127.0.0.1', resolve));
  const port = (pictures.address() as AddressInfo).port;
  useVaultNetForTests(t.services, {
    resolve: async () => [{ address: '192.168.93.10', family: 4 }],
    dialAddress: () => '127.0.0.1',
    deadlineMs: 5000,
  });
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_sd_test',
    cidr: '192.168.93.0/24',
    ports: [port],
    note: 'Pictures stub',
    addedAt: t.services.clock(),
  });
  const people = await t.services.db.select().from(principals);
  maraAccount = people.find((p) => p.id === IDS.mara)?.accountId as string;
  const fields = { url: `http://pictures.home-test.test:${port}` };
  shared = await insertConnection(t.services, {
    catalogId: 'grafana',
    burrowId: t.burrowId,
    label: 'Grafana',
    fields,
    secret: TOKEN,
  });
  personal = await insertConnection(t.services, {
    catalogId: 'grafana',
    burrowId: t.burrowId,
    connectedById: IDS.mara,
    handle: 'grafana-2',
    label: 'Mara’s Grafana',
    fields,
    secret: TOKEN,
  });
  sab = await insertConnection(t.services, {
    catalogId: 'sabnzbd',
    burrowId: t.burrowId,
    label: 'SABnzbd',
    fields: { url: 'http://sab.home-test.test:8080' },
    secret: 'x',
  });
  kinds.grafana = testKind;
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
});

afterAll(async () => {
  kinds.grafana = before;
  await new Promise((resolve) => pictures?.close(resolve));
});

const thingPath = (id: string) =>
  `/api/v1/burrows/burrow-hq/things/${encodeURIComponent(thingId('connection', id))}`;
const refOf = (connectionId: string, path: string, snapshot = false) =>
  imageRef({ services: t.services, row: { id: connectionId }, now: t.services.clock() }, { path, snapshot });

/** A picture over the session as `accountId`, or the refusal's code. */
async function picture(accountId: string, connectionId: string, ref: string) {
  return overSession(accountId, connectionId, ref).catch((err: unknown) => {
    if (err instanceof ApiError) return { refused: err.code };
    throw err;
  });
}

describe('pictures (SD-06, SD-S03)', () => {
  it('serves a picture fetched as the connection, kept for the next ask', async () => {
    const ref = refOf(shared, '/poster.png');
    const res = await overSession(maraAccount, shared, ref);
    expect(res.meta).toMatchObject({ contentType: 'image/png' });
    expect(res.bytes.equals(POSTER)).toBe(true);
    // Anyone of the burrow sees a shared connection's pictures; the second ask is the cache's.
    const again = await overSession(maraAccount, shared, ref);
    expect(again.bytes.equals(POSTER)).toBe(true);
    expect(served.get('/poster.png')).toBe(1);
  });

  it('makes a large picture 480 px at most', async () => {
    const res = await overSession(maraAccount, shared, refOf(shared, '/large.png'));
    const sniffed = sniffBuffer(res.bytes, 'picture');
    expect(sniffed.ok && Math.max(sniffed.value.width ?? 0, sniffed.value.height ?? 0)).toBe(480);
    const snap = await overSession(maraAccount, shared, refOf(shared, '/snap.png', true));
    expect(snap.bytes.length).toBeGreaterThan(0);
  });

  it('a connection’s pictures are fetched as that connection', async () => {
    const ref = refOf(personal, '/poster.png');
    expect(await picture(maraAccount, personal, ref)).toMatchObject({ meta: { contentType: 'image/png' } });
  });

  it('refuses with the same 404 a ref for another thing, a changed ref, and what isn’t a picture', async () => {
    const ref = refOf(personal, '/poster.png');
    // Signed for the other connection, asked for on this one's page.
    expect(await picture(maraAccount, shared, ref)).toEqual({ refused: 'not_found' });
    expect(await picture(maraAccount, shared, `${ref.slice(0, -2)}AA`)).toEqual({ refused: 'not_found' });
    expect(await picture(maraAccount, shared, refOf(shared, '/data.json'))).toEqual({ refused: 'not_found' });
    expect(await picture(maraAccount, shared, 'nonsense')).toEqual({ refused: 'not_found' });
  });
});

/** A session's `thing-image` download for one person, read to its end (CT-1000). */
async function overSession(accountId: string, connectionId: string, ref: string) {
  const [account] = await t.services.db.select().from(accounts).where(eq(accounts.id, accountId));
  const chunks: Uint8Array[] = [];
  const sent: Record<string, unknown>[] = [];
  const ctx = {
    services: t.services,
    principal: { account } as unknown as SessionPrincipal,
    stream: {
      id: 1,
      write: async (bytes: Uint8Array) => {
        chunks.push(bytes);
      },
      end: async () => undefined,
      reset: async () => undefined,
    } as unknown as SessionStream,
    send: async (m: Record<string, unknown>) => {
      sent.push(m);
    },
  } as StreamContext;
  const opened = await openDownload(ctx, {
    kind: 'download',
    resource: { type: 'thing-image', burrow: 'burrow-hq', thing: thingId('connection', connectionId), ref },
  });
  await opened.run?.();
  return { meta: opened.meta, bytes: Buffer.concat(chunks), sent };
}

describe('pictures over the session (CT-1000)', () => {
  it('streams the picture of the thing', async () => {
    const ref = refOf(personal, '/poster.png');
    const got = await overSession(maraAccount, personal, ref);
    expect(got.meta).toMatchObject({ kind: 'download', contentType: 'image/png', size: POSTER.length });
    expect(got.bytes.equals(POSTER)).toBe(true);
    expect(got.sent).toEqual([expect.objectContaining({ t: 'stream_done', size: POSTER.length })]);
  });
});

async function act(cookie: string, connectionId: string, body: Record<string, unknown>) {
  const res = await t.api.inject({
    method: 'POST',
    url: `${thingPath(connectionId)}/actions`,
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('buttons (SD-07, SD-08, SD-S04)', () => {
  it('records a change a person would want to find, and an everyday switch apart', async () => {
    const approved = await act(mara, shared, { action: 'approve', target: 'req-12' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(202);
    expect(approved.body).toMatchObject({ message: 'Approved.', refresh: true });
    const lit = await act(mara, shared, { action: 'light', target: 'light.kitchen', value: true });
    expect(lit.status, JSON.stringify(lit.body)).toBe(202);
    const rows = await t.services.db
      .select()
      .from(changes)
      .where(and(eq(changes.subjectKind, 'connection'), eq(changes.subjectId, shared)))
      .orderBy(desc(changes.createdAt));
    expect(rows.map((r) => r.kind).sort()).toEqual(['thing.approve', 'thing.control.light']);
    expect(rows.find((r) => r.kind === 'thing.control.light')?.title).toContain('light.kitchen');
    expect(lit.body.changeId).toBe(rows.find((r) => r.kind === 'thing.control.light')?.id);
    // The burrow's log names the approval, not the light.
    const logged = await t.services.db
      .select({ text: events.text })
      .from(events)
      .where(eq(events.type, 'thing.action'))
      .orderBy(desc(events.seq))
      .limit(2);
    expect(logged.map((e) => e.text)).toEqual([null, 'Approved Dune: Part Two']);
    // The thing's own changes list both.
    const listed = await t.api.inject({
      method: 'GET',
      url: `/api/v1/burrows/burrow-hq/changes?thing=${encodeURIComponent(thingId('connection', shared))}`,
      headers: { cookie: mara },
    });
    expect((listed.json() as { changes: { id: string }[] }).changes.map((c) => c.id).sort()).toEqual(
      rows.map((r) => r.id).sort(),
    );
  });

  it('Done recently leaves everyday switches out', async () => {
    const at = t.services.clock();
    const { result: ids } = await t.services.pipeline.transact(t.burrowId, async (session) => {
      const writer = { tx: session.tx, services: t.services };
      const base = {
        burrowId: t.burrowId,
        actorId: IDS.dusty,
        agentId: IDS.dusty,
        personId: IDS.mara,
        subject: { kind: 'connection' as const, id: shared, name: 'Grafana' },
        at,
      };
      return {
        found: await recordChange(writer, { ...base, kind: 'connection.call', title: 'Silenced an alert' }),
        everyday: await recordChange(writer, {
          ...base,
          kind: 'thing.control.light',
          title: 'Turned on Kitchen',
        }),
      };
    });
    const done = await t.api.inject({
      method: 'GET',
      url: '/api/v1/burrows/burrow-hq/changes?limit=50',
      headers: { cookie: mara },
    });
    const shown = (done.json() as { changes: { id: string }[] }).changes.map((c) => c.id);
    expect(shown).toContain(ids.found);
    expect(shown).not.toContain(ids.everyday);
  });

  it('refuses Look only, an unknown button, and what the kind says no to', async () => {
    expect((await act(mara, shared, { action: 'delete' })).status).toBe(400);
    expect((await act(mara, shared, { action: 'approve', target: 'req-99' })).status).toBe(400);
    await t.services.db
      .update(catalogConnections)
      .set({ access: 'read' })
      .where(eq(catalogConnections.id, shared));
    try {
      const res = await act(mara, shared, { action: 'approve', target: 'req-12' });
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toContain('Look only');
    } finally {
      await t.services.db
        .update(catalogConnections)
        .set({ access: 'manage' })
        .where(eq(catalogConnections.id, shared));
    }
  });
});

describe('a button signs only as the connection it was checked on', () => {
  /** The person pastes another token into the connection; returns what puts the first back. */
  async function replaceToken() {
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, shared));
    if (!row) throw new Error('no connection');
    await t.services.db
      .update(catalogConnections)
      .set({
        secretEnc: sealConnectionSecret(t.services.custody, shared, 'secret', 'glsa_another_account'),
        credentialVersion: row.credentialVersion + 1,
      })
      .where(eq(catalogConnections.id, shared));
    return async () => {
      await t.services.db
        .update(catalogConnections)
        .set({ secretEnc: row.secretEnc, credentialVersion: row.credentialVersion })
        .where(eq(catalogConnections.id, shared));
    };
  }

  it('sends nothing when the token is replaced between the press and its request', async () => {
    const done = await act(mara, shared, { action: 'signed' });
    expect(done.status, JSON.stringify(done.body)).toBe(202);
    const sent = served.get('/act') ?? 0;
    let restore: (() => Promise<void>) | null = null;
    midway = async () => {
      restore = await replaceToken();
    };
    try {
      const refused = await act(mara, shared, { action: 'signed' });
      expect(refused.status).toBe(409);
      expect(JSON.stringify(refused.body)).toContain('Grafana changed just now');
      expect(served.get('/act') ?? 0).toBe(sent);
    } finally {
      midway = null;
      await (restore as (() => Promise<void>) | null)?.();
    }
  });

  it('runs the assistant’s approved change only where the connection went when it asked', async () => {
    const input = { params: { burrow: 'burrow-hq', thing: thingId('connection', shared) }, body: {} };
    const targets = await thingActionTargets(t.services, t.burrowId, 'things.action', input);
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, shared));
    if (!row) throw new Error('no connection');
    expect(targets).toEqual({ [shared]: callTarget(row) });
    // A session's still-encoded thing id names the same; any other op signs as no connection.
    expect(
      await thingActionTargets(t.services, t.burrowId, 'things.action', {
        params: { thing: encodeURIComponent(thingId('connection', shared)) },
      }),
    ).toEqual(targets);
    expect(await thingActionTargets(t.services, t.burrowId, 'profile.update', input)).toEqual({});

    // The connection is signed in again while the card waits: the yes runs nothing.
    let ran = 0;
    const restore = await replaceToken();
    try {
      const answer = await runBound(t.services, targets, changedSinceYesText, async () => {
        ran++;
        return { type: 'redacted' };
      });
      expect(answer).toMatchObject({ type: 'error' });
      expect((answer as { message: string }).message).toContain('Grafana changed since you said yes');
      expect(ran).toBe(0);
    } finally {
      await restore();
    }
    // As it was, it runs.
    expect(
      await runBound(t.services, targets, changedSinceYesText, async () => ({ type: 'redacted' })),
    ).toEqual({
      type: 'redacted',
    });

    // Bound to where the yes went, a page action that finds the connection somewhere else changes nothing.
    quality.value = 8000;
    const [person] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
    if (!person) throw new Error('no Mara');
    await expect(
      signingOnlyAs({ [shared]: 'f'.repeat(64) }, () =>
        forAssistant(IDS.dusty, () =>
          runThingAction(
            t.services,
            { accountId: maraAccount, burrowId: t.burrowId, principal: person },
            thingId('connection', shared),
            { action: 'setting', target: 'quality', value: 20000 },
          ),
        ),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('Grafana changed just now') });
    expect(quality.value).toBe(8000);
  });
});

describe('the assistant’s page action, bound from its card to its run', () => {
  /** The person pastes another token into the connection; returns what puts the first back. */
  async function replaceToken() {
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, shared));
    if (!row) throw new Error('no connection');
    await t.services.db
      .update(catalogConnections)
      .set({
        secretEnc: sealConnectionSecret(t.services.custody, shared, 'secret', 'glsa_another_account'),
        credentialVersion: row.credentialVersion + 1,
      })
      .where(eq(catalogConnections.id, shared));
    return async () => {
      await t.services.db
        .update(catalogConnections)
        .set({ secretEnc: row.secretEnc, credentialVersion: row.credentialVersion })
        .where(eq(catalogConnections.id, shared));
    };
  }
  const input = (action: string) => ({
    params: { burrow: 'burrow-hq', thing: thingId('connection', shared) },
    body: { action },
  });
  const approvalCount = async () =>
    (await t.services.db.select({ n: sql<number>`count(*)::int` }).from(approvals))[0]?.n ?? 0;

  it('describes the card and binds its yes from one read of the connection', async () => {
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, shared));
    if (!row) throw new Error('no connection');
    const read = served.get('/describe') ?? 0;
    const asked = await askThingAction(t.services, t.burrowId, 'things.action', input('approve'));
    expect(asked).toMatchObject({
      targets: { [shared]: callTarget(row) },
      said: { title: 'Do approve on Grafana' },
      changed: null,
    });
    expect(served.get('/describe')).toBe(read + 1);

    // Signed in again while the card's words are read: no card, and nothing reached Grafana as either token.
    let restore: (() => Promise<void>) | null = null;
    midway = async () => {
      restore = await replaceToken();
    };
    try {
      const changed = await askThingAction(t.services, t.burrowId, 'things.action', input('approve'));
      expect(changed).toMatchObject({ said: null, changed: 'Grafana' });
      expect(served.get('/describe')).toBe(read + 1);
    } finally {
      midway = null;
      await (restore as (() => Promise<void>) | null)?.();
    }
  });

  it('saves no card once the connection changed after its words were read', async () => {
    const { targets } = await askThingAction(t.services, t.burrowId, 'things.action', input('approve'));
    const before = await approvalCount();
    const restore = await replaceToken();
    try {
      await expect(
        t.services.pipeline.commit(
          changeSetting,
          { op: 'things.action', input: input('approve'), conversationId: null, targets },
          { burrowId: t.burrowId, actorId: IDS.dusty },
        ),
      ).rejects.toMatchObject({
        name: 'ChangedWhileAskedError',
        message: expect.stringContaining('Grafana'),
      });
      expect(await approvalCount()).toBe(before);
    } finally {
      await restore();
    }
    // As it was read, the change goes on to the person's key (here: no chat to ask in).
    const asked = await t.services.pipeline
      .commit(
        changeSetting,
        { op: 'things.action', input: input('approve'), conversationId: null, targets },
        { burrowId: t.burrowId, actorId: IDS.dusty },
      )
      .catch((err: unknown) => err);
    expect(asked).not.toMatchObject({ name: 'ChangedWhileAskedError' });
  });

  it('asks again on a fresh card, bound now and naming its connection, for a yes to a card saved unbound', async () => {
    // As the previous release saved it: no targets.
    const asked = await t.services.pipeline.commit(
      changeSetting,
      { op: 'things.action', input: input('signed'), conversationId: IDS.dmDusty },
      { burrowId: t.burrowId, actorId: IDS.dusty },
    );
    if (asked.status !== 'pending_approval') throw new Error(asked.status);
    const executionOf = async (id: string) =>
      (await t.services.db.select().from(approvals).where(eq(approvals.id, id)))[0]?.execution;
    const [old] = await t.services.db.select().from(approvals).where(eq(approvals.id, asked.approvalId));
    if (!old) throw new Error('no approval');
    const sent = served.get('/act') ?? 0;
    // Pointed elsewhere while the card waited, and named apart from another Grafana.
    const restore = await replaceToken();
    await t.services.db
      .update(catalogConnections)
      .set({ label: 'Grafana upstairs' })
      .where(eq(catalogConnections.id, shared));
    try {
      const decided = await t.services.pipeline.commit(
        decideApproval,
        { number: old.number, decision: 'approve' },
        { burrowId: t.burrowId, actorId: IDS.mara },
      );
      expect(decided.status).toBe('ok');
      await expect.poll(async () => (await executionOf(old.id))?.state, { timeout: 10_000 }).toBe('failed');
      expect((await executionOf(old.id))?.error).toContain('asks you again');
      expect(served.get('/act') ?? 0).toBe(sent);
      const fresh = await t.services.db
        .select()
        .from(approvals)
        .where(sql`${approvals.command} -> 'input' ->> 'askAgainOf' = ${old.id}`);
      expect(fresh).toHaveLength(1);
      const [row] = await t.services.db
        .select()
        .from(catalogConnections)
        .where(eq(catalogConnections.id, shared));
      expect(fresh[0]).toMatchObject({
        state: 'pending',
        title: expect.stringContaining('Grafana upstairs'),
      });
      expect(fresh[0]?.command?.input).toMatchObject({
        targets: { [shared]: callTarget(row as NonNullable<typeof row>) },
      });
      const [card] = await t.services.db
        .select({ threadRootId: messages.threadRootId })
        .from(messages)
        .where(eq(messages.id, fresh[0]?.messageId as string));
      expect(card?.threadRootId ?? null).toBe(await approvalThread(t.services.db, old.id, IDS.dmDusty));
    } finally {
      await t.services.db
        .update(catalogConnections)
        .set({ label: 'Grafana' })
        .where(eq(catalogConnections.id, shared));
      await restore();
    }
  });

  it('stays bound through the session dispatcher while it runs', async () => {
    const dispatcher = new SessionDispatcher(
      t.services,
      {} as never,
      new CommandReceipts(t.services.db, t.services.clock),
    );
    const [account] = await t.services.db.select().from(accounts).where(eq(accounts.id, maraAccount));
    if (!account) throw new Error('no account');
    const run = () => dispatcher.runForAssistant(account, IDS.dusty, 'things.action', input('signed'));
    const targets = await thingActionTargets(t.services, t.burrowId, 'things.action', input('signed'));
    const sent = served.get('/act') ?? 0;

    // The token is replaced while the action runs, between its check and its request: nothing is sent.
    let restore: (() => Promise<void>) | null = null;
    midway = async () => {
      restore = await replaceToken();
    };
    try {
      const refused = await runBound(t.services, targets, changedSinceYesText, run);
      expect(refused).toMatchObject({ type: 'error', message: expect.stringContaining('Grafana changed') });
      expect(served.get('/act') ?? 0).toBe(sent);
    } finally {
      midway = null;
      await (restore as (() => Promise<void>) | null)?.();
    }

    // Run without the binding a yes or an ask gives it, the assistant's action sends nothing.
    const unbound = await run();
    expect(unbound).toMatchObject({ type: 'error', message: expect.stringContaining('Grafana changed') });
    expect(served.get('/act') ?? 0).toBe(sent);

    // Bound and unchanged, it runs once.
    expect(await runBound(t.services, targets, changedSinceYesText, run)).toMatchObject({ type: 'result' });
    expect(served.get('/act')).toBe(sent + 1);
  });
});

describe('a declared setting (service-settings.md SST-03, SST-04)', () => {
  const undo = (cookie: string, changeId: string) =>
    t.api.inject({
      method: 'POST',
      url: `/api/v1/burrows/burrow-hq/changes/${changeId}/undo`,
      headers: { cookie },
    });

  it('can be put back once, as the person, while it still has the value set', async () => {
    quality.value = 8000;
    const set = await act(mara, shared, { action: 'setting', target: 'quality', value: 20000 });
    expect(set.status, JSON.stringify(set.body)).toBe(202);
    expect(set.body).toMatchObject({ undoable: true });
    const changeId = set.body.changeId as string;
    const [row] = await t.services.db.select().from(changes).where(eq(changes.id, changeId));
    expect(row).toMatchObject({ kind: 'thing.setting.quality', detail: '8000', undoKind: 'thing.action' });
    expect(row?.undoUntil).toBeInstanceOf(Date);
    const back = await undo(mara, changeId);
    expect(back.statusCode, back.body).toBeLessThan(300);
    expect(quality.value).toBe(8000);
    const [after] = await t.services.db.select().from(changes).where(eq(changes.id, changeId));
    expect(after?.undoneAt).toBeInstanceOf(Date);
    // The page's row: the put-back is the latest change, and can itself be put back.
    const last = await settingChanges(t.services, t.burrowId, shared, t.services.clock());
    expect(last.get('quality')).toMatchObject({ byAssistant: false, from: '20000' });
  });

  it('is put back only where it was changed', async () => {
    quality.value = 8000;
    const set = await act(mara, shared, { action: 'setting', target: 'quality', value: 16000 });
    expect(set.status, JSON.stringify(set.body)).toBe(202);
    const [before] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, shared));
    if (!before) throw new Error('no connection');
    // The person points the connection at another server since: the old value would land there, so it isn't sent.
    await t.services.db
      .update(catalogConnections)
      .set({ credentialVersion: before.credentialVersion + 1 })
      .where(eq(catalogConnections.id, shared));
    try {
      const back = await undo(mara, set.body.changeId as string);
      expect(back.statusCode).toBe(409);
      expect(back.body).toContain('changed since, so this can’t be undone here');
      expect(quality.value).toBe(16000);
    } finally {
      await t.services.db
        .update(catalogConnections)
        .set({ credentialVersion: before.credentialVersion })
        .where(eq(catalogConnections.id, shared));
    }
    // Back where it was changed, it is put back.
    expect((await undo(mara, set.body.changeId as string)).statusCode).toBeLessThan(300);
    expect(quality.value).toBe(8000);
  });

  it('isn’t put back once it was changed since', async () => {
    quality.value = 8000;
    const set = await act(mara, shared, { action: 'setting', target: 'quality', value: 12000 });
    quality.value = 4000;
    const back = await undo(mara, set.body.changeId as string);
    expect(back.statusCode).toBeGreaterThanOrEqual(400);
    expect(quality.value).toBe(4000);
  });

  it('names the assistant when it ran the change for the person', async () => {
    quality.value = 8000;
    const [person] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
    if (!person) throw new Error('no Mara');
    // The assistant's page action runs bound to where its yes went (`runBound` does it on the real path).
    const targets = await thingActionTargets(t.services, t.burrowId, 'things.action', {
      params: { thing: thingId('connection', shared) },
    });
    const { value: out } = await signingOnlyAs(targets, () =>
      forAssistant(IDS.dusty, () =>
        runThingAction(
          t.services,
          { accountId: maraAccount, burrowId: t.burrowId, principal: person },
          thingId('connection', shared),
          { action: 'setting', target: 'quality', value: 20000 },
        ),
      ),
    );
    const [row] = await t.services.db
      .select()
      .from(changes)
      .where(eq(changes.id, out.changeId as string));
    expect(row).toMatchObject({ agentId: IDS.dusty, personId: IDS.mara });
    const last = await settingChanges(t.services, t.burrowId, shared, t.services.clock());
    expect(last.get('quality')?.byAssistant).toBe(true);
  });
});

describe('a kind’s own page (SD-03, SD-09, SD-S02, CT-1014)', () => {
  it('draws its head buttons, its own figures, no response chart, live refresh', async () => {
    const read = async (cookie: string) => {
      const res = await t.api.inject({ method: 'GET', url: thingPath(shared), headers: { cookie } });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as ThingPage;
    };
    const page = await read(mara);
    expect(page.buttons).toEqual([
      expect.objectContaining({ action: 'approve', target: 'req-12', allowed: true }),
    ]);
    expect(page.refreshS).toBe(5);
    const summary = page.tabs[0]?.panels ?? [];
    expect(summary.find((p) => p.kind === 'kpis')).toMatchObject({ items: [{ key: 'waiting' }] });
    expect(summary.some((p) => p.kind === 'chart')).toBe(false);
  });
});

describe('siblings (SD-10, SD-S08)', () => {
  it('finds the first connection of those kinds in the burrow, an active one first', async () => {
    const ctx = { services: t.services, burrowId: t.burrowId };
    expect(await siblingThing(ctx, ['sabnzbd'])).toEqual({
      href: thingHref('connection', sab),
      name: 'SABnzbd',
    });
    expect((await siblingThing(ctx, ['grafana']))?.name).toBe('Grafana');
    await t.services.db
      .update(catalogConnections)
      .set({ status: 'error' })
      .where(eq(catalogConnections.id, shared));
    try {
      expect((await siblingThing(ctx, ['grafana']))?.name).toBe('Mara’s Grafana');
    } finally {
      await t.services.db
        .update(catalogConnections)
        .set({ status: 'active' })
        .where(eq(catalogConnections.id, shared));
    }
    expect(await siblingThing(ctx, ['overseerr'])).toBeNull();
    expect(await siblingThing({ services: t.services, burrowId: t.burrowId }, [])).toBeNull();
  });
});
