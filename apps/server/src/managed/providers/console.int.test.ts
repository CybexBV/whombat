/**
 * The Claude sign-in console (contracts 0.9.0 CT-70, CT-71; SUB-22) with the server's own executor (`local`): it runs a fake Claude Code in a PTY under `WHOMBAT_CREDENTIALS_ROOT`, the long-poll read returns its output,
 * resize and cancel reach it.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AnyEndpoint, api, buildPath, toQueryString } from '@whombat/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { IDS } from '../../seed/test-world';
import { useTestServer } from '../../test/harness';
import { sessionFor } from '../../test/tokens';
import { providerLogins } from './service';

const root = mkdtempSync(join(tmpdir(), 'wb-console-rest-'));
const FAKES = fileURLToPath(
  new URL('../../../../../packages/agent-runtime/src/providers/testing/', import.meta.url),
);
const t = useTestServer({
  seed: true,
  env: { WHOMBAT_CREDENTIALS_ROOT: root, WHOMBAT_SIGNIN_EXECUTOR: 'local' },
});
const cookies: Record<string, string> = {};

beforeAll(async () => {
  providerLogins(t.services, { claude: join(FAKES, 'fake-claude.mjs') });
  cookies.mara = (await sessionFor(t.services, IDS.mara)).cookie;
});

async function call(
  who: 'mara',
  ep: AnyEndpoint,
  params: Record<string, string> = {},
  body?: unknown,
  query?: Record<string, unknown>,
) {
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, params)}${toQueryString(query)}`,
    headers: { cookie: cookies[who] as string },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, body: res.json() };
}

async function readUntil(consoleId: string, pred: (text: string, state: string) => boolean) {
  let cursor = 0;
  let text = '';
  for (let n = 0; n < 40; n++) {
    const r = await call('mara', api.signins.consoleRead, { consoleId }, undefined, { cursor, waitMs: 5000 });
    expect(r.status).toBe(200);
    text += Buffer.from(r.body.data, 'base64').toString('utf8');
    cursor = r.body.next;
    if (pred(text, r.body.console.state)) return { text, state: r.body.console.state as string };
  }
  throw new Error(`never: ${JSON.stringify(text)}`);
}

describe('the sign-in console (the server’s own executor)', () => {
  it('runs, resizes and cancels', async () => {
    const started = await call(
      'mara',
      api.signins.consoleStart,
      {},
      {
        provider: 'claude',
        authMode: 'subscription_cli',
        cols: 90,
        rows: 20,
      },
    );
    expect(started).toMatchObject({ status: 201, body: { state: 'running', cols: 90, rows: 20 } });
    const id = started.body.consoleId as string;
    await readUntil(id, (text) => text.includes('Paste code here'));
    expect(
      (await call('mara', api.signins.consoleResize, { consoleId: id }, { cols: 120, rows: 40 })).body,
    ).toMatchObject({ cols: 120, rows: 40 });
    await call('mara', api.signins.consoleWrite, { consoleId: id }, { seq: 1, data: 'size\r' });
    await readUntil(id, (text) => text.includes('SIZE 120x40'));
    expect((await call('mara', api.signins.consoleCancel, { consoleId: id })).body).toMatchObject({
      state: 'cancelled',
    });
    // Typing into an ended console is refused; nothing was signed in.
    expect(
      (await call('mara', api.signins.consoleWrite, { consoleId: id }, { seq: 2, data: 'good\r' })).body,
    ).toMatchObject({ error: { details: { code: 'provider.console_ended' } } });
    const list = await call('mara', api.signins.list);
    expect(list.body.signIns.filter((s: { provider: string }) => s.provider === 'claude')).toEqual([]);
  });

  it('a completed sign-in lands in the person’s home under the credentials root', async () => {
    const started = await call(
      'mara',
      api.signins.consoleStart,
      {},
      {
        provider: 'claude',
        authMode: 'subscription_cli',
        cols: 80,
        rows: 24,
      },
    );
    const id = started.body.consoleId as string;
    await readUntil(id, (text) => text.includes('Paste code here'));
    await call('mara', api.signins.consoleWrite, { consoleId: id }, { seq: 1, data: 'good\r' });
    expect((await readUntil(id, (_t, state) => state !== 'running')).state).toBe('completed');
    const list = await call('mara', api.signins.list);
    expect(list.body.signIns.some((s: { provider: string }) => s.provider === 'claude')).toBe(true);
    expect(existsSync(join(root, 'claude', 'config', '.credentials.json'))).toBe(true);
    // Signing out asks the CLI to log out and removes the home.
    expect((await call('mara', api.signins.logout, { provider: 'claude' })).body).toEqual({ removed: true });
    expect(existsSync(join(root, 'claude'))).toBe(false);
  });
});
