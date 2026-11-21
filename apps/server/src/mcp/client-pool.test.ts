/**
 * The pooled MCP client against a server that keeps sessions, as T3 Code's does (docs/decisions/t3code.md): one
 * session reused across calls, a server that restarted and forgot it answered with a new session and the same call once
 * more, a sign-in that ended as a 401, and a declared failure as `isError` with the server's own JSON.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionT3Code } from '../connections/provision/t3code';
import { networkInput } from '../connections/provision/testing-network';
import { startT3Code, type T3CodeStub } from '../connections/testing/t3code-stub';
import { VaultCallError } from '../vault/net';
import { McpClientPool, type McpPoolTarget } from './client-pool';

let t3: T3CodeStub;
let token = '';
const pool = new McpClientPool({
  clientName: 'test',
  deadlineMs: () => 5000,
  idleMs: 60_000,
  outputMax: 65_536,
});

/** The target's `post` as the connections side sends it: the SDK's headers and body, the bearer token last. */
function target(bearer: string, version = '1'): McpPoolTarget {
  return {
    key: `t3:${bearer}`,
    url: `${t3.url}/mcp`,
    version,
    forms: [{ secret: bearer }],
    post: async (headers, body) => {
      const res = await fetch(`${t3.url}/mcp`, {
        method: 'POST',
        headers: { ...headers, authorization: `Bearer ${bearer}` },
        body,
      });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        out[k] = v;
      });
      return { status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) };
    },
  };
}

/** Signs in as Whombat does, straight at the stand-in: the token for a full-access pairing code. */
async function signIn(): Promise<string> {
  const made = await provisionT3Code(
    networkInput('t3code', t3, { account: '', password: t3.pairingCode(), access: 'manage' }),
  );
  return made.secret;
}

beforeAll(async () => {
  t3 = await startT3Code();
  token = await signIn();
});

afterAll(async () => {
  await pool.close();
  await t3.close();
});

describe('an MCP server that keeps sessions (T3 Code)', () => {
  it('lists its tools and calls them on one session', async () => {
    const tools = await pool.listTools(target(token));
    expect(tools.map((t) => t.name)).toContain('t3_pending_request');
    const before = t3.sessionsOpened;
    const env = await pool.call(target(token), 't3_environment_read', {});
    const projects = await pool.call(target(token), 't3_project_list', {});
    expect(t3.sessionsOpened).toBe(before + 1);
    expect(env).toMatchObject({ isError: false, structured: { label: 'thetitan' } });
    expect(JSON.parse(projects.text)).toEqual(projects.structured);
    // The session goes with every call after `initialize`.
    const sent = t3.seen.filter((r) => r.path === '/mcp' && r.body.includes('tools/call'));
    expect(sent.at(-1)?.headers['mcp-session-id']).toMatch(/^session-/);
    expect(sent.at(-1)?.headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('opens a new session once when the server forgot it, and the call runs once', async () => {
    await pool.call(target(token), 't3_project_list', {});
    const opened = t3.sessionsOpened;
    const calls = t3.calls.length;
    t3.restart();
    const res = await pool.call(target(token), 't3_project_list', { limit: 5 });
    expect(res).toMatchObject({ isError: false, structured: { projects: [{ title: 'Demo site' }] } });
    expect(t3.sessionsOpened).toBe(opened + 1);
    expect(t3.calls.slice(calls)).toEqual([{ name: 't3_project_list', args: { limit: 5 }, token }]);
  });

  it('answers a declared failure as isError with the server’s JSON', async () => {
    const res = await pool.call(target(token), 't3_pending_request', { action: 'list' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.text)).toMatchObject({ _tag: 'OrchestratorMcpFailure', code: 'target_required' });
  });

  it('reads a sign-in that ended as a 401, for the connections side to mark', async () => {
    const ending = await signIn();
    await pool.call(target(ending), 't3_project_list', {});
    t3.end(ending);
    const err = await pool.call(target(ending), 't3_project_list', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultCallError);
    expect((err as VaultCallError).status).toBe(401);
    // A new sign-in (a new credential version) is a new session with the new token.
    const renewed = await signIn();
    await expect(pool.call(target(renewed, '2'), 't3_project_list', {})).resolves.toMatchObject({
      isError: false,
    });
  });
});
