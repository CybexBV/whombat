/**
 * What the agent remembers, over REST (contracts 0.125 `api.memory`; hermes-engine.md HE-39, HE-S122): the person's
 * Hermes memory through the runner's service (in this process, on a throwaway root), the refusals as the contracts
 * describe them, and the agent's notes the person reads and changes. Needs Postgres: the person, their sessions and
 * the notes are rows.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptedHermesLauncher } from '@whombat/agent-runtime/testing/hermes';
import { type AgentNotes, api, buildPath, type PersonMemory } from '@whombat/core';
import { HermesHomeService } from '@whombat/runner';
import { beforeAll, describe, expect, it } from 'vitest';
import { useHermesHome } from '../hermes-home/service';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
let home: HermesHomeService;
let mara = '';

const params = { burrow: 'burrow-hq' };
const url = (path: string, p: Record<string, string> = params) => `/api/v1${buildPath(path, p)}`;

async function call(method: 'GET' | 'PUT' | 'DELETE', path: string, cookie: string, body?: unknown) {
  const res = await t.api.inject({
    method,
    url: path,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Record<string, unknown> };
}

const write = (cookie: string, file: 'memory' | 'user', body: { text: string; ifVersion?: string }) =>
  call('PUT', url(api.memory.write.path, { ...params, file }), cookie, body);
const reasonOf = (body: Record<string, unknown>) =>
  (body.error as { details?: { reason?: string } } | undefined)?.details?.reason;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whombat-memory-'));
  // A short wait for the profile's lock, so a turn holding it answers `busy` quickly.
  home = new HermesHomeService({
    root: join(dir, 'root'),
    bin: await scriptedHermesLauncher(dir),
    lockWaitMs: 100,
  });
  useHermesHome(t.services, home);
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
});

describe('the person’s memory (HE-S122, OP-08)', () => {
  it('writes and reads the person’s own files (OP-08: one Hermes home)', async () => {
    const wrote = await write(mara, 'user', { text: 'Mara keeps bees.\n§\nShe likes short answers.' });
    expect(wrote.status, JSON.stringify(wrote.body)).toBe(200);
    const memory = wrote.body as unknown as PersonMemory;
    expect(memory.user).toMatchObject({ text: 'Mara keeps bees.\n§\nShe likes short answers.', limit: 1375 });
    expect(memory.user.used).toBeGreaterThan(0);
    expect(memory.user.version).toBeTruthy();
    expect(memory.memory.text).toBe('');
    const read = await call('GET', url(api.memory.mine.path), mara);
    expect((read.body as unknown as PersonMemory).user.text).toContain('bees');
  });

  it('refuses a stale edit, an over-long file and an edit while a turn holds the profile', async () => {
    const before = (await call('GET', url(api.memory.mine.path), mara)).body as unknown as PersonMemory;
    const version = before.user.version as string;
    expect(
      (await write(mara, 'user', { text: 'Mara keeps bees and goats.', ifVersion: version })).status,
    ).toBe(200);
    // Started from the old version: the file changed since.
    const stale = await write(mara, 'user', { text: 'Mara keeps cats.', ifVersion: version });
    expect(stale.status).toBe(409);
    expect((stale.body.error as { code: string }).code).toBe('conflict');
    const long = await write(mara, 'user', { text: 'x'.repeat(1_400) });
    expect((long.body.error as { code: string }).code).toBe('validation_failed');
    expect(reasonOf(long.body)).toBe('too_long');
    await home.ctx.withProfile(async () => {
      const busy = await write(mara, 'memory', { text: 'Deploys on Tuesdays.' });
      expect(busy.status).toBe(409);
      expect(reasonOf(busy.body)).toBe('busy');
    });
    const now = (await call('GET', url(api.memory.mine.path), mara)).body as unknown as PersonMemory;
    expect(now.user.text).toBe('Mara keeps bees and goats.');
    expect(now.memory.text).toBe('');
  });

  it('forgets one file, then everything', async () => {
    await write(mara, 'memory', { text: 'Deploys on Tuesdays.' });
    const one = await call('DELETE', `${url(api.memory.clear.path)}?file=user`, mara);
    expect(one.status).toBe(200);
    expect(one.body as unknown as PersonMemory).toMatchObject({
      user: { text: '' },
      memory: { text: 'Deploys on Tuesdays.' },
    });
    const all = await call('DELETE', url(api.memory.clear.path), mara);
    expect(all.body as unknown as PersonMemory).toMatchObject({ user: { text: '' }, memory: { text: '' } });
  });
});

describe('the agent’s notes (HE-S120)', () => {
  it('the person writes them and reads them back', async () => {
    const empty = await call('GET', url(api.memory.notes.path), mara);
    expect(empty.body as unknown as AgentNotes).toMatchObject({ text: '', updatedAt: null });
    const set = await call('PUT', url(api.memory.setNotes.path), mara, { text: 'Backups run at 2:00.' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body as unknown as AgentNotes).toMatchObject({ text: 'Backups run at 2:00.', used: 20 });
    const read = await call('GET', url(api.memory.notes.path), mara);
    expect(read.body as unknown as AgentNotes).toMatchObject({ text: 'Backups run at 2:00.' });
  });
});
