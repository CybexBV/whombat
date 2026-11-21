/**
 * In-process fakes the Vault's tests call through the real outbound path (docs/decisions/vault.md VT-80…VT-82).
 *
 * - `fakeHomeAssistant`: an MCP server over streamable HTTP (the SDK's own server, stateless, JSON answers) that looks
 *   like Home Assistant's `/api/mcp` — HassTurnOn, HassTurnOff, GetLiveContext, EchoRequest, Broken, Edge — where
 *   EchoRequest **echoes the headers it received** (text and structured content), Edge puts the token across the
 *   64 KB cut, and a failure can echo them in its HTTP error body (`failEcho`).
 * - `fakeApi`: a plain HTTP API under `/v1`: `/echo` echoes method, path, query, body and headers without the
 *   credential; `/echo-all` with it; `/reflect` puts it in a kept response header; `/edge` around the cut; redirects;
 *   binary, big and never-ending answers.
 *
 * Both listen on 127.0.0.1; tests reach them only through `useVaultNetForTests` (virtual home-network addresses dialled
 * at 127.0.0.1), never by relaxing a destination rule.
 */
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Fake {
  port: number;
  /** Every request, in order. */
  requests: SeenRequest[];
  close(): Promise<void>;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function closer(server: http.Server) {
  return () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
}

export interface FakeTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export const HOME_ASSISTANT_TOOLS: FakeTool[] = [
  {
    name: 'HassTurnOn',
    description: 'Turns on a device or entity.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'HassTurnOff',
    description: 'Turns off a device or entity.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  { name: 'GetLiveContext', description: 'The live state of every exposed entity.' },
  { name: 'EchoRequest', description: 'Answers with the request it got.' },
  { name: 'Broken', description: 'Always fails.' },
];

export interface FakeHome extends Fake {
  /** The tools `tools/list` answers with (change them to test “New”). */
  tools: FakeTool[];
  /** The token it accepts as `Authorization: Bearer <token>`. */
  token: string;
  /** Answer every request with this HTTP status, until cleared. */
  failWith: number | null;
  /** A failure's body echoes the request headers. */
  failEcho: boolean;
  /** Hold every tools/call answer this long (ms). */
  delayMs: number;
}

/** A Home Assistant–like MCP server at `/api/mcp`. */
export async function fakeHomeAssistant(token: string): Promise<FakeHome> {
  const fake = {
    tools: [...HOME_ASSISTANT_TOOLS],
    token,
    failWith: null,
    failEcho: false,
    delayMs: 0,
  } as FakeHome;
  const requests: SeenRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    const echo = JSON.stringify(req.headers);
    if (fake.failWith !== null || req.headers.authorization !== `Bearer ${fake.token}`) {
      res.writeHead(fake.failWith ?? 401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ message: 'Unauthorized', ...(fake.failEcho ? { youSent: req.headers } : {}) }),
      );
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/mcp') {
      res.writeHead(405, { allow: 'POST' });
      res.end(`not here: ${echo}`);
      return;
    }
    const mcp = new Server({ name: 'home-assistant', version: '2026.9.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: fake.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (call) => {
      if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
      const args = (call.params.arguments ?? {}) as Record<string, unknown>;
      switch (call.params.name) {
        case 'HassTurnOn':
        case 'HassTurnOff':
          return {
            content: [
              {
                type: 'text',
                text: `${call.params.name === 'HassTurnOn' ? 'Turned on' : 'Turned off'} ${String(args.name)}.`,
              },
            ],
          };
        case 'Edge':
          // The token, JSON-escaped as a server writing `\/` would, starting `at` characters in.
          return {
            content: [
              {
                type: 'text',
                text: `${'e'.repeat(Number(args.at ?? 0))}${fake.token.replace(/\//g, '\\/')}${'e'.repeat(100)}`,
              },
            ],
          };
        case 'GetLiveContext':
          return { content: [{ type: 'text', text: `Living room lamp: off. ${'x'.repeat(70 * 1024)}` }] };
        case 'EchoRequest':
          return {
            content: [{ type: 'text', text: echo }],
            structuredContent: { headers: req.headers, args },
          };
        case 'Broken':
          return { content: [{ type: 'text', text: 'The lamp didn’t answer.' }], isError: true };
        default:
          throw new Error(`Unknown tool; you sent ${echo}`);
      }
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
  });
  fake.port = await listen(server);
  fake.requests = requests;
  fake.close = closer(server);
  return fake;
}

export interface FakeApi extends Fake {
  /** How it checks the credential: a bearer token, a header, basic auth or a query parameter. */
  accepts: (req: http.IncomingMessage, url: URL) => boolean;
}

/** A plain HTTP API under `/v1`. */
export async function fakeApi(accepts: FakeApi['accepts']): Promise<FakeApi> {
  const requests: SeenRequest[] = [];
  const fake = { accepts } as FakeApi;
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    const url = new URL(req.url ?? '/', 'http://fake');
    const echo = { method: req.method, path: url.pathname, query: url.search, headers: req.headers, body };
    // What it echoes without the credential (it knows where the credential travels).
    const plain = new URLSearchParams(url.search);
    plain.delete('key');
    const { authorization: _a, 'x-api-key': _k, ...headers } = req.headers;
    const clean = { ...echo, query: plain.toString() ? `?${plain}` : '', headers };
    const token = String(
      req.headers.authorization ?? req.headers['x-api-key'] ?? url.searchParams.get('key') ?? '',
    ).replace(/^Bearer /, '');
    if (!fake.accepts(req, url)) {
      res.writeHead(401, { 'content-type': 'application/json', 'x-debug': JSON.stringify(req.headers) });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    switch (url.pathname) {
      case '/v1':
      case '/v1/':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      case '/v1/echo':
        res.writeHead(200, {
          'content-type': 'application/json',
          etag: '"v1"',
          'x-ratelimit-remaining': '41',
          'set-cookie': 'session=abc',
          // Dropped by the header filter: never returned, so it doesn't count.
          'x-echo-auth': String(req.headers.authorization ?? ''),
        });
        res.end(JSON.stringify(clean));
        return;
      case '/v1/echo-all':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(echo));
        return;
      case '/v1/reflect':
        res.writeHead(200, { 'content-type': 'text/plain', etag: `"${token}"` });
        res.end('ok');
        return;
      case '/v1/edge': {
        // The token (or only its first 3 characters) `at` bytes into the answer, then more.
        const at = Number(url.searchParams.get('at') ?? 0);
        const piece = url.searchParams.get('partial') ? token.slice(0, 3) : token;
        const binary = url.searchParams.get('type') === 'binary';
        res.writeHead(200, { 'content-type': binary ? 'application/octet-stream' : 'text/plain' });
        res.end(
          Buffer.concat([Buffer.alloc(at, binary ? 7 : 'q'), Buffer.from(piece), Buffer.alloc(4096, 'q')]),
        );
        return;
      }
      case '/v1/redirect-out':
        res.writeHead(302, { location: 'https://evil.example/steal' });
        res.end();
        return;
      case '/v1/redirect-in':
        res.writeHead(303, { location: '/v1/echo?next=1' });
        res.end();
        return;
      case '/v1/binary': {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(token), Buffer.from([0])]));
        return;
      }
      case '/v1/big':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('y'.repeat(300 * 1024));
        return;
      case '/v1/forbidden':
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('no');
        return;
      case '/v1/slow':
        // Never answers; the call's deadline ends it.
        return;
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end(`not found: ${JSON.stringify(clean)}`);
    }
  });
  fake.port = await listen(server);
  fake.requests = requests;
  fake.close = closer(server);
  return fake;
}
