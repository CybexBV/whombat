import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ONEPASSWORD_WORDS } from '@whombat/core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../services';
import { OnePasswordError, OnePasswordPool, readGetAnswer } from './pool';
import {
  classifyError,
  createWorker,
  guardFetch,
  onePasswordAddressAllowed,
  type Sdk,
  type SdkClient,
  scrubText,
} from './worker';

class RateLimitExceededError extends Error {}
class AuthExpiredError extends Error {}

const TOKEN = 'ops_eyJzaWduSW5BZGRyZXNzIjoibXkuMXBhc3N3b3JkLmNvbSJ9Abc123';

/** A stand-in SDK: one vault, one item, and errors on demand. */
function fakeSdk(behaviour: { fail?: Error } = {}) {
  const createClient = vi.fn(async (_config: { auth: string }) => {
    const client: SdkClient = {
      vaults: {
        list: async () => [{ id: 'v1', title: 'Whombat', extra: 'ignored' }],
        getOverview: async (id) => ({ id, title: 'Whombat', createdAt: new Date('2026-11-24T08:00:00Z') }),
      },
      items: {
        list: async () => [],
        getAll: async (_vault, ids) => ({
          individualResponses: ids.map((id) =>
            id === 'missing'
              ? { error: { type: 'itemNotFound' } }
              : id === 'nulled'
                ? { content: null, error: { type: 'itemNotFound' } }
                : id === 'broken'
                  ? { error: { type: 'internal' } }
                  : { content: { id, files: [{ content: new Uint8Array([1, 2]) }] } },
          ),
        }),
        create: async () => {
          throw behaviour.fail ?? new Error('no');
        },
        put: async (item) => {
          if (behaviour.fail) throw behaviour.fail;
          return item;
        },
        archive: async () => {},
      },
    };
    return client;
  });
  const sdk: Sdk = { createClient, RateLimitExceededError, AuthExpiredError };
  return { sdk, createClient };
}

async function run(worker: ReturnType<typeof createWorker>, out: string[], request: object) {
  await worker.handle(JSON.stringify(request));
  return JSON.parse(out.at(-1) as string);
}

describe('the worker’s protocol (OPW-30)', () => {
  it('answers each line by its id, with one SDK client per token', async () => {
    const { sdk, createClient } = fakeSdk();
    const out: string[] = [];
    const worker = createWorker({ loadSdk: async () => sdk, write: (l) => out.push(l) });
    expect(await run(worker, out, { id: 1, call: 'check', token: TOKEN })).toEqual({
      id: 1,
      ok: true,
      result: { vaults: [{ id: 'v1', title: 'Whombat' }] },
    });
    const overview = await run(worker, out, { id: 2, call: 'overview', token: TOKEN, vaultId: 'v1' });
    // Dates as ISO text.
    expect(overview.result.createdAt).toBe('2026-11-24T08:00:00.000Z');
    const got = await run(worker, out, {
      id: 3,
      call: 'get',
      token: TOKEN,
      vaultId: 'v1',
      itemIds: ['a1', 'missing', 'nulled', 'broken'],
    });
    expect(got.result).toEqual({
      items: [{ id: 'a1', files: [{ content: [1, 2] }] }],
      // An answer that has no item beside its error is no item, never an item that is null.
      missing: ['missing', 'nulled'],
      failed: ['broken'],
    });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient.mock.calls[0]?.[0]).toMatchObject({ auth: TOKEN, integrationName: 'Whombat' });
    // A line that isn't a request.
    expect(await run(worker, out, { call: 'check' })).toMatchObject({
      id: 0,
      ok: false,
      error: { kind: 'invalid' },
    });
  });

  it('says why a call failed, without the token or the item’s values', async () => {
    const { sdk } = fakeSdk({
      fail: new Error(`bad request for ${TOKEN}: field value s3cret-value is invalid`),
    });
    const out: string[] = [];
    const worker = createWorker({ loadSdk: async () => sdk, write: (l) => out.push(l) });
    const reply = await run(worker, out, {
      id: 4,
      call: 'put',
      token: TOKEN,
      item: { id: 'a1', fields: [{ value: 's3cret-value' }] },
    });
    expect(reply.ok).toBe(false);
    expect(reply.error.kind).toBe('failed');
    expect(reply.error.message).not.toContain(TOKEN);
    expect(reply.error.message).not.toContain('s3cret-value');
    expect(out.join('\n')).not.toContain(TOKEN);
  });

  it('tells the limit, a refused token (and signs in again next time) and a read-only token apart', async () => {
    const limited = fakeSdk({ fail: new RateLimitExceededError('Too many requests') });
    const out: string[] = [];
    const a = createWorker({ loadSdk: async () => limited.sdk, write: (l) => out.push(l) });
    expect((await run(a, out, { id: 1, call: 'put', token: TOKEN, item: {} })).error.kind).toBe('limit');

    const expired = fakeSdk({ fail: new AuthExpiredError('expired') });
    const b = createWorker({ loadSdk: async () => expired.sdk, write: (l) => out.push(l) });
    expect((await run(b, out, { id: 1, call: 'put', token: TOKEN, item: {} })).error.kind).toBe('auth');
    await run(b, out, { id: 2, call: 'check', token: TOKEN });
    expect(expired.createClient).toHaveBeenCalledTimes(2);

    expect(classifyError(new Error('You do not have permission to update items in this vault'), null)).toBe(
      'forbidden',
    );
    expect(classifyError(new TypeError('fetch failed'), null)).toBe('network');
    expect(classifyError(new Error('The request timed out'), null)).toBe('network');
    expect(classifyError(new Error('timeout while waiting for the server'), null)).toBe('network');
    expect(classifyError(new Error('invalid service account token'), null)).toBe('auth');
  });

  it('scrubs a token’s shape even when it wasn’t sent, and cuts long words', () => {
    expect(scrubText('token ops_abcdefghijklmnop was refused', [])).toBe('token [hidden] was refused');
    expect(scrubText('x'.repeat(400), []).length).toBe(300);
    // Values too short to be secrets stay, so the words still read.
    expect(scrubText('a field is empty', ['a'])).toBe('a field is empty');
  });
});

describe('reading a get’s answer', () => {
  it('reads each item on its own: one that doesn’t read is failed, the others come through', () => {
    const item = (id: string) => ({
      id,
      title: 'Mail',
      category: 'Login',
      vaultId: 'v1',
      fields: [],
      sections: [],
      notes: '',
      tags: [],
      websites: [],
      version: 1,
      createdAt: '2026-11-24T08:00:00.000Z',
      updatedAt: '2026-11-24T08:00:00.000Z',
    });
    const answer = readGetAnswer({
      items: [item('a1'), { ...item('b2'), fields: 'not a list' }, item('c3')],
      missing: ['gone'],
      failed: ['busy'],
    });
    expect(answer.items.map((i) => i.id)).toEqual(['a1', 'c3']);
    expect(answer.missing).toEqual(['gone']);
    expect(answer.failed).toEqual(['busy', 'b2']);
  });
});

describe('the worker’s network (OPW-31)', () => {
  it('goes only to 1Password’s own hosts, over https', () => {
    for (const ok of [
      'https://my.1password.com/api/v1/auth',
      'https://my.1password.eu/x',
      'https://acme.1password.ca/',
      'https://1password.com/',
    ])
      expect(onePasswordAddressAllowed(ok), ok).toBe(true);
    for (const no of [
      'http://my.1password.com/',
      'https://my.1password.com:8443/',
      'https://1password.com.evil.example/',
      'https://evil1password.com/',
      'https://user:pw@my.1password.com/',
      'https://example.com/',
      'not a url',
    ])
      expect(onePasswordAddressAllowed(no), no).toBe(false);
  });

  it('refuses elsewhere before any request, and never follows a redirect', async () => {
    const real = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response('ok'));
    const guarded = guardFetch(real as unknown as typeof fetch);
    await expect(guarded('https://example.com/steal')).rejects.toThrow(/reaches only 1Password/);
    expect(real).not.toHaveBeenCalled();
    await guarded(new Request('https://my.1password.com/api'));
    expect(real.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });
});

describe('the worker process (OPW-30)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whombat-1p-worker-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('loads 1Password’s SDK and its WASM in a process of its own, with no network', async () => {
    const pool = new OnePasswordPool({ log: silentLogger });
    try {
      await expect(pool.probe()).resolves.toEqual({ loaded: true });
      expect(pool.running).toBe(true);
    } finally {
      pool.close();
    }
  }, 60_000);

  it('a worker that dies fails its calls with the stopped words, and the next call starts a new one', async () => {
    const crash = join(dir, 'crash.mjs');
    writeFileSync(crash, "process.stdin.once('data', () => process.exit(3));\n");
    const pool = new OnePasswordPool({ log: silentLogger, url: pathToFileURL(crash) });
    try {
      const err = await pool.check(TOKEN).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OnePasswordError);
      expect((err as OnePasswordError).kind).toBe('stopped');
      expect((err as OnePasswordError).message).toBe(ONEPASSWORD_WORDS.stopped);
      await pool.check(TOKEN).catch(() => {});
      expect(pool.started).toBe(2);
    } finally {
      pool.close();
    }
  });

  it('a worker that stops answering is stopped at the deadline, and idles out', async () => {
    const hang = join(dir, 'hang.mjs');
    writeFileSync(hang, "process.stdin.on('data', () => {});\n");
    const pool = new OnePasswordPool({ log: silentLogger, url: pathToFileURL(hang), timeoutMs: 200 });
    try {
      const err = await pool.check(TOKEN).catch((e: unknown) => e);
      expect((err as OnePasswordError).kind).toBe('stopped');
      expect(pool.running).toBe(false);
    } finally {
      pool.close();
    }
    const echo = join(dir, 'echo.mjs');
    writeFileSync(
      echo,
      [
        "import { createInterface } from 'node:readline';",
        "createInterface({ input: process.stdin }).on('line', (l) => {",
        '  const r = JSON.parse(l);',
        "  process.stdout.write(JSON.stringify({ id: r.id, ok: true, result: { vaults: [] } }) + '\\n');",
        '});',
      ].join('\n'),
    );
    const idle = new OnePasswordPool({ log: silentLogger, url: pathToFileURL(echo), idleMs: 50 });
    try {
      await expect(idle.check(TOKEN)).resolves.toEqual({ vaults: [] });
      await vi.waitFor(() => expect(idle.running).toBe(false), { timeout: 2000, interval: 20 });
    } finally {
      idle.close();
    }
  });
});
