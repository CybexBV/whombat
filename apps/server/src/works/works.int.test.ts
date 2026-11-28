/**
 * “Does it really work?” end to end: it needs Postgres because the runs, the watch switch (a commit), the health pass's
 * glance and the page's lines meet only there. A Paperless stub whose newest document opens, fails or is refused: Run
 * now on Look only, Watch it, a failure that shows only the second time, the assistant's run, Stop watching.
 */
import { api, type ThingPage, thingId } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stub, startStub } from '../connections/provision/testing-home';
import { catalogConnections, serviceTestRuns, vaultNetworks, watchOns } from '../db/schema/index';
import { checkConnectionHealth } from '../home/health';
import type { ToolContext } from '../mcp/tools';
import type { DispatchRow } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { insertConnection } from '../test/connections';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { forgetKindReads } from '../things/kinds/read';
import { useVaultNetForTests } from '../vault/net';
import { WORKS_RUN, WORKS_WATCH } from './page';
import { serviceTestTool } from './tool';

const t = useTestServer({ seed: true, app: true });

let stub: Stub;
const stubNet = {
  resolve: async () => [{ address: '192.168.94.10', family: 4 as const }],
  dialAddress: () => '127.0.0.1',
  deadlineMs: 5000,
};
/** How the newest document answers. */
let file: 'opens' | 'fails' | 'refused' = 'opens';
let id = '';
let person = '';

beforeAll(async () => {
  stub = await startStub((req) => {
    if (req.path === '/api/documents/7/download/')
      return file === 'opens'
        ? { status: 206, body: '%PDF-1.7' }
        : { status: file === 'fails' ? 500 : 403, body: 'no' };
    if (req.path === '/api/documents/') return { json: { count: 1, results: [{ id: 7 }] } };
    return { json: { count: 0, results: [] } };
  });
  const port = Number(new URL(stub.url).port);
  useVaultNetForTests(t.services, stubNet);
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_works_test',
    cidr: '192.168.94.0/24',
    ports: [port],
    note: 'Works stub',
    addedAt: t.services.clock(),
  });
  id = await insertConnection(t.services, {
    catalogId: 'paperless',
    burrowId: t.burrowId,
    label: 'Paperless',
    fields: { url: `http://paper.works-test.test:${port}` },
    secret: 'paper_token',
    auth: { type: 'header', name: 'Authorization', template: 'Token {secret}' },
  });
  // Look only: the test only reads, so it runs there too.
  await t.services.db.update(catalogConnections).set({ access: 'read' }).where(eq(catalogConnections.id, id));
  person = (await sessionFor(t.services, IDS.mara)).cookie;
});

afterAll(async () => {
  await stub?.close();
});

const thing = () => thingId('connection', id);
const path = (suffix = '') => `/api/v1/burrows/burrow-hq/things/${encodeURIComponent(thing())}${suffix}`;

async function call(method: 'GET' | 'POST', url: string, body?: unknown) {
  const res = await t.api.inject({
    method,
    url,
    headers: { cookie: person, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function page(): Promise<ThingPage> {
  const res = await call('GET', path());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return api.things.page.response.parse(res.body);
}

function card(p: ThingPage) {
  const panel = p.tabs[0]?.panels.find((x) => x.id === 'works');
  if (panel?.kind !== 'list') throw new Error('no test card');
  return panel;
}

function worth(p: ThingPage) {
  const panel = p.tabs[0]?.panels.find((x) => x.kind === 'notices');
  return panel?.kind === 'notices' ? panel.items : [];
}

async function press(action: string, value?: boolean) {
  const res = await call('POST', path('/actions'), { action, ...(value !== undefined ? { value } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return api.things.action.response.parse(res.body);
}

async function runs() {
  return t.services.db.select().from(serviceTestRuns).where(eq(serviceTestRuns.connectionId, id));
}

const minutes = (n: number) => new Date(t.services.clock().getTime() + n * 60_000);

async function pass(at: Date) {
  forgetKindReads(t.services);
  const [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
  if (!row) throw new Error('no row');
  return checkConnectionHealth(t.services, row, at);
}

describe('does Paperless really work?', () => {
  it('offers the test on the page, not watched and not run', async () => {
    const c = card(await page());
    expect(c.buttons?.map((b) => [b.action, b.allowed])).toEqual([
      [WORKS_RUN, true],
      [WORKS_WATCH, true],
    ]);
    expect(c.items[0]?.tone).toBe('info');
    expect(await runs()).toHaveLength(0);
    // Nothing runs until the person turns it on.
    await pass(minutes(1));
    expect(await runs()).toHaveLength(0);
  });

  it('Run now on a Look-only connection opens the newest document and keeps only the result', async () => {
    const answer = await press(WORKS_RUN);
    expect(answer.message).toContain('It works');
    expect(answer.changeId).toBeUndefined();
    const [run] = await runs();
    expect(run).toMatchObject({ outcome: 'ok', by: 'person', step: null, facts: {} });
    expect(stub.calls('GET /api/documents/7/download/')[0]?.headers.range).toBe('bytes=0-2047');
    expect(card(await page()).items[0]?.tone).toBe('ok');
  });

  it('Watch it turns the check on and runs it; a failure shows only the second time', async () => {
    const answer = await press(WORKS_WATCH, true);
    expect(answer.message).toContain('15 minutes');
    const [on] = await t.services.db.select().from(watchOns).where(eq(watchOns.thingId, thing()));
    expect(on?.checkId).toBe('works.test');
    expect(card(await page()).buttons?.[1]).toMatchObject({ action: WORKS_WATCH, value: false });
    const before = (await runs()).length;

    file = 'fails';
    const first = await pass(minutes(16));
    expect(await runs()).toHaveLength(before + 1);
    expect(first?.lines?.some((l) => l.check === 'works.test')).toBe(false);
    // Not due again before the next pass.
    await pass(minutes(17));
    expect(await runs()).toHaveLength(before + 1);
    const second = await pass(minutes(21));
    expect(await runs()).toHaveLength(before + 2);
    const line = second?.lines?.find((l) => l.check === 'works.test');
    expect(line).toMatchObject({ nature: 'problem' });
    expect(line?.title).toContain('500');
    expect(worth(await page())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: 'works.test', link: expect.objectContaining({ kind: 'ask' }) }),
      ]),
    );
  });

  it('the assistant runs it and hears the sign-in was refused, not that Paperless is broken', async () => {
    file = 'refused';
    const ctx: ToolContext = {
      services: t.services,
      agentId: IDS.dusty,
      burrowId: t.burrowId,
      dispatch: {
        id: 'dsp_works_test',
        burrowId: t.burrowId,
        onBehalfOfAccountId: 'acc_mara',
      } as DispatchRow,
      onBehalfOf: {},
    };
    const out = await serviceTestTool(ctx, { thing: thing(), run: true });
    if (out.status !== 'ok') throw new Error('refused');
    expect(out).toMatchObject({ watched: true, test: 'Open your newest document' });
    // The passes above ran ahead of the clock: the assistant's run is the one it made.
    const mine = out.runs.find((r) => r.by === 'assistant');
    expect(mine?.outcome).toBe('access');
    expect(mine?.words).toContain('sign-in');
    expect(mine?.words).toContain('403');
  });

  it('Stop watching ends the runs', async () => {
    file = 'opens';
    const answer = await press(WORKS_WATCH, false);
    expect(answer.message).toContain('stopped');
    const before = (await runs()).length;
    await pass(minutes(60));
    expect(await runs()).toHaveLength(before);
    expect(worth(await page()).some((l) => l.check === 'works.test')).toBe(false);
  });
});
