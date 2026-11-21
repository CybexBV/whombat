/**
 * Setting up connections against a real Postgres (docs/decisions/connections-setup.md): sign in once with stand-in
 * provisioners (CS-01…CS-09) — the key stored as the entry's token with the fields it fills, the note as a warning
 * line, a second factor as a second request, refusals in the contract's words, the certificate before the password
 * (CS-05), requests and a WebSocket under the destination rule, the password nowhere afterwards — Look only on the tools
 * side and its change as a signed event (CS-10, CS-11), and Tailscale's OAuth client (CS-12): exchanged, cached,
 * exchanged again when due, a refused secret marking it `needs_reauth`, Replace token, a new level.
 *
 * Stubs listen on 127.0.0.1 behind home-network addresses (the Vault's network seam). Tailscale's fixed addresses are
 * pointed at a stub over http by patching its catalog entry for this file only.
 */
import { X509Certificate } from 'node:crypto';
import http from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  type AnyEndpoint,
  api,
  buildPath,
  catalogEntry,
  type DispatchContext,
  lookOnlyText,
} from '@whombat/core';
import { turnPrompt } from '@whombat/runner';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { catalogConnections, dispatches, events, vaultNetworks } from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { SELF_SIGNED_CERT_A, SELF_SIGNED_KEY_A } from '../test/self-signed';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { credentialFor } from './credentials';
import { openConnectionSecret } from './crypto';
import { useProvisionerForTests } from './provision/index';
import { type ProvisionRunInput, runProvisioner } from './provision/run';
import { needSecondFactor, type Provisioner, refuseSignIn } from './provision/types';
import { haClientId } from './redirect';
import { answerMcp, HOME_TOOLS } from './testing/tool-stubs';
import { ConnectionAuthError } from './types';

/** Tailscale's API and token endpoint, pointed at the stub once it listens. */
const ts = vi.hoisted(() => ({ base: '' }));

vi.mock('@whombat/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whombat/core')>();
  const patched = () => {
    const entry = actual.catalogEntry('tailscale');
    if (!entry) throw new Error('no tailscale entry');
    return {
      ...entry,
      baseUrl: ts.base,
      signIn: entry.signIn.map((m) =>
        m.kind === 'client_credentials' ? { ...m, tokenUrl: `${ts.base}/api/v2/oauth/token` } : m,
      ),
    };
  };
  return {
    ...actual,
    catalogEntry: (id: string) => (id === 'tailscale' && ts.base ? patched() : actual.catalogEntry(id)),
  };
});

const logs: string[] = [];
const t = useTestServer({
  seed: true,
  listen: true,
  logger: { level: 'trace', stream: { write: (line: string) => void logs.push(line) } },
});

/** Every password of this file: none may be found anywhere afterwards. */
const HA_PASSWORD = 'ha-Pw-9vQ2-canary';
const PAPER_PASSWORD = 'paper-Pw-3kT8-canary';
const PVE_PASSWORD = 'pve-Pw-5mZ1-canary';

const HOSTS: Record<string, string> = {
  'ha.setup.test': '192.168.77.10',
  'paper.setup.test': '192.168.77.20',
  'cloud.setup.test': '192.168.77.21',
  'pve.setup.test': '192.168.77.30',
  'ts.setup.test': '192.168.77.40',
  'portainer.setup.test': '192.168.77.50',
};

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON answers in a test
type Json = Record<string, any>;

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Served {
  port: number;
  seen: Seen[];
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => Promise<void> | void;

async function listen(server: http.Server, seen: Seen[]): Promise<Served> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function handle(handler: Handler, seen: Seen[]) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const body = await readBody(req);
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    seen.push({ method: req.method ?? '', path, headers: req.headers, body });
    await handler(req, res, body);
  };
}

function json(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

/** Home Assistant: its login flow and token endpoint, REST, its MCP server and the WebSocket API. */
async function stubHomeAssistant() {
  const seen: Seen[] = [];
  const names: string[] = [];
  const server = http.createServer(
    handle(async (req, res, body) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const auth = req.headers.authorization ?? '';
      if (req.method === 'POST' && url.pathname === '/auth/login_flow/flow-1') {
        const sent = JSON.parse(body) as { username?: string; password?: string };
        return sent.username === 'mara' && sent.password === HA_PASSWORD
          ? json(res, 200, { type: 'create_entry', result: 'code-1' })
          : json(res, 200, { type: 'form', errors: { base: 'invalid_auth' } });
      }
      if (req.method === 'POST' && url.pathname === '/auth/token') {
        const form = new URLSearchParams(body);
        return form.get('code') === 'code-1'
          ? json(res, 200, { access_token: 'short-1', refresh_token: 'refresh-1', expires_in: 1800 })
          : json(res, 400, { error: 'invalid_request' });
      }
      if (req.method === 'POST' && url.pathname === '/auth/revoke') return json(res, 200, {});
      if (auth !== 'Bearer ha-long-lived') return json(res, 401, { message: '401: Unauthorized' });
      if (url.pathname === '/api/mcp' && req.method === 'POST') return answerMcp(req, res, body, HOME_TOOLS);
      if (req.method === 'GET' && url.pathname === '/api/')
        return json(res, 200, { message: 'API running.' });
      if (req.method === 'GET' && url.pathname === '/api/states')
        return json(res, 200, [{ entity_id: 'light.kitchen', state: 'on' }]);
      if (req.method === 'POST' && url.pathname.startsWith('/api/services/'))
        return json(res, 200, { called: url.pathname });
      res.writeHead(404);
      res.end('404: Not Found');
    }, seen),
  );
  const wss = new WebSocketServer({ server, path: '/api/websocket' });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'auth_required' }));
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as {
        id?: number;
        type?: string;
        access_token?: string;
        client_name?: string;
      };
      if (msg.type === 'auth')
        socket.send(JSON.stringify({ type: msg.access_token === 'short-1' ? 'auth_ok' : 'auth_invalid' }));
      if (msg.type === 'auth/long_lived_access_token') {
        names.push(String(msg.client_name));
        socket.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result: 'ha-long-lived' }));
      }
    });
  });
  const served = await listen(server, seen);
  return {
    ...served,
    names,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await served.close();
    },
  };
}

/** Paperless-ngx: its token endpoint with a second factor, and documents. */
async function stubPaperless() {
  const seen: Seen[] = [];
  const server = http.createServer(
    handle((req, res, body) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/api/token/') {
        const sent = JSON.parse(body) as { username?: string; password?: string; code?: string };
        if (sent.username !== 'mara' || sent.password !== PAPER_PASSWORD)
          return json(res, 400, { non_field_errors: ['Unable to log in with provided credentials.'] });
        if (!sent.code) return json(res, 400, { non_field_errors: ['MFA code is required'] });
        if (sent.code !== '123456') return json(res, 400, { non_field_errors: ['Invalid MFA code'] });
        return json(res, 200, { token: 'paper-token-1' });
      }
      if (req.headers.authorization !== 'Token paper-token-1')
        return json(res, 401, { detail: 'Invalid token.' });
      if (req.method === 'GET' && url.pathname === '/api/documents/')
        return json(res, 200, { count: 0, results: [] });
      return json(res, 200, {});
    }, seen),
  );
  return listen(server, seen);
}

/** Tailscale: the OAuth token endpoint (client credentials) and the API, with knobs. */
async function stubTailscale() {
  const seen: Seen[] = [];
  const knobs = { secret: 'tskey-client-good', readOnlyClient: false, issued: 0, valid: new Set<string>() };
  const server = http.createServer(
    handle((req, res, body) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/api/v2/oauth/token') {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') !== 'client_credentials' || form.get('client_id') !== 'whombat')
          return json(res, 400, { error: 'invalid_request' });
        if (form.get('client_secret') !== knobs.secret) return json(res, 401, { error: 'invalid_client' });
        if (knobs.readOnlyClient && form.get('scope') !== 'all:read')
          return json(res, 400, { error: 'invalid_scope' });
        knobs.issued++;
        const token = `ts-access-${knobs.issued}`;
        knobs.valid.add(token);
        return json(res, 200, {
          access_token: token,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: form.get('scope'),
        });
      }
      const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!knobs.valid.has(auth)) return json(res, 401, { message: 'API token invalid' });
      if (url.pathname === '/api/v2/tailnet/-/settings') return json(res, 200, { devicesApprovalOn: false });
      if (url.pathname === '/api/v2/tailnet/-/devices') return json(res, 200, { devices: [] });
      return json(res, 404, { message: 'not found' });
    }, seen),
  );
  return { ...(await listen(server, seen)), knobs };
}

/** Proxmox VE over https with a self-signed certificate: the ticket endpoint and the token check. */
async function stubProxmox() {
  const seen: Seen[] = [];
  const server = createHttpsServer(
    { cert: SELF_SIGNED_CERT_A, key: SELF_SIGNED_KEY_A },
    handle((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/api2/json/access/ticket')
        return json(res, 200, {
          data: { ticket: 'PVE:root@pam:1', CSRFPreventionToken: 'x', username: 'root@pam' },
        });
      if (req.method === 'HEAD' && url.pathname === '/') {
        res.writeHead(200);
        res.end();
        return;
      }
      const ok = req.headers.authorization === 'PVEAPIToken=root@pam!whombat=pve-secret';
      return json(res, ok ? 200 : 401, ok ? { data: { version: '9.0' } } : { data: null });
    }, seen),
  );
  return listen(server, seen);
}

let ha: Awaited<ReturnType<typeof stubHomeAssistant>>;
let paper: Served;
let pve: Served;
let tailscale: Awaited<ReturnType<typeof stubTailscale>>;
const cookies: Record<'mara', string> = { mara: '' };
const provisioned: Record<string, number> = { homeassistant: 0, paperless: 0, proxmox: 0 };

async function call(
  ep: AnyEndpoint,
  params: Record<string, string>,
  body?: unknown,
  who: keyof typeof cookies = 'mara',
): Promise<{ status: number; body: Json }> {
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', ...params })}`,
    headers: { cookie: cookies[who] },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  let parsed: Json = {};
  try {
    parsed = res.json();
  } catch {
    parsed = {};
  }
  return { status: res.statusCode, body: parsed };
}

async function turn(agentId: string, conversationId: string) {
  const d = await agentTokenFor(t.services, t.burrowId, agentId, conversationId, {
    onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
  });
  return { ...d, mcp: await mcpClient(t.baseUrl, d.token) };
}

async function tool(mcp: TestMcp, name: string, args: Record<string, unknown>) {
  const res = await mcp.client.callTool({ name, arguments: args });
  return { isError: res.isError === true, body: (res.structuredContent ?? {}) as Json };
}

async function contextOf(dispatchId: string): Promise<DispatchContext> {
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!row) throw new Error('no dispatch');
  return buildDispatchContext(t.services, row);
}

async function rowOf(id: string) {
  const [row] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
  if (!row) throw new Error('no connection');
  return row;
}

/** Home Assistant's sign in once, as the real one goes: the login flow, the token, the WebSocket, the clean-up. */
const haProvisioner: Provisioner = async (input) => {
  provisioned.homeassistant = (provisioned.homeassistant ?? 0) + 1;
  const login = await input.fetch('/auth/login_flow/flow-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: `${input.publicUrl}/`,
      username: input.account,
      password: input.password,
    }),
  });
  const flow = login.json() as { type?: string; result?: string };
  if (flow.type !== 'create_entry') throw refuseSignIn('password', 'Wrong username or password.');
  const token = (
    await input.fetch('/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&code=${flow.result}&client_id=${encodeURIComponent(`${input.publicUrl}/`)}`,
    })
  ).json() as { access_token: string; refresh_token: string };
  const socket = await input.socket('/api/websocket');
  try {
    expect(await socket.next()).toEqual({ type: 'auth_required' });
    socket.send({ type: 'auth', access_token: token.access_token });
    expect(await socket.next()).toEqual({ type: 'auth_ok' });
    socket.send({ id: 1, type: 'auth/long_lived_access_token', client_name: input.name, lifespan: 3650 });
    const made = (await socket.next()) as { result: string };
    await input.fetch('/auth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${token.refresh_token}`,
    });
    return {
      fields: {},
      secret: made.result,
      limited: false,
      externalName: input.account,
      note: 'Home Assistant can’t limit a token, so Whombat keeps agents to the level you chose.',
    };
  } finally {
    socket.close();
  }
};

/** Paperless-ngx's: the token endpoint answers the second factor in words the provisioner turns into ours. */
const paperlessProvisioner: Provisioner = async (input) => {
  provisioned.paperless = (provisioned.paperless ?? 0) + 1;
  const res = await input.fetch('/api/token/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: input.account,
      password: input.password,
      ...(input.code ? { code: input.code } : {}),
    }),
  });
  const text = res.text();
  if (/MFA code is required/.test(text))
    throw needSecondFactor('Enter the code from your authenticator app.');
  if (/Invalid MFA code/.test(text)) throw refuseSignIn('code', 'That code didn’t work. Try the next one.');
  if (res.status !== 200) throw refuseSignIn('password', 'Wrong username or password.');
  return { fields: {}, secret: String((res.json() as { token: string }).token), limited: false };
};

/** Proxmox's: signs in (over the pinned certificate) and answers the token id it made. */
const proxmoxProvisioner: Provisioner = async (input) => {
  provisioned.proxmox = (provisioned.proxmox ?? 0) + 1;
  const res = await input.fetch('/api2/json/access/ticket', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(input.account)}&password=${encodeURIComponent(input.password)}`,
  });
  if (res.status !== 200) throw refuseSignIn('password', 'Wrong username, password or realm.');
  return {
    fields: { tokenId: 'root@pam!whombat' },
    secret: 'pve-secret',
    limited: false,
    externalName: 'root@pam',
    note: 'Proxmox didn’t let this account hand out permissions, so the token has the account’s own rights; Whombat keeps agents to the level you chose.',
  };
};

beforeAll(async () => {
  [ha, paper, pve, tailscale] = await Promise.all([
    stubHomeAssistant(),
    stubPaperless(),
    stubProxmox(),
    stubTailscale(),
  ]);
  ts.base = `http://ts.setup.test:${tailscale.port}`;
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      const address = HOSTS[host];
      if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address, family: 4 }];
    },
    dialAddress: (address) => (address.startsWith('192.168.77.') ? '127.0.0.1' : address),
    deadlineMs: 5000,
  });
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_setup_test',
    cidr: '192.168.77.0/24',
    ports: [ha.port, paper.port, pve.port, tailscale.port].sort((a, b) => a - b),
    note: 'Setup stubs',
    addedAt: t.services.clock(),
  });
  for (const who of ['mara'] as const) cookies[who] = (await sessionFor(t.services, IDS[who])).cookie;
  useProvisionerForTests('homeassistant', haProvisioner);
  useProvisionerForTests('paperless', paperlessProvisioner);
  useProvisionerForTests('proxmox', proxmoxProvisioner);
  useProvisionerForTests('nextcloud', async () => {
    throw refuseSignIn(
      'second_factor',
      'This account uses two-step sign-in. Sign in with Nextcloud instead.',
      'nextcloud_login',
    );
  });
  await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'can' });
});

afterAll(async () => {
  for (const id of ['homeassistant', 'paperless', 'proxmox', 'nextcloud']) useProvisionerForTests(id, null);
  await Promise.all([ha?.close(), paper?.close(), pve?.close(), tailscale?.close()]);
});

const haBody = (extra: Json = {}) => ({
  catalogId: 'homeassistant',
  signIn: 'password',
  fields: { url: `http://ha.setup.test:${ha.port}` },
  login: { account: 'mara', password: HA_PASSWORD },
  access: 'read',
  ...extra,
});

let haId = '';
let haLabel = '';

describe('sign in once (CS-01…CS-09)', () => {
  it('refuses a wrong password in our words, and an entry that can’t sign in once', async () => {
    const wrong = await call(
      api.connections.create,
      {},
      haBody({ login: { account: 'mara', password: 'nope' } }),
    );
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.details).toEqual({ code: 'sign_in_refused', reason: 'password' });
    expect(wrong.body.error.message).toBe('Wrong username or password.');
    const todoist = await call(
      api.connections.create,
      {},
      {
        catalogId: 'todoist',
        signIn: 'password',
        login: { account: 'mara', password: 'x' },
      },
    );
    expect(todoist.status).toBe(409);
    expect(todoist.body.error.details).toMatchObject({ code: 'not_supported' });
    const noLogin = await call(api.connections.create, {}, haBody({ login: undefined }));
    expect(noLogin.status).toBe(400);
    expect(Object.keys(noLogin.body.error.fields).sort()).toEqual(['login.account', 'login.password']);
  });

  it('makes Whombat’s key over the WebSocket and stores it as the entry’s token, with the note', async () => {
    const res = await call(api.connections.create, {}, haBody());
    expect(res.status).toBe(201);
    const c = res.body.connection;
    haId = c.id;
    haLabel = c.label;
    expect(c).toMatchObject({
      catalogId: 'homeassistant',
      signIn: 'token',
      access: 'read',
      status: 'active',
      fields: { url: `http://ha.setup.test:${ha.port}` },
    });
    expect(c.checks).toContainEqual({
      id: 'credential',
      state: 'warning',
      message: 'Home Assistant can’t limit a token, so Whombat keeps agents to the level you chose.',
    });
    expect(ha.names).toEqual(['Whombat']);
    // Whombat's own address as Home Assistant's client id; the revoke cleaned up the short session.
    const login = ha.seen.find((s) => s.path === '/auth/login_flow/flow-1');
    expect(JSON.parse(login?.body ?? '{}').client_id).toBe(haClientId(t.services.config));
    expect(ha.seen.some((s) => s.path === '/auth/revoke')).toBe(true);
    const row = await rowOf(haId);
    expect(row.auth).toEqual({ type: 'bearer' });
    expect(row.externalName).toBe('mara');
    expect(openConnectionSecret(t.services.custody, row.id, 'secret', row.secretEnc as string)).toBe(
      'ha-long-lived',
    );
    const [added] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'connection.added'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(added?.text).toBe(`Connected ${haLabel}`);
  });

  it('asks for the second factor, refuses a wrong code, and signs in from the start with a good one', async () => {
    const body = (code?: string) => ({
      catalogId: 'paperless',
      signIn: 'password',
      fields: { url: `http://paper.setup.test:${paper.port}` },
      login: { account: 'mara', password: PAPER_PASSWORD, ...(code ? { code } : {}) },
    });
    const first = await call(api.connections.create, {}, body());
    expect(first.status).toBe(409);
    expect(first.body.error.details).toEqual({ code: 'second_factor_needed' });
    expect(first.body.error.message).toBe('Enter the code from your authenticator app.');
    const wrong = await call(api.connections.create, {}, body('000000'));
    expect(wrong.body.error.details).toEqual({ code: 'sign_in_refused', reason: 'code' });
    const ok = await call(api.connections.create, {}, body('123456'));
    expect(ok.status).toBe(201);
    expect(ok.body.connection).toMatchObject({ catalogId: 'paperless', signIn: 'token', access: 'manage' });
    expect(provisioned.paperless).toBe(3);
    const row = await rowOf(ok.body.connection.id);
    expect(row.auth).toEqual({ type: 'header', name: 'Authorization', template: 'Token {secret}' });
    expect(ok.body.connection.checks[0]).toEqual({ id: 'credential', state: 'ok', message: null });
  });

  it('names the sign-in to use instead when the service can’t take a code this way', async () => {
    const res = await call(
      api.connections.create,
      {},
      {
        catalogId: 'nextcloud',
        signIn: 'password',
        fields: { url: `http://cloud.setup.test:${paper.port}` },
        login: { account: 'mara', password: 'whatever' },
      },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({
      code: 'sign_in_refused',
      reason: 'second_factor',
      method: 'nextcloud_login',
    });
    expect(res.body.error.message).toBe(
      'This account uses two-step sign-in. Sign in with Nextcloud instead.',
    );
  });

  describe('the certificate first (CS-05, CS-54)', () => {
    const pin = new X509Certificate(SELF_SIGNED_CERT_A).fingerprint256;
    const body = (fields: Record<string, string> = {}) => ({
      catalogId: 'proxmox',
      signIn: 'password',
      fields: { url: `https://pve.setup.test:${pve.port}`, ...fields },
      login: { account: 'root@pam', password: PVE_PASSWORD },
      access: 'read',
    });

    it('refuses before signing in when the certificate isn’t the pinned one, naming the one presented', async () => {
      const other = pin.replace(/^../, pin.startsWith('00') ? '11' : '00');
      const res = await call(api.connections.create, {}, body({ fingerprint: other }));
      expect(res.status).toBe(409);
      expect(res.body.error.details).toEqual({ code: 'check_failed', certificateSha256: pin });
      expect(provisioned.proxmox).toBe(0);
      expect(pve.seen.some((s) => s.path === '/api2/json/access/ticket')).toBe(false);
    });

    it('trusts the server’s own certificate, signs in over it and merges the fields the key fills', async () => {
      const res = await call(api.connections.create, {}, body());
      expect(res.status).toBe(201);
      expect(provisioned.proxmox).toBe(1);
      expect(res.body.connection).toMatchObject({
        catalogId: 'proxmox',
        signIn: 'token',
        access: 'read',
        fields: { url: `https://pve.setup.test:${pve.port}`, fingerprint: pin, tokenId: 'root@pam!whombat' },
      });
      expect(res.body.connection.checks[0]).toEqual({
        id: 'credential',
        state: 'warning',
        message: expect.stringMatching(/^Proxmox didn’t let this account hand out permissions/),
      });
      const ticket = pve.seen.find((s) => s.path === '/api2/json/access/ticket');
      expect(ticket?.headers['user-agent']).toBe('Whombat');
    });
  });

  it('keeps the password nowhere: not in a row, an event, an answer or a log line', async () => {
    const rows = await t.services.db.select().from(catalogConnections);
    const signed = await t.services.db.select().from(events);
    const haystack = [JSON.stringify(rows), JSON.stringify(signed), logs.join('\n')].join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const password of [HA_PASSWORD, PAPER_PASSWORD, PVE_PASSWORD])
      expect(haystack).not.toContain(password);
  });
});

describe('a provisioner’s run (CS-01, CS-04)', () => {
  const input = (): ProvisionRunInput => {
    const entry = catalogEntry('paperless');
    if (!entry) throw new Error('no paperless');
    const url = `http://paper.setup.test:${paper.port}`;
    return {
      entry,
      baseUrl: url,
      fields: { url },
      account: 'mara',
      password: 'x',
      code: null,
      challenge: null,
      access: 'read',
    };
  };

  it('stays on the service’s own address, under the home-network rule', async () => {
    await expect(
      runProvisioner(
        t.services,
        async (i) => {
          await i.fetch(`http://ha.setup.test:${ha.port}/api/`, { method: 'GET' });
          return { fields: {}, secret: 'x', limited: false };
        },
        input(),
      ),
    ).rejects.toMatchObject({ name: 'OutboundError', reason: 'destination' });
    await expect(
      runProvisioner(
        t.services,
        async (i) => {
          await i.socket('/api/websocket');
          return { fields: {}, secret: 'x', limited: false };
        },
        input(),
      ),
    ).rejects.toMatchObject({ name: 'OutboundError', reason: 'network' });
  });

  it('ends at its deadline, and nothing it asks for afterwards is sent', async () => {
    let late: ((path: string) => Promise<unknown>) | null = null;
    const before = paper.seen.length;
    await expect(
      runProvisioner(
        t.services,
        (i) => {
          late = (path) => i.fetch(path, { method: 'GET' });
          return new Promise(() => {});
        },
        input(),
        { deadlineMs: 150 },
      ),
    ).rejects.toMatchObject({ name: 'OutboundError', reason: 'timeout' });
    await expect(
      (late as unknown as (path: string) => Promise<unknown>)('/api/documents/'),
    ).rejects.toMatchObject({
      reason: 'timeout',
    });
    expect(paper.seen.length).toBe(before);
  });
});

describe('Look only (CS-10, CS-11)', () => {
  it('lists writes Off, says so in the guide and the instructions, and refuses a write before sending it', async () => {
    // The instructions (a turn of its own: building them issues the turn's token again).
    const look = await turn(IDS.dusty, IDS.billing);
    await look.mcp.close();
    const ctx = await contextOf(look.dispatchId);
    const line = ctx.connections?.find((c) => c.catalogId === 'homeassistant');
    expect(line).toMatchObject({ handle: 'homeassistant', access: 'read' });
    expect(turnPrompt(ctx)).toMatch(new RegExp(`- homeassistant — ${haLabel} \\([^)]*look only\\)`));

    const banjo = await turn(IDS.dusty, IDS.billing);
    const listed = await tool(banjo.mcp, 'connection_tools', { connection: 'homeassistant' });
    expect(listed.body.status).toBe('ok');
    expect(String(listed.body.guide).startsWith(lookOnlyText(haLabel))).toBe(true);
    const tiers = (listed.body.tools as { name: string; access: string; tier: string }[]).map((x) => [
      x.name,
      x.access,
      x.tier,
    ]);
    expect(tiers).toEqual([
      ['GetLiveContext', 'read', 'can'],
      ['HassTurnOn', 'write', 'off'],
      ['EraseEverything', 'write', 'off'],
      ['request', 'read', 'can'],
    ]);

    const before = ha.seen.length;
    const turnOn = await tool(banjo.mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'HassTurnOn',
      arguments: { name: 'kitchen' },
    });
    expect(turnOn.body).toEqual({ status: 'blocked', eventId: null, message: lookOnlyText(haLabel) });
    const post = await tool(banjo.mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'request',
      arguments: {
        method: 'POST',
        path: '/api/services/light/turn_on',
        body: { entity_id: 'light.kitchen' },
      },
    });
    expect(post.body).toMatchObject({ status: 'blocked', message: lookOnlyText(haLabel) });
    const sent = ha.seen
      .slice(before)
      .filter((s) => s.path.startsWith('/api/services/') || s.body.includes('tools/call'));
    expect(sent).toEqual([]);

    const states = await tool(banjo.mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'request',
      arguments: { method: 'GET', path: '/api/states' },
    });
    expect(states.body).toMatchObject({ status: 'ok', httpStatus: 200 });
    const live = await tool(banjo.mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'GetLiveContext',
      arguments: {},
    });
    expect(live.body).toMatchObject({ status: 'ok', content: 'Kitchen light: on.' });
    await banjo.mcp.close();
  });

  it('is changed by the person, signed, and then writes go through', async () => {
    const res = await call(api.connections.update, { connectionId: haId }, { access: 'manage' });
    expect(res.status).toBe(200);
    expect(res.body.connection.access).toBe('manage');
    const [changed] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'connection.changed'), eq(events.id, res.body.eventId)));
    expect(changed?.text).toBe(`Set ${haLabel} to Manage`);

    const banjo = await turn(IDS.dusty, IDS.billing);
    const turnOn = await tool(banjo.mcp, 'connection_call', {
      connection: 'homeassistant',
      tool: 'HassTurnOn',
      arguments: { name: 'kitchen' },
    });
    expect(turnOn.body).toMatchObject({ status: 'ok', content: 'Turned on kitchen.' });
    expect(turnPrompt(await contextOf(banjo.dispatchId))).not.toMatch(
      new RegExp(`- homeassistant — ${haLabel} \\([^)]*look only`),
    );
    await banjo.mcp.close();

    const back = await call(api.connections.update, { connectionId: haId }, { access: 'read' });
    const [again] = await t.services.db.select().from(events).where(eq(events.id, back.body.eventId));
    expect(again?.text).toBe(`Set ${haLabel} to Look only`);
  });
});

describe('an OAuth client’s secret (CS-12)', () => {
  let tsId = '';
  let tsLabel = '';
  const body = (secret: string, access: 'read' | 'manage' = 'read') => ({
    catalogId: 'tailscale',
    signIn: 'client_credentials',
    secret,
    access,
  });

  it('refuses a secret the token endpoint refuses', async () => {
    const res = await call(api.connections.create, {}, body('tskey-client-wrong'));
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ code: 'check_failed', status: 401 });
    expect(res.body.error.message).toBe('Tailscale refused the client secret. Check it and try again.');
  });

  it('exchanges the secret at the level’s scopes, checks with the token and keeps both sealed', async () => {
    const issued = tailscale.knobs.issued;
    const res = await call(api.connections.create, {}, body('tskey-client-good'));
    expect(res.status).toBe(201);
    tsId = res.body.connection.id;
    tsLabel = res.body.connection.label;
    expect(res.body.connection).toMatchObject({
      signIn: 'client_credentials',
      access: 'read',
      status: 'active',
    });
    expect(tailscale.knobs.issued).toBe(issued + 1);
    const exchange = tailscale.seen.filter((s) => s.path === '/api/v2/oauth/token').at(-1);
    expect(new URLSearchParams(exchange?.body).get('scope')).toBe('all:read');
    const row = await rowOf(tsId);
    expect(openConnectionSecret(t.services.custody, tsId, 'secret', row.secretEnc as string)).toBe(
      'tskey-client-good',
    );
    expect(openConnectionSecret(t.services.custody, tsId, 'access', row.accessTokenEnc as string)).toBe(
      `ts-access-${issued + 1}`,
    );
    expect(row.accessExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 3500_000);
  });

  it('uses the cached token, and exchanges again (once) when it is due', async () => {
    const issued = tailscale.knobs.issued;
    const cached = await credentialFor(t.services, await rowOf(tsId));
    expect(cached.headers.Authorization).toBe(`Bearer ts-access-${issued}`);
    expect(tailscale.knobs.issued).toBe(issued);
    await t.services.db
      .update(catalogConnections)
      .set({ accessExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(catalogConnections.id, tsId));
    const due = await rowOf(tsId);
    const [a, b] = await Promise.all([credentialFor(t.services, due), credentialFor(t.services, due)]);
    expect(tailscale.knobs.issued).toBe(issued + 1);
    expect(a.headers.Authorization).toBe(`Bearer ts-access-${issued + 1}`);
    expect(b.headers.Authorization).toBe(a.headers.Authorization);
    const stored = await rowOf(tsId);
    expect(openConnectionSecret(t.services.custody, tsId, 'access', stored.accessTokenEnc as string)).toBe(
      `ts-access-${issued + 1}`,
    );
  });

  it('an agent’s call reads through it with the token', async () => {
    const banjo = await turn(IDS.dusty, IDS.billing);
    const res = await tool(banjo.mcp, 'connection_call', {
      connection: 'tailscale',
      tool: 'request',
      arguments: { method: 'GET', path: '/api/v2/tailnet/-/devices' },
    });
    expect(res.body).toMatchObject({ status: 'ok', httpStatus: 200 });
    await banjo.mcp.close();
  });

  it('a level its client can’t have is refused before it changes, and a new level exchanges again', async () => {
    tailscale.knobs.readOnlyClient = true;
    const refused = await call(api.connections.update, { connectionId: tsId }, { access: 'manage' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/^Tailscale won’t give this client what Manage needs\./);
    expect((await rowOf(tsId)).access).toBe('read');
    tailscale.knobs.readOnlyClient = false;
    const res = await call(api.connections.update, { connectionId: tsId }, { access: 'manage' });
    expect(res.status).toBe(200);
    expect(res.body.connection.access).toBe('manage');
    const exchange = tailscale.seen.filter((s) => s.path === '/api/v2/oauth/token').at(-1);
    expect(new URLSearchParams(exchange?.body).get('scope')).toBe('all');
    const [changed] = await t.services.db.select().from(events).where(eq(events.id, res.body.eventId));
    expect(changed?.text).toBe(`Set ${tsLabel} to Manage`);
  });

  it('a refused secret marks it needs_reauth, and Replace token makes it work again', async () => {
    tailscale.knobs.secret = 'tskey-client-rotated';
    await t.services.db
      .update(catalogConnections)
      .set({ accessExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(catalogConnections.id, tsId));
    await expect(credentialFor(t.services, await rowOf(tsId))).rejects.toBeInstanceOf(ConnectionAuthError);
    const marked = await rowOf(tsId);
    expect(marked).toMatchObject({ status: 'needs_reauth', reauthReason: 'token_invalid' });
    const res = await call(
      api.connections.setSecret,
      { connectionId: tsId },
      { secret: 'tskey-client-rotated' },
    );
    expect(res.status).toBe(200);
    expect(res.body.connection).toMatchObject({ status: 'active', signIn: 'client_credentials' });
    const row = await rowOf(tsId);
    expect(openConnectionSecret(t.services.custody, tsId, 'secret', row.secretEnc as string)).toBe(
      'tskey-client-rotated',
    );
    expect(openConnectionSecret(t.services.custody, tsId, 'access', row.accessTokenEnc as string)).toBe(
      `ts-access-${tailscale.knobs.issued}`,
    );
  });
});

describe('a real provisioner, end to end (Portainer, CS-33)', () => {
  const PORTAINER_PASSWORD = 'portainer-Pw-7hX4-canary';
  let portainer: Served;

  beforeAll(async () => {
    const seen: Seen[] = [];
    const server = http.createServer(
      handle((req, res, body) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (req.method === 'POST' && url.pathname === '/api/auth') {
          const sent = JSON.parse(body) as { Username?: string; Password?: string };
          return sent.Username === 'admin' && sent.Password === PORTAINER_PASSWORD
            ? json(res, 200, { jwt: 'jwt-1' })
            : json(res, 422, { message: 'Invalid credentials', details: 'Unauthorized' });
        }
        if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
          res.writeHead(204);
          res.end();
          return;
        }
        const viaJwt = req.headers.authorization === 'Bearer jwt-1';
        const viaKey = req.headers['x-api-key'] === 'ptr_made-for-whombat';
        if (req.method === 'GET' && url.pathname === '/api/users/me' && (viaJwt || viaKey))
          return json(res, 200, { Id: 1, Username: 'admin', Role: 1 });
        if (req.method === 'POST' && url.pathname === '/api/users/1/tokens' && viaJwt)
          return json(res, 200, { rawAPIKey: 'ptr_made-for-whombat', apiKey: { id: 7 } });
        return json(res, 401, { message: 'Unauthorized' });
      }, seen),
    );
    portainer = await listen(server, seen);
    await t.services.db.insert(vaultNetworks).values({
      id: 'vnw_setup_portainer',
      cidr: '192.168.77.50/32',
      ports: [portainer.port],
      note: 'Portainer stub',
      addedAt: t.services.clock(),
    });
  });

  afterAll(async () => {
    await portainer?.close();
  });

  it('signs in, makes the key, logs out, stores only the key, and looks only', async () => {
    const res = await call(
      api.connections.create,
      {},
      {
        catalogId: 'portainer',
        signIn: 'password',
        fields: { url: `http://portainer.setup.test:${portainer.port}` },
        login: { account: 'admin', password: PORTAINER_PASSWORD },
        access: 'read',
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.connection).toMatchObject({
      catalogId: 'portainer',
      signIn: 'token',
      access: 'read',
      status: 'active',
    });
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, res.body.connection.id));
    if (!row) throw new Error('no row');
    expect(openConnectionSecret(t.services.custody, row.id, 'secret', row.secretEnc as string)).toBe(
      'ptr_made-for-whombat',
    );
    expect(portainer.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/auth',
      'GET /api/users/me',
      'POST /api/users/1/tokens',
      'POST /api/auth/logout',
      'GET /api/users/me',
    ]);
    const tokenCall = portainer.seen.find((r) => r.path === '/api/users/1/tokens');
    expect(JSON.parse(tokenCall?.body ?? '{}')).toMatchObject({ description: 'Whombat' });
    const haystack = [JSON.stringify(row), logs.join('\n')].join('\n');
    expect(haystack).not.toContain(PORTAINER_PASSWORD);
  });
});
