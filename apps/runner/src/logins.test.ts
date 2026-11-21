/**
 * The turn's logins service (hermes-engine.md HE-S141): a login of the turn's own, fetched at that moment, nothing
 * else; gone with the turn.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunnerApiError } from './api';
import { KEPT_NOT_HERE, KEPT_NOTHING_SIGNED_IN, KeptSiteRefusal, type KeptSitesRoute } from './kept-sites';
import { LOGIN_NOT_THIS_TURN, LOGIN_UNAVAILABLE, type LoginSecret, PodLogins, TurnLogins } from './logins';
import { keptSite } from './test-devtools';

/** One request as Hermes's vault sends it: the answer line, parsed. */
function ask(socket: string, line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const s = connect(socket);
    let buf = '';
    s.on('data', (d) => {
      buf += d;
    });
    s.on('end', () => resolve(JSON.parse(buf.trim())));
    s.on('error', reject);
    s.write(`${line}\n`);
  });
}

describe('a turn’s logins service (HE-S141)', () => {
  const open: TurnLogins[] = [];
  afterEach(async () => {
    for (const l of open.splice(0)) await l.close();
  });

  async function setUp(fetchSecret: (entryId: string) => Promise<LoginSecret>) {
    const logs: string[] = [];
    const fetched: string[] = [];
    const logins = await TurnLogins.open(
      {
        tmpRoot: join(tmpdir(), 'wb-logins-test'),
        log: (_l, m) => logs.push(m),
        fetchSecret: (id) => {
          fetched.push(id);
          return fetchSecret(id);
        },
      },
      `dsp_lg${Math.random().toString(36).slice(2, 8)}`,
      ['vlt_github'],
    );
    open.push(logins);
    return { logins, logs, fetched };
  }

  it('gives a login of the turn’s own at the moment Hermes fills it, and logs no secret', async () => {
    const { logins, logs, fetched } = await setUp(async () => ({
      password: 'hunter2-secret',
      otp: '123456',
    }));
    expect(fetched).toEqual([]);
    expect(await ask(logins.socket, JSON.stringify({ entry: 'vlt_github' }))).toEqual({
      password: 'hunter2-secret',
      otp: '123456',
    });
    expect(fetched).toEqual(['vlt_github']);
    expect(logs.join('\n')).not.toContain('hunter2-secret');
    expect(logs.join('\n')).toContain('vlt_github');
  });

  it('never fetches a login the turn doesn’t list, or what isn’t a request', async () => {
    const { logins, fetched } = await setUp(async () => ({ password: 'x', otp: null }));
    expect(await ask(logins.socket, JSON.stringify({ entry: 'vlt_someone_else' }))).toEqual({
      error: LOGIN_NOT_THIS_TURN,
    });
    expect(await ask(logins.socket, 'not json')).toEqual({ error: LOGIN_NOT_THIS_TURN });
    expect(fetched).toEqual([]);
  });

  it('says so when the server won’t give it (the lease lost, the login switched off)', async () => {
    const { logins } = await setUp(async () => {
      throw new Error('409');
    });
    expect(await ask(logins.socket, JSON.stringify({ entry: 'vlt_github' }))).toEqual({
      error: LOGIN_UNAVAILABLE,
    });
  });

  it('keeps no website signed in in a turn of its own (an outsiders’ turn, an assessment)', async () => {
    const { logins, fetched } = await setUp(async () => ({ password: 'x', otp: null }));
    for (const request of [
      { keep: { origins: ['https://accounts.example.com'] } },
      { forget: { origins: ['https://accounts.example.com'] } },
      { kept: 'list' },
    ])
      expect(await ask(logins.socket, JSON.stringify(request))).toEqual({ ok: false, error: KEPT_NOT_HERE });
    expect(fetched).toEqual([]);
  });

  it('is gone with the turn', async () => {
    const { logins } = await setUp(async () => ({ password: 'x', otp: null }));
    await logins.close();
    expect(existsSync(logins.socket)).toBe(false);
    await expect(ask(logins.socket, JSON.stringify({ entry: 'vlt_github' }))).rejects.toThrow();
  });
});

describe('the agent’s kept sites over a pod’s logins socket (kept-sites.md)', () => {
  const open: PodLogins[] = [];
  afterEach(async () => {
    for (const l of open.splice(0)) await l.close();
  });

  async function setUp(kept: KeptSitesRoute) {
    const socket = join(mkdtempSync(join(tmpdir(), 'wb-kept-logins-')), 'logins.sock');
    const logins = await PodLogins.open(
      socket,
      () => {},
      (session) =>
        session === 'sess-1'
          ? {
              dispatchId: 'dsp_1',
              entries: new Set(),
              fetchSecret: async () => ({ password: '', otp: null }),
              kept,
            }
          : null,
    );
    open.push(logins);
    return socket;
  }

  it('checks the origins and hours before anything happens, and answers the site without a cookie', async () => {
    const asked: [string[], number | undefined][] = [];
    const socket = await setUp({
      keep: async (origins, hours) => {
        asked.push([origins, hours]);
        return keptSite('kst_site00000001', origins, { hours: hours ?? 4 });
      },
      forget: async () => [],
      list: async () => [],
    });
    const keep = (body: unknown) => ask(socket, JSON.stringify({ keep: body, session: 'sess-1' }));
    for (const bad of [
      { origins: ['http://accounts.example.com'] },
      { origins: ['https://accounts.example.com/login'] },
      { origins: [] },
      { origins: ['https://accounts.example.com'], hours: 0 },
      { origins: ['https://accounts.example.com'], hours: 25 },
      { origins: ['https://accounts.example.com'], hours: 2.5 },
      { origins: ['https://accounts.example.com'], hours: '4' },
    ])
      expect((await keep(bad)).ok, JSON.stringify(bad)).toBe(false);
    expect(asked).toEqual([]);
    expect(await keep({ origins: ['https://accounts.example.com'], hours: 24 })).toMatchObject({
      ok: true,
      site: { id: 'kst_site00000001', hours: 24 },
    });
    expect(await keep({ origins: ['https://accounts.example.com'] })).toMatchObject({ ok: true });
    expect(asked).toEqual([
      [['https://accounts.example.com'], 24],
      [['https://accounts.example.com'], undefined],
    ]);
    // An unknown session gets nothing.
    expect(await ask(socket, JSON.stringify({ kept: 'list', session: 'sess-2' }))).toEqual({
      ok: false,
      error: KEPT_NOT_HERE,
    });
  });

  it('says why a keep didn’t happen', async () => {
    const socket = await setUp({
      keep: async () => {
        throw new KeptSiteRefusal(KEPT_NOTHING_SIGNED_IN);
      },
      forget: async () => {
        throw new RunnerApiError(403, null, 'not in an assessment');
      },
      list: async () => {
        throw new RunnerApiError(409, null, 'lease lost');
      },
    });
    const origins = ['https://accounts.example.com'];
    expect(await ask(socket, JSON.stringify({ keep: { origins }, session: 'sess-1' }))).toEqual({
      ok: false,
      error: KEPT_NOTHING_SIGNED_IN,
    });
    expect(await ask(socket, JSON.stringify({ forget: { origins }, session: 'sess-1' }))).toEqual({
      ok: false,
      error: KEPT_NOT_HERE,
    });
    expect((await ask(socket, JSON.stringify({ kept: 'list', session: 'sess-1' }))).ok).toBe(false);
  });
});
