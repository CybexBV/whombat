/**
 * Hermes's asks through the turn's logins service (vault-simplify.md VLT-45): the card through `runner.loginAsk`, a
 * long poll on it, and what Hermes hears — a saved login (its password fetched as every login's), a code once, or a
 * decline when the wait runs out. Never a value in a log.
 */
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoginAskWaitReply } from '@whombat/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOGIN_ASK_DECLINED,
  LOGIN_ASK_TIMED_OUT,
  LOGIN_NO_ASK,
  type LoginAsker,
  loginAsker,
  TurnLogins,
} from './logins';

function send(socket: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const s = connect(socket);
    let buf = '';
    s.on('data', (d) => {
      buf += d;
    });
    // A turn that ended closes the socket without an answer: nothing to read.
    s.on('close', () => resolve(buf.trim() ? JSON.parse(buf.trim()) : {}));
    s.on('error', reject);
    s.write(`${JSON.stringify(request)}\n`);
  });
}

const lease = { runnerId: 'rnr_1', attempt: 1 };

/** The server's two calls standing in: the card's answers in order, and what was asked. */
function fakeApi(replies: LoginAskWaitReply[], until = new Date(Date.now() + 600_000).toISOString()) {
  const asked: unknown[] = [];
  const waits: number[] = [];
  return {
    asked,
    waits,
    api: {
      loginAsk: async (_d: string, body: unknown) => {
        asked.push(body);
        return { status: 'asked' as const, messageId: 'msg_card', until };
      },
      loginAskWait: async (_d: string, _m: string, q: { waitMs: number }) => {
        waits.push(q.waitMs);
        const next = replies.shift();
        if (next) return next;
        // Nothing yet: a long poll's wait, as the server holds it.
        await new Promise((r) => setTimeout(r, q.waitMs));
        return { status: 'pending' as const };
      },
    },
  };
}

describe('Hermes’s asks (VLT-45)', () => {
  const open: TurnLogins[] = [];
  afterEach(async () => {
    for (const l of open.splice(0)) await l.close();
  });

  async function service(ask: LoginAsker | undefined, entries: string[] = []) {
    const logs: string[] = [];
    const logins = await TurnLogins.open(
      {
        tmpRoot: join(tmpdir(), 'wb-login-asks-test'),
        log: (_l, m) => logs.push(m),
        fetchSecret: async (id) => ({ password: `pw-of-${id}-Secret`, otp: null }),
        ask,
      },
      `dsp_la${Math.random().toString(36).slice(2, 8)}`,
      entries,
    );
    open.push(logins);
    return { logins, logs };
  }

  it('waits on the card until the person saves the login, then gives it like any of the turn’s', async () => {
    const fake = fakeApi([
      { status: 'pending' },
      {
        status: 'saved',
        login: {
          entryId: 'vlt_new',
          name: 'github.com',
          origin: 'https://github.com',
          username: 'mara',
          otp: false,
        },
      },
    ]);
    const ask = loginAsker({ api: fake.api, dispatchId: 'dsp_1', lease, log: () => {}, pollMs: 50 });
    const { logins, logs } = await service(ask);
    const answer = await send(logins.socket, { ask: 'login', origin: 'https://github.com', username: null });
    expect(answer).toEqual({ identifier: 'mara', password: 'pw-of-vlt_new-Secret', entry: 'vlt_new' });
    expect(fake.asked).toEqual([{ ...lease, kind: 'login', origin: 'https://github.com', username: null }]);
    expect(fake.waits.every((w) => w <= 50)).toBe(true);
    // It is one of the turn's logins now: a fill of it works.
    expect(await send(logins.socket, { entry: 'vlt_new' })).toMatchObject({
      password: 'pw-of-vlt_new-Secret',
    });
    expect(logs.join('\n')).not.toContain('Secret');
  });

  it('gives a code once, and hears Not now and a wait that ran out as declined', async () => {
    const code = loginAsker({
      api: fakeApi([{ status: 'code', code: '424242' }]).api,
      dispatchId: 'dsp_1',
      lease,
      log: () => {},
    });
    const { logins, logs } = await service(code);
    expect(await send(logins.socket, { ask: 'code', origin: 'https://github.com' })).toEqual({
      code: '424242',
    });
    expect(logs.join('\n')).not.toContain('424242');
    const no = loginAsker({
      api: fakeApi([{ status: 'declined' }]).api,
      dispatchId: 'd',
      lease,
      log: () => {},
    });
    expect(await no('login', 'https://github.com', null, new AbortController().signal)).toEqual({
      declined: LOGIN_ASK_DECLINED,
    });
    const late = loginAsker({
      api: fakeApi([{ status: 'timed_out' }]).api,
      dispatchId: 'd',
      lease,
      log: () => {},
    });
    expect(await late('code', 'https://github.com', null, new AbortController().signal)).toEqual({
      declined: LOGIN_ASK_TIMED_OUT,
    });
    // The card's wait is over before anything came: declined without another poll.
    let t = 0;
    const over = fakeApi([], new Date(1_000).toISOString());
    const past = loginAsker({
      api: over.api,
      dispatchId: 'd',
      lease,
      log: () => {},
      now: () => (t += 2_000),
    });
    expect(await past('login', 'https://github.com', null, new AbortController().signal)).toEqual({
      declined: LOGIN_ASK_TIMED_OUT,
    });
    expect(over.waits).toEqual([]);
  });

  it('asks nobody in a turn that can’t ask, or for something that isn’t an https origin', async () => {
    const { logins } = await service(undefined);
    expect(await send(logins.socket, { ask: 'login', origin: 'https://github.com' })).toEqual({
      declined: true,
      error: LOGIN_NO_ASK,
    });
    const fake = fakeApi([]);
    const { logins: other } = await service(
      loginAsker({ api: fake.api, dispatchId: 'd', lease, log: () => {} }),
    );
    expect(await send(other.socket, { ask: 'login', origin: 'http://github.com' })).toMatchObject({
      declined: true,
    });
    expect(await send(other.socket, { ask: 'shell', origin: 'https://github.com' })).toMatchObject({
      declined: true,
    });
    expect(fake.asked).toEqual([]);
  });

  it('ends a wait when the turn does', async () => {
    const fake = fakeApi([]);
    const ask = loginAsker({ api: fake.api, dispatchId: 'd', lease, log: () => {}, pollMs: 20 });
    const { logins } = await service(ask);
    const pending = send(logins.socket, { ask: 'login', origin: 'https://github.com' }).catch(() => ({}));
    while (!fake.waits.length) await new Promise((r) => setTimeout(r, 5));
    await logins.close();
    // Hermes's plugin hears nothing back, which it takes as declined.
    expect(await pending).toEqual({});
  });
});
