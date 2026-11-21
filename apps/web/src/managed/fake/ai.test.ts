import { api } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { createFakeAi, type FakeAiAnswer, restAnswer, sessionAnswer } from './ai';

const text = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const body = <T>(a: FakeAiAnswer | null) => a?.body as T;

describe('the fake AI side (fixtures and the fake managed world)', () => {
  it('installs Claude Code over time at the latest tested version', async () => {
    let t = 1_000_000;
    const ai = createFakeAi({ now: () => t, installMs: 4_000 });
    const list = () => body<{ clients: { provider: string; state: string; progress: number | null }[] }>;
    const first = list()(await ai.call('clients.list'));
    // Claude Code is the only client (AP-5619).
    expect(first.clients.map((c) => [c.provider, c.state])).toEqual([['claude', 'not_installed']]);
    api.clients.list.response.parse(first);

    const started = await ai.call('clients.install', { provider: 'claude' });
    expect(body<{ state: string; progress: number }>(started)).toMatchObject({
      state: 'installing',
      progress: 0,
    });
    t += 2_000;
    expect(list()(await ai.call('clients.list')).clients[0]).toMatchObject({
      state: 'installing',
      progress: 50,
    });
    t += 2_000;
    const done = list()(await ai.call('clients.list'));
    expect(done.clients[0]).toMatchObject({ state: 'installed', installed: { version: '2.1.278' } });
    api.clients.list.response.parse(done);
  });

  it('refuses to install anything for ChatGPT, as the runtime does (AP-5619)', async () => {
    const ai = createFakeAi();
    const refused = await ai.call('clients.install', { provider: 'codex' });
    expect(refused).toMatchObject({ status: 400, error: { code: 'validation_failed' } });
    expect(refused?.error?.message).toContain('ChatGPT');
    expect(restAnswer(refused as FakeAiAnswer).body).toMatchObject({
      error: { code: 'validation_failed', details: { code: 'validation_failed' } },
    });
    expect((await ai.call('clients.remove', { provider: 'codex' }))?.status).toBe(404);
    const list = body<{ clients: { provider: string }[] }>(await ai.call('clients.list'));
    expect(list.clients.map((c) => c.provider)).toEqual(['claude']);
  });

  it('says why an install failed', async () => {
    let t = 0;
    const ai = createFakeAi({ now: () => t, failInstall: ['claude'] });
    await ai.call('clients.install', { provider: 'claude' });
    t += 10_000;
    const c = body<{ clients: { state: string; error: { code: string } | null }[] }>(
      await ai.call('clients.list'),
    );
    expect(c.clients[0]).toMatchObject({ state: 'failed', error: { code: 'client.install_failed' } });
  });

  it('signs in to ChatGPT with a device code after a few polls', async () => {
    const ai = createFakeAi({ deviceCompletesAfterPolls: 2 });
    const login = body<{ loginId: string; state: string; device: { userCode: string } }>(
      await ai.call('signins.loginStart', {}, {}, { provider: 'codex', authMode: 'chatgpt' }),
    );
    expect(login.state).toBe('awaiting_user');
    api.signins.loginStart.response.parse(login);
    expect(
      body<{ state: string }>(await ai.call('signins.loginStatus', { loginId: login.loginId })).state,
    ).toBe('awaiting_user');
    expect(
      body<{ state: string }>(await ai.call('signins.loginStatus', { loginId: login.loginId })).state,
    ).toBe('completed');
    const list = body<{ signIns: { provider: string; authMode: string; state: string }[] }>(
      await ai.call('signins.list'),
    );
    expect(list.signIns).toMatchObject([{ provider: 'codex', authMode: 'chatgpt', state: 'ready' }]);
    api.signins.list.response.parse(list);
  });

  it('has no organization keys: one sign-in per provider (CT-1503)', async () => {
    const ai = createFakeAi();
    expect(await ai.call('signins.orgList')).toBeNull();
    expect(await ai.call('signins.orgLoginStart', {}, {}, { provider: 'claude' })).toBeNull();
  });

  it('plays the Claude sign-in console: link, no echo, code, signed in', async () => {
    const ai = createFakeAi();
    const c = body<{ consoleId: string; state: string }>(
      await ai.call(
        'signins.consoleStart',
        {},
        {},
        { provider: 'claude', authMode: 'subscription_cli', cols: 80, rows: 24 },
      ),
    );
    const first = body<{ data: string; next: number; more: boolean }>(
      await ai.call('signins.consoleRead', { consoleId: c.consoleId }, { cursor: 0, waitMs: 0 }),
    );
    // As Claude Code 2.1.283 prints it: the link as an OSC 8 hyperlink, then the prompt.
    expect(text(first.data)).toContain(
      "If the browser didn't open, visit: \u001b]8;;https://claude.com/cai/oauth/authorize",
    );
    expect(text(first.data)).toContain('Paste code here if prompted > ');

    // Like Claude Code, the code isn't echoed: a read at the end has nothing new after typing.
    await ai.call('signins.consoleWrite', { consoleId: c.consoleId }, {}, { seq: 1, data: 'abc' });
    const quiet = body<{ data: string }>(
      await ai.call('signins.consoleRead', { consoleId: c.consoleId }, { cursor: first.next, waitMs: 0 }),
    );
    expect(text(quiet.data)).toBe('');
    // The same seq again is not typed twice; a skipped one is refused with the last applied seq.
    await ai.call('signins.consoleWrite', { consoleId: c.consoleId }, {}, { seq: 1, data: 'abc' });
    const gap = await ai.call('signins.consoleWrite', { consoleId: c.consoleId }, {}, { seq: 3, data: 'x' });
    expect(gap?.error).toMatchObject({ code: 'provider.console_input_gap', details: { inputSeq: 1 } });
    expect(restAnswer(gap as FakeAiAnswer).body).toMatchObject({
      error: { code: 'conflict', details: { code: 'provider.console_input_gap', inputSeq: 1 } },
    });
    expect(sessionAnswer(gap as FakeAiAnswer).body).toMatchObject({
      error: { code: 'provider.console_input_gap' },
    });

    await ai.call('signins.consoleWrite', { consoleId: c.consoleId }, {}, { seq: 2, data: '123\r' });
    const end = body<{ console: { state: string }; data: string }>(
      await ai.call('signins.consoleRead', { consoleId: c.consoleId }, { cursor: first.next, waitMs: 0 }),
    );
    expect(end.console.state).toBe('completed');
    expect(text(end.data)).toContain('Login successful');
    api.signins.consoleRead.response.parse(end);
    expect(ai.signIns()).toMatchObject([
      { provider: 'claude', authMode: 'subscription_cli', state: 'ready' },
    ]);
    expect(
      (await ai.call('signins.consoleWrite', { consoleId: c.consoleId }, {}, { seq: 3, data: 'x' }))?.error,
    ).toMatchObject({
      code: 'provider.console_ended',
    });
  });

  it('fails the console on a wrong code, and a second console replaces the first', async () => {
    const ai = createFakeAi();
    const start = () =>
      ai.call(
        'signins.consoleStart',
        {},
        {},
        { provider: 'claude', authMode: 'subscription_cli', cols: 80, rows: 24 },
      );
    const one = body<{ consoleId: string }>(await start());
    const two = body<{ consoleId: string }>(await start());
    const list = body<{ consoles: { consoleId: string; state: string }[] }>(await ai.call('signins.list'));
    expect(list.consoles.find((c) => c.consoleId === one.consoleId)?.state).toBe('cancelled');
    await ai.call('signins.consoleWrite', { consoleId: two.consoleId }, {}, { seq: 1, data: 'wrong\r' });
    const read = body<{ console: { state: string; error: { code: string } }; data: string }>(
      await ai.call('signins.consoleRead', { consoleId: two.consoleId }, { cursor: 0, waitMs: 0 }),
    );
    expect(read.console).toMatchObject({
      state: 'failed',
      exitCode: 1,
      error: { code: 'provider.login_failed' },
    });
    expect(text(read.data)).toContain('Login failed: Request failed with status code 400');
  });

  it('keeps sign-ins and installs across a reload', async () => {
    const ai = createFakeAi({
      installed: { claude: '2.1.278' },
      signedIn: [{ provider: 'claude', authMode: 'api_key' }],
    });
    const again = createFakeAi({ restore: ai.snapshot() });
    expect(again.signIns()).toHaveLength(1);
    const clients = body<{ clients: { state: string }[] }>(await again.call('clients.list'));
    expect(clients.clients[0]?.state).toBe('installed');
  });
});
