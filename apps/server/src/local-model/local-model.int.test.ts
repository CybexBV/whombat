/**
 * The model on the person's network end to end (hermes-engine.md HE-08, HE-32, HE-S90…; contracts CT-1170…CT-1179):
 * the person saves it (the key sealed in Postgres, signed under Keys, the burrow published), tests it against a fake
 * OpenAI-compatible server behind a home-network address (the test's result kept on the row only for the model it
 * tested), and removes it. A turn on `local` claimed by a runner carries it with its key, any other turn
 * doesn't; Chat offers it once a runner claims `local`. A backup file holds it with its key and a restore puts it back,
 * untested. It needs Postgres: the commands run through the commit pipeline, the key is sealed in the burrow's row and
 * the claim reads the dispatch queue.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type AgentProvider,
  api,
  type BackupSettingsLine,
  buildPath,
  parseBackupRecord,
  RUNNER_PREFIX,
  runnerApi,
} from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CategoryOut, CollectScope } from '../backups/collect/scope';
import { collectSettings } from '../backups/collect/settings';
import { applyRecords } from '../backups/restore/batch';
import { RestoreRun } from '../backups/restore/run';
import { providerFacts } from '../chats/runtime';
import { loadBurrowRow } from '../commit/pipeline';
import { defineCommand } from '../commit/types';
import { burrows, dispatches, events, principals } from '../db/schema/index';
import { agentRuntimeOf, loadPrincipalRow } from '../read/principals';
import type { BusFrame } from '../realtime/bus';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { agentTokenFor, sessionFor } from '../test/tokens';
import { useLocalModelNetForTests } from './check';
import { localModelKeyOf } from './store';

// biome-ignore lint/suspicious/noExplicitAny: the tests read nested JSON bodies.
type Body = Record<string, any>;

const t = useTestServer({ seed: true, app: true });
const B = { burrow: 'burrow-hq' };
const HOST = 'ollama.home.test';
const ADDRESS = '192.168.77.10';
const KEY = 'sk-local-test-key';
const RUNNER = 'rnr_local_model';
const frames: BusFrame[] = [];
let server: Server;
let base = '';

/** A tiny OpenAI-compatible server: two models, a key it checks when one is sent, and a path that isn't an API. */
function fakeModel(req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const auth = req.headers.authorization;
  if (auth && auth !== `Bearer ${KEY}`) return send(401, { error: { message: 'bad key' } });
  if (req.method === 'GET' && req.url === '/v1/models')
    return send(200, { object: 'list', data: [{ id: 'llama3.3' }, { id: 'qwen3:32b' }] });
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      const { model } = JSON.parse(raw) as { model: string };
      if (model === 'llama3.3' || model === 'qwen3:32b')
        send(200, { choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] });
      else send(404, { error: { message: `model "${model}" not found` } });
    });
    return;
  }
  send(404, { error: 'not found' });
}

beforeAll(async () => {
  server = createServer(fakeModel);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://${HOST}:${port}`;
  useLocalModelNetForTests(t.services, {
    resolve: async (host) => {
      if (host === HOST) return [{ address: ADDRESS, family: 4 }];
      // A name that points at this machine itself.
      if (host === 'self.home.test') return [{ address: '127.0.0.1', family: 4 }];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
    dialAddress: (a) => (a === ADDRESS ? '127.0.0.1' : a),
    testMs: 3000,
  });
  t.services.bus.onFrame((frame) => frames.push(frame));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(who: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, payload?: object) {
  const { cookie } = await sessionFor(t.services, who);
  const res = await t.api.inject({
    method,
    url: `/api/v1${path}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: res.json() as Body, raw: res.body };
}

const setPath = () => buildPath(api.burrows.setLocalModel.path, B);
const testPath = () => buildPath(api.burrows.testLocalModel.path, B);
const set = (who: string, body: object) => call(who, 'PUT', setPath(), body);
const test = (body: object) => call(IDS.mara, 'POST', testPath(), body);
const burrowNow = async () => (await call(IDS.mara, 'GET', buildPath(api.burrows.get.path, B))).body.burrow;

async function lastLocalModelEvent() {
  const [row] = await t.services.db
    .select()
    .from(events)
    .where(and(eq(events.burrowId, t.burrowId), eq(events.type, 'burrow.local_model_changed')))
    .orderBy(desc(events.seq))
    .limit(1);
  return row;
}

async function setAgentRuntime(runtime: { provider: AgentProvider; model?: string }) {
  const agent = await loadPrincipalRow(t.services.db, IDS.dusty);
  const { model: _model, ...rest } = agentRuntimeOf(agent?.runtime);
  await t.services.db
    .update(principals)
    .set({ runtime: { ...rest, ...runtime } })
    .where(eq(principals.id, IDS.dusty));
}

async function runner(path: string, payload: object) {
  const res = await t.api.inject({
    method: 'POST',
    url: `${RUNNER_PREFIX}${path}`,
    headers: { authorization: 'Bearer dev-runner-token' },
    payload,
  });
  return { status: res.statusCode, body: res.json() as Body };
}

/** A queued turn of Dusty, claimed at once by a runner that takes `providers`; the claim's context. */
async function claimTurn(providers: string[]) {
  const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.incidents, {
    state: 'queued',
  });
  const res = await runner(runnerApi.claim.path, { runnerId: RUNNER, providers, waitMs: 0 });
  await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, dispatchId));
  expect(res.body.dispatch?.dispatch?.id, JSON.stringify(res.body)).toBe(dispatchId);
  return res.body.dispatch as Body;
}

describe('setting it up', () => {
  it('saves, tests at once, signs under Keys and publishes the burrow; the key never comes back', async () => {
    frames.length = 0;
    const res = await set(IDS.mara, {
      baseUrl: `${base}/v1`,
      model: 'llama3.3',
      label: 'Llama on the NAS',
      apiKey: KEY,
    });
    expect(res.status, res.raw).toBe(200);
    expect(res.raw).not.toContain(KEY);
    expect(res.body.localModel).toMatchObject({
      baseUrl: `${base}/v1`,
      model: 'llama3.3',
      label: 'Llama on the NAS',
      hasApiKey: true,
      check: { state: 'ok', models: ['llama3.3', 'qwen3:32b'], detail: null },
    });
    expect(res.body.burrow.localModel).toEqual(res.body.localModel);
    expect(res.body.eventId).toBeTruthy();
    const event = await lastLocalModelEvent();
    expect(event).toMatchObject({ id: res.body.eventId, kind: 'Keys', payload: { change: 'set' } });
    expect(event?.text).toContain('Llama on the NAS');
    expect(JSON.stringify(event)).not.toContain(KEY);
    // Sealed at rest, bound to the burrow.
    const row = await loadBurrowRow(t.services.db, t.burrowId);
    expect(row?.localModelKeyEnc).toBeTruthy();
    expect(row?.localModelKeyEnc).not.toContain(KEY);
    expect(row && localModelKeyOf(t.services.custody, row)).toBe(KEY);
    // It reads back without the key.
    const published = frames.filter((f) => f.event.type === 'burrow.updated');
    expect(published.length).toBeGreaterThan(0);
    expect(JSON.stringify(published)).not.toContain(KEY);
    expect(
      (await call(IDS.mara, 'GET', buildPath(api.burrows.get.path, B))).body.burrow.localModel,
    ).toMatchObject({ model: 'llama3.3', hasApiKey: true });
  });

  it('signs nothing when nothing changed; a key left out stays only on the same server', async () => {
    const again = await set(IDS.mara, {
      baseUrl: `${base}/v1`,
      model: 'llama3.3',
      label: 'Llama on the NAS',
    });
    expect(again.status, again.raw).toBe(200);
    expect(again.body.eventId).toBeNull();
    expect(again.body.localModel.hasApiKey).toBe(true);
    // Another port is another server: the saved key doesn't go there.
    const moved = await set(IDS.mara, { baseUrl: `http://${HOST}:1/v1`, model: 'llama3.3' });
    expect(moved.status).toBe(400);
    expect(moved.body.error.code).toBe('validation_failed');
    expect(moved.body.error.fields?.apiKey).toBeTruthy();
    // Another model on the same server keeps the key; the change is signed.
    const other = await set(IDS.mara, {
      baseUrl: `${base}/v1`,
      model: 'qwen3:32b',
      label: 'Llama on the NAS',
    });
    expect(other.body.localModel).toMatchObject({
      model: 'qwen3:32b',
      hasApiKey: true,
      check: { state: 'ok' },
    });
    expect((await lastLocalModelEvent())?.payload).toEqual({ change: 'changed' });
  });

  it('refuses an address that is this Whombat itself', async () => {
    const self = await set(IDS.mara, { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.3' });
    expect(self.status).toBe(400);
    expect((await test({})).status).toBe(200);
  });
});

describe('testing it', () => {
  it('tries a draft without keeping it, and says what is wrong', async () => {
    const before = (await burrowNow()).localModel.check;
    const state = async (draft: object) => {
      const res = await test({ draft });
      expect(res.status, res.raw).toBe(200);
      return res.body.check as Body;
    };
    expect(await state({ baseUrl: `${base}/v1`, model: 'mistral' })).toMatchObject({
      state: 'no_model',
      models: ['llama3.3', 'qwen3:32b'],
    });
    expect((await state({ baseUrl: `${base}/v1`, model: 'llama3.3', apiKey: 'sk-wrong' })).state).toBe(
      'refused',
    );
    expect((await state({ baseUrl: `${base}/nothing`, model: 'llama3.3', apiKey: null })).state).toBe(
      'not_compatible',
    );
    expect((await state({ baseUrl: `http://${HOST}:1/v1`, model: 'llama3.3', apiKey: null })).state).toBe(
      'unreachable',
    );
    const port = new URL(base).port;
    expect(
      (await state({ baseUrl: `http://self.home.test:${port}/v1`, model: 'llama3.3', apiKey: null })).state,
    ).toBe('blocked');
    // A draft is only tried: the saved model's last test stays.
    expect((await burrowNow()).localModel.check).toEqual(before);
  });

  it('checks the saved one again and keeps the result', async () => {
    const saved = (await loadBurrowRow(t.services.db, t.burrowId))?.localModel;
    if (!saved) throw new Error('not saved');
    await t.services.db
      .update(burrows)
      .set({ localModel: { ...saved, check: null } })
      .where(eq(burrows.id, t.burrowId));
    const res = await test({});
    expect(res.body.check.state).toBe('ok');
    expect((await burrowNow()).localModel.check).toEqual(res.body.check);
  });
});

describe('turns and Chat on it', () => {
  it('Chat offers it once a runner claims `local`, with the burrow’s models', async () => {
    const agent = await loadPrincipalRow(t.services.db, IDS.dusty);
    const mara = await loadPrincipalRow(t.services.db, IDS.mara);
    if (!agent || !mara) throw new Error('seed');
    const facts = await providerFacts(t.services, agent, mara, 'local');
    expect(facts.models?.map((m) => m.id)).toEqual(['qwen3:32b', 'llama3.3']);
    expect(facts.models?.[0]).toMatchObject({ label: 'Llama on the NAS', isDefault: true, efforts: [] });
    // A runner that claims `local` (nothing queued for it yet).
    await runner(runnerApi.claim.path, { runnerId: RUNNER, providers: ['local'], waitMs: 0 });
    expect((await providerFacts(t.services, agent, mara, 'local')).ready).toBe(true);
  });

  it('a turn on `local` carries the model and its key; another turn doesn’t', async () => {
    await setAgentRuntime({ provider: 'local', model: 'llama3.3' });
    const onLocal = await claimTurn(['local']);
    expect(onLocal.localModel).toEqual({
      v: 1,
      baseUrl: `${base}/v1`,
      model: 'llama3.3',
      defaultModel: 'qwen3:32b',
      apiKey: KEY,
    });
    // Without a model of its own: the burrow's.
    await setAgentRuntime({ provider: 'local' });
    expect((await claimTurn(['local'])).localModel).toMatchObject({
      model: 'qwen3:32b',
      defaultModel: 'qwen3:32b',
    });
    await setAgentRuntime({ provider: 'claude' });
    expect((await claimTurn(['claude'])).localModel ?? null).toBeNull();
  });
});

/** Restores records of `people.jsonl` as the restore job's batches do. */
const restorePeopleRecords = defineCommand({
  name: 'test_restore_local_model',
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

describe('removing it, and a backup file', () => {
  it('a backup file holds it with its key; removing it signs once; a restore puts it back untested', async () => {
    // Making the file: the settings record carries the model and its key, as the contract reads it.
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
    expect(settings?.localModel).toEqual({
      baseUrl: `${base}/v1`,
      model: 'qwen3:32b',
      label: 'Llama on the NAS',
      secret: KEY,
    });
    expect(parseBackupRecord('settings', settings).ok).toBe(true);

    // Removing it.
    const removed = await call(IDS.mara, 'DELETE', setPath());
    expect(removed.status, removed.raw).toBe(200);
    expect(removed.body).toMatchObject({ removed: true, burrow: { localModel: null } });
    expect((await lastLocalModelEvent())?.payload).toEqual({ change: 'removed' });
    const again = await call(IDS.mara, 'DELETE', setPath());
    expect(again.body).toMatchObject({ removed: false, eventId: null });
    expect((await test({})).status).toBe(404);
    await setAgentRuntime({ provider: 'local' });
    expect((await claimTurn(['local'])).localModel ?? null).toBeNull();
    await setAgentRuntime({ provider: 'claude' });

    // Restoring the file puts it back as it was, untested, its key sealed again.
    const res = await t.commit(IDS.mara, restorePeopleRecords, { records: [settings], onDifferent: 'keep' });
    expect(res.status, JSON.stringify(res)).toBe('ok');
    const back = await loadBurrowRow(t.services.db, t.burrowId);
    expect(back?.localModel).toMatchObject({
      baseUrl: `${base}/v1`,
      model: 'qwen3:32b',
      label: 'Llama on the NAS',
      check: null,
    });
    expect(back && localModelKeyOf(t.services.custody, back)).toBe(KEY);
  });
});
