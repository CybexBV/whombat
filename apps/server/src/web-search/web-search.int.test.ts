/**
 * Web search end to end (web-search.md): the person turns it on with a Brave Search key (checked first, a key Brave turns
 * away never saved; the key sealed in Postgres, signed under Keys, the burrow published), checks it again and removes it.
 * The person's turns carry the key, an outsiders' turn doesn't. Brave is answered by a fake through the test seam. It
 * needs Postgres: the commands run through the commit pipeline, the key is sealed in the burrow's row and the turn's
 * context reads the dispatch. A backup file holds it with its key; a restore puts it back unchecked.
 */
import { api, type BackupSettingsLine, buildPath, parseBackupRecord } from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CategoryOut, CollectScope } from '../backups/collect/scope';
import { collectSettings } from '../backups/collect/settings';
import { applyRecords } from '../backups/restore/batch';
import { RestoreRun } from '../backups/restore/run';
import { loadBurrowRow } from '../commit/pipeline';
import { defineCommand } from '../commit/types';
import { dispatches, events, principals } from '../db/schema/index';
import { loadPrincipalRow } from '../read/principals';
import type { BusFrame } from '../realtime/bus';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { agentTokenFor, sessionFor } from '../test/tokens';
import { type BraveAnswer, useWebSearchNetForTests } from './check';
import { webSearchKeyOf } from './store';

// biome-ignore lint/suspicious/noExplicitAny: the tests read nested JSON bodies.
type Body = Record<string, any>;

const t = useTestServer({ seed: true, app: true });
const B = { burrow: 'burrow-hq' };
const KEY = 'BSA-good-key';
const OTHER_KEY = 'BSA-other-key';
const NO_CREDIT_KEY = 'BSA-no-credit-key';
const frames: BusFrame[] = [];
const asked: { url: string; headers: Record<string, string> }[] = [];

/** Brave as the tests need it: results for the good keys, 402 for one without credit, 422 for any other. */
function fakeBrave(url: string, headers: Record<string, string>): BraveAnswer {
  asked.push({ url, headers });
  const json = (status: number, body: unknown) => ({ status, body: Buffer.from(JSON.stringify(body)) });
  const key = headers['X-Subscription-Token'];
  if (key === KEY || key === OTHER_KEY)
    return json(200, { type: 'search', web: { results: [{ title: 'Whombat' }] } });
  if (key === NO_CREDIT_KEY)
    return json(402, { error: { code: 'PAYMENT_REQUIRED', detail: 'No credit left.' } });
  return json(422, {
    error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'The provided subscription token is invalid.' },
  });
}

beforeAll(() => {
  useWebSearchNetForTests(t.services, { request: async (url, headers) => fakeBrave(url, headers) });
  t.services.bus.onFrame((frame) => frames.push(frame));
});

async function call(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, payload?: object) {
  const { cookie } = await sessionFor(t.services, IDS.mara);
  const res = await t.api.inject({
    method,
    url: `/api/v1${path}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: res.json() as Body, raw: res.body };
}

const path = () => buildPath(api.burrows.setWebSearch.path, B);
const set = (apiKey: string) => call('PUT', path(), { apiKey });
const check = () => call('POST', buildPath(api.burrows.testWebSearch.path, B));
const burrowNow = async () => (await call('GET', buildPath(api.burrows.get.path, B))).body.burrow;

async function webSearchEvents() {
  return t.services.db
    .select()
    .from(events)
    .where(and(eq(events.burrowId, t.burrowId), eq(events.type, 'burrow.web_search_changed')))
    .orderBy(desc(events.seq));
}

/** The context of a turn of Dusty: the person's, or an outsiders' (queued for nobody). */
async function turnContext(outsiders: boolean) {
  const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.incidents, {
    state: 'queued',
    ...(outsiders ? { onBehalfOfAccountId: null } : {}),
  });
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!row) throw new Error('no dispatch');
  const context = await buildDispatchContext(t.services, row);
  await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, dispatchId));
  return context;
}

describe('web search with a Brave Search key', () => {
  it('a key Brave turns away is refused on the field and nothing is saved', async () => {
    const res = await set('BSA-wrong-key');
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.fields?.apiKey).toBeTruthy();
    expect((await burrowNow()).webSearch).toBeNull();
    expect(await webSearchEvents()).toHaveLength(0);
    expect((await check()).status).toBe(404);
  });

  it('turns it on: checked first, sealed, signed under Keys, published; the key never comes back', async () => {
    frames.length = 0;
    asked.length = 0;
    const res = await set(KEY);
    expect(res.status, res.raw).toBe(200);
    expect(res.raw).not.toContain(KEY);
    expect(asked[0]?.url).toContain('api.search.brave.com/res/v1/web/search');
    expect(asked[0]?.headers).toMatchObject({ 'X-Subscription-Token': KEY, Accept: 'application/json' });
    expect(res.body.webSearch).toMatchObject({ provider: 'brave', check: { state: 'ok', detail: null } });
    expect(res.body.burrow.webSearch).toEqual(res.body.webSearch);
    const [event] = await webSearchEvents();
    expect(event).toMatchObject({ id: res.body.eventId, kind: 'Keys', payload: { change: 'set' } });
    expect(JSON.stringify(event)).not.toContain(KEY);
    const row = await loadBurrowRow(t.services.db, t.burrowId);
    expect(row?.webSearchKeyEnc).toBeTruthy();
    expect(row?.webSearchKeyEnc).not.toContain(KEY);
    expect(row && webSearchKeyOf(t.services.custody, row)).toBe(KEY);
    const published = frames.filter((f) => f.event.type === 'burrow.updated');
    expect(published.length).toBeGreaterThan(0);
    expect(JSON.stringify(published)).not.toContain(KEY);
  });

  it('the same key again signs nothing; another key is a change', async () => {
    const before = (await webSearchEvents()).length;
    const again = await set(KEY);
    expect(again.status, again.raw).toBe(200);
    expect(again.body.eventId).toBeNull();
    expect(again.body.webSearch.check.state).toBe('ok');
    expect(await webSearchEvents()).toHaveLength(before);
    const other = await set(OTHER_KEY);
    expect(other.body.eventId).toBeTruthy();
    expect((await webSearchEvents())[0]?.payload).toEqual({ change: 'changed' });
  });

  it('a key without credit is saved with what Brave said', async () => {
    const res = await set(NO_CREDIT_KEY);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.webSearch.check).toMatchObject({ state: 'out_of_credit' });
    expect(res.body.webSearch.check.detail).toContain('402');
  });

  it('checks the saved key again and keeps the result', async () => {
    await set(KEY);
    const row = await loadBurrowRow(t.services.db, t.burrowId);
    const stored = row?.webSearch;
    if (!stored) throw new Error('not saved');
    asked.length = 0;
    const res = await check();
    expect(res.status, res.raw).toBe(200);
    expect(res.body.check.state).toBe('ok');
    expect(asked[0]?.headers['X-Subscription-Token']).toBe(KEY);
    expect((await burrowNow()).webSearch.check).toEqual(res.body.check);
  });

  it('the person’s turns carry the key, an outsiders’ turn doesn’t', async () => {
    expect((await turnContext(false)).webSearch).toEqual({ v: 1, provider: 'brave', apiKey: KEY });
    expect((await turnContext(true)).webSearch).toBeNull();
  });

  it('removes it once; a turn then has no web search', async () => {
    const removed = await call('DELETE', path());
    expect(removed.status, removed.raw).toBe(200);
    expect(removed.body).toMatchObject({ removed: true, burrow: { webSearch: null } });
    expect((await webSearchEvents())[0]?.payload).toEqual({ change: 'removed' });
    const row = await loadBurrowRow(t.services.db, t.burrowId);
    expect(row?.webSearchKeyEnc).toBeNull();
    const again = await call('DELETE', path());
    expect(again.body).toMatchObject({ removed: false, eventId: null });
    expect((await check()).status).toBe(404);
    expect((await turnContext(false)).webSearch).toBeNull();
  });
});

/** Restores records of `settings.jsonl` as the restore job's batches do. */
const restoreSettingsRecords = defineCommand({
  name: 'test_restore_web_search',
  schema: z.object({ records: z.array(z.unknown()), onDifferent: z.enum(['keep', 'replace']) }),
  async apply(tx, ctx, input) {
    const [restorer] = await tx.select().from(principals).where(eq(principals.id, IDS.mara));
    if (!restorer) throw new Error('no restorer');
    const run = new RestoreRun({
      services: ctx.services,
      db: tx,
      burrow: ctx.burrow,
      restorer,
      restorerEmail: restorer.email ?? '',
      sourceBurrowId: ctx.burrow.id,
      onDifferent: input.onDifferent,
      dry: false,
      directory: new Map(),
      ctx,
      makerEmail: restorer.email ?? '',
      scratch: null,
      blobs: new Set(),
    });
    await applyRecords(run, 'settings', input.records as BackupSettingsLine[]);
    return {};
  },
});

/** The settings record a backup file holds now. */
async function settingsRecord() {
  const burrow = await loadBurrowRow(t.services.db, t.burrowId);
  const maker = await loadPrincipalRow(t.services.db, IDS.mara);
  if (!burrow || !maker) throw new Error('seed');
  const records: Body[] = [];
  const out = {
    record: async (r: Body) => {
      records.push(r);
    },
    ref: () => {},
    blob: () => {},
    note: () => {},
  } as unknown as CategoryOut;
  const scope = {
    services: t.services,
    db: t.services.db,
    burrow,
    maker,
    makerEmail: maker.email ?? '',
    readable: new Set<string>(),
    categories: new Set(['settings']),
    scratch: '',
  } as unknown as CollectScope;
  await collectSettings(scope, out);
  const settings = records.find((r) => r.type === 'settings');
  if (!settings) throw new Error('no settings record');
  return settings;
}

const keyNow = async () => {
  const row = await loadBurrowRow(t.services.db, t.burrowId);
  return row ? webSearchKeyOf(t.services.custody, row) : null;
};

describe('a backup file', () => {
  it('holds web search with its key; a restore puts it back unchecked, and keeps a different one unless asked', async () => {
    await set(KEY);
    const settings = await settingsRecord();
    expect(settings.webSearch).toEqual({ provider: 'brave', secret: KEY });
    expect(parseBackupRecord('settings', settings).ok).toBe(true);

    // Missing here: it comes back, its key sealed again, its check forgotten.
    await call('DELETE', path());
    expect((await settingsRecord()).webSearch).toBeNull();
    const res = await t.commit(IDS.mara, restoreSettingsRecords, {
      records: [settings],
      onDifferent: 'keep',
    });
    expect(res.status, JSON.stringify(res)).toBe('ok');
    const back = await loadBurrowRow(t.services.db, t.burrowId);
    expect(back?.webSearch).toMatchObject({ provider: 'brave', check: null });
    expect(await keyNow()).toBe(KEY);

    // Another key here: kept, unless the restore replaces what differs.
    await set(OTHER_KEY);
    await t.commit(IDS.mara, restoreSettingsRecords, { records: [settings], onDifferent: 'keep' });
    expect(await keyNow()).toBe(OTHER_KEY);
    await t.commit(IDS.mara, restoreSettingsRecords, { records: [settings], onDifferent: 'replace' });
    expect(await keyNow()).toBe(KEY);
  });
});
