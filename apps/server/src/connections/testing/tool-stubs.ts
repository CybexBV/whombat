/**
 * In-process stand-ins the connection tests call through the real outbound path (destination rule, credential, pool):
 *
 * - `stubHome`: Home Assistant's REST API under `/api/` and, unless `mcpMissing`, its MCP server at `/api/mcp`
 *   (stateless streamable HTTP, JSON answers) with a read tool (`readOnlyHint`), a write tool and a destructive one.
 * - `stubOAuthMcp`: an MCP server at `/mcp` that accepts one bearer token only (a refreshed one: 401 until then), with
 *   its authorization server's metadata and token endpoint (the real refresh path).
 * - `stubDav`: a Nextcloud-like WebDAV server for one user (basic auth): PROPFIND, GET, PUT (If-None-Match), MKCOL,
 *   MOVE, DELETE over an in-memory tree.
 *
 * All listen on 127.0.0.1; tests reach them through `useVaultNetForTests` (home-network addresses dialled at
 * 127.0.0.1), never by relaxing a rule.
 */
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Stub {
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

async function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => Promise<void> | void,
) {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    await handler(req, res, body);
  });
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

export interface McpToolSpec {
  name: string;
  description: string;
  annotations?: Record<string, boolean>;
  answer: (args: Record<string, unknown>) => string;
}

/** Answers one stateless streamable-HTTP MCP request with these tools. */
export async function answerMcp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  tools: readonly McpToolSpec[],
  serverName = 'stub',
): Promise<void> {
  const mcp = new Server({ name: serverName, version: '1.0.0' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (call) => {
    const tool = tools.find((t) => t.name === call.params.name);
    if (!tool) return { content: [{ type: 'text', text: 'no such tool' }], isError: true };
    return {
      content: [
        { type: 'text', text: tool.answer((call.params.arguments ?? {}) as Record<string, unknown>) },
      ],
    };
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
}

export const HOME_TOOLS: McpToolSpec[] = [
  {
    name: 'GetLiveContext',
    description: 'The live state of every exposed entity.',
    annotations: { readOnlyHint: true },
    answer: () => 'Kitchen light: on.',
  },
  {
    name: 'HassTurnOn',
    description: 'Turns on a device or entity.',
    answer: (a) => `Turned on ${String(a.name)}.`,
  },
  {
    name: 'EraseEverything',
    description: 'Factory reset.',
    annotations: { destructiveHint: true },
    answer: () => 'Gone.',
  },
];

export interface HomeStub extends Stub {
  mcpMissing: boolean;
  /**
   * Home Assistant's config flow API (CX-54a): `admin` adds the MCP Server integration (a form, then the entry), `user`
   * refuses a token that isn't an administrator's (401), null answers 404 as an old version without the API would.
   */
  setup: 'admin' | 'user' | null;
}

export async function stubHome(
  token: string,
  options: { mcpMissing?: boolean; setup?: 'admin' | 'user' | null } = {},
): Promise<HomeStub> {
  const state = { mcpMissing: options.mcpMissing ?? false, setup: options.setup ?? null };
  const stub = await serve(async (req, res, body) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"message":"401: Unauthorized"}');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/mcp') {
      if (state.mcpMissing || req.method !== 'POST') {
        res.writeHead(404);
        res.end('404: Not Found');
        return;
      }
      await answerMcp(req, res, body, HOME_TOOLS);
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/config/config_entries/flow') && state.setup) {
      const answer = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (state.setup === 'user') return answer(401, { message: 'Unauthorized' });
      if (url.pathname === '/api/config/config_entries/flow') {
        const asked = body ? (JSON.parse(body) as { handler?: string }) : {};
        if (asked.handler !== 'mcp_server') return answer(400, { message: 'Invalid handler specified' });
        if (!state.mcpMissing) return answer(200, { type: 'abort', reason: 'single_instance_allowed' });
        return answer(200, { type: 'form', flow_id: 'flow-1', step_id: 'user', data_schema: [] });
      }
      if (url.pathname === '/api/config/config_entries/flow/flow-1') {
        state.mcpMissing = false;
        return answer(200, { type: 'create_entry', title: 'All LLM APIs' });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"message":"API running."}');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/states') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[{"entity_id":"light.kitchen","state":"on"}]');
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/services/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ called: url.pathname, with: body ? JSON.parse(body) : null }));
      return;
    }
    if (url.pathname === '/api/redirect') {
      res.writeHead(302, { location: 'https://elsewhere.example/steal' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('404: Not Found');
  });
  // A live property (Object.assign would copy the getter's value once).
  return Object.defineProperties(stub, {
    mcpMissing: {
      get: () => state.mcpMissing,
      set: (v: boolean) => {
        state.mcpMissing = v;
      },
    },
    setup: {
      get: () => state.setup,
      set: (v: 'admin' | 'user' | null) => {
        state.setup = v;
      },
    },
  }) as HomeStub;
}

export interface OAuthStub extends Stub {
  /** MCP requests refused for a token other than the accepted one. */
  refused: number;
  /** Refresh grants answered (with the accepted token). */
  refreshes: number;
}

/**
 * An MCP server at `/mcp` that accepts one bearer token only, and its authorization server (RFC 8414 metadata at
 * `/.well-known/oauth-authorization-server`, a token endpoint at `/token` that answers the refresh token `refresh` with
 * the accepted token).
 */
export async function stubOAuthMcp(accepted: string, refresh = 'refresh-1'): Promise<OAuthStub> {
  const counts = { refused: 0, refreshes: 0 };
  const stub = await serve(async (req, res, body) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const issuer = `http://${req.headers.host}`;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== refresh)
        return json(400, { error: 'invalid_grant' });
      counts.refreshes++;
      return json(200, { access_token: accepted, expires_in: 3600, token_type: 'Bearer' });
    }
    if (req.headers.authorization !== `Bearer ${accepted}`) {
      counts.refused++;
      res.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token"' });
      res.end();
      return;
    }
    await answerMcp(req, res, body, [
      {
        name: 'search',
        description: 'Search pages.',
        annotations: { readOnlyHint: true },
        answer: () => 'Found 2 pages.',
      },
    ]);
  });
  return Object.defineProperties(stub, {
    refused: { get: () => counts.refused },
    refreshes: { get: () => counts.refreshes },
  }) as OAuthStub;
}

export interface DavStub extends Stub {
  files: Map<string, string>;
}

/** A WebDAV server for `user` at `/remote.php/dav/files/<user>/`; folders are paths ending in `/`. */
export async function stubDav(user: string, password: string): Promise<DavStub> {
  const files = new Map<string, string>([['/', '']]);
  const root = `/remote.php/dav/files/${user}`;
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const pathOf = (href: string) =>
    decodeURIComponent(new URL(href, 'http://x').pathname.slice(root.length)) || '/';
  const isDir = (p: string) => files.has(p.endsWith('/') ? p : `${p}/`);
  const stub = await serve((req, res, body) => {
    if (req.headers.authorization !== auth) {
      res.writeHead(401);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith(root)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const p = pathOf(req.url ?? '/');
    const file = p.replace(/\/$/, '') || '/';
    switch (req.method) {
      case 'PROPFIND': {
        const dir = file === '/' ? '/' : `${file}/`;
        if (!files.has(dir) && !files.has(file)) {
          res.writeHead(404);
          res.end();
          return;
        }
        const rows = [
          dir,
          ...[...files.keys()].filter(
            (k) => k !== dir && k.startsWith(dir) && !k.slice(dir.length).replace(/\/$/, '').includes('/'),
          ),
        ];
        const xml = rows
          .map((k) => {
            const folder = k.endsWith('/');
            const href = `${root}${k.split('/').map(encodeURIComponent).join('/')}`;
            return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${
              folder
                ? '<d:resourcetype><d:collection/></d:resourcetype>'
                : `<d:resourcetype/><d:getcontentlength>${Buffer.byteLength(files.get(k) ?? '')}</d:getcontentlength>`
            }</d:prop></d:propstat></d:response>`;
          })
          .join('');
        res.writeHead(207, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${xml}</d:multistatus>`);
        return;
      }
      case 'GET':
        if (!files.has(file) || isDir(file)) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(files.get(file));
        return;
      case 'MKCOL':
        if (isDir(file)) {
          res.writeHead(405);
          res.end();
          return;
        }
        files.set(`${file}/`, '');
        res.writeHead(201);
        res.end();
        return;
      case 'PUT':
        if (req.headers['if-none-match'] === '*' && files.has(file)) {
          res.writeHead(412);
          res.end();
          return;
        }
        res.writeHead(files.has(file) ? 204 : 201);
        files.set(file, body);
        res.end();
        return;
      case 'DELETE':
        files.delete(file);
        res.writeHead(204);
        res.end();
        return;
      case 'MOVE': {
        const to = pathOf(String(req.headers.destination ?? ''));
        files.set(to, files.get(file) ?? '');
        files.delete(file);
        res.writeHead(201);
        res.end();
        return;
      }
      default:
        res.writeHead(405);
        res.end();
    }
  });
  return Object.assign(stub, { files });
}
