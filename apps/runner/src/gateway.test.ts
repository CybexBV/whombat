/**
 * The runner's AI gateway forwarder (Whombat docs/decisions/ai-gateway.md AIG-08) against a fake server origin: it
 * streams a request body and an SSE response through its unix socket chunk by chunk, passes the CLI's key on unchanged,
 * drops hop-by-hop headers, refuses everything but `/ai-gateway/`, and goes away with the turn. And which dispatches go
 * through the gateway (`gatewayRouteOf`, AIG-07).
 */
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  endToEndHeaders,
  GatewayForwarder,
  gatewayBaseUrl,
  gatewayPath,
  gatewayRouteOf,
  gatewayUnusableText,
} from './gateway';
import { testContext } from './test-context';

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A gate the test opens once it saw what it waits for. */
function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { open, opened };
}

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

/** The server's relay standing in. */
async function origin(
  handler: (req: IncomingMessage, res: import('node:http').ServerResponse, seen: Seen) => void,
) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const entry: Seen = { method: req.method, url: req.url, headers: req.headers, body: '' };
    seen.push(entry);
    handler(req, res, entry);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, seen };
}

async function forwarder(serverUrl: string, idleMs?: number) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'wb-aig-'));
  const logs: string[] = [];
  const f = await GatewayForwarder.open(
    { serverUrl, tmpRoot, log: (_l, m) => logs.push(m), ...(idleMs ? { idleMs } : {}) },
    'dsp_test1',
  );
  closers.push(() => f.close());
  return { f, tmpRoot, logs };
}

/** One request through the socket: the status, headers and body chunks as they arrived. */
function call(
  socketPath: string,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, method: options.method ?? 'GET', path: options.path, headers: options.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('the AI gateway forwarder', () => {
  it('streams the request body and an SSE response chunk by chunk, with the CLI’s key unchanged', async () => {
    const firstChunkArrived = gate();
    const firstEventRead = gate();
    const o = await origin((req, res, seen) => {
      req.setEncoding('utf8');
      req.on('data', (c: string) => {
        seen.body += c;
        if (seen.body.includes('part-1')) firstChunkArrived.open();
      });
      req.on('end', async () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-fusebox-account': 'acct-1' });
        res.write('event: message_start\ndata: {"n":1}\n\n');
        // The next event only once the CLI has read the first: a forwarder that buffered would never get here.
        await firstEventRead.opened;
        res.end('event: message_stop\ndata: {"n":2}\n\n');
      });
    });
    const { f } = await forwarder(o.url);
    const events: string[] = [];
    const done = new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const req = request(
        {
          socketPath: f.socket,
          method: 'POST',
          path: '/ai-gateway/claude/v1/messages?beta=true',
          headers: {
            authorization: 'Bearer wat_agent',
            'x-api-key': 'wat_agent',
            'content-type': 'application/json',
            // Hop-by-hop: never passed on.
            connection: 'keep-alive, x-hop',
            'x-hop': 'secret-hop',
            'proxy-authorization': 'Basic runner',
            te: 'trailers',
          },
        },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            events.push(c);
            if (c.includes('message_start')) firstEventRead.open();
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        },
      );
      req.on('error', reject);
      // The body in two parts: the second only once the origin has the first (no buffering of the request either).
      req.write('{"part-1":');
      void firstChunkArrived.opened.then(() => req.end('"part-2"}'));
    });
    const res = await done;
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['x-fusebox-account']).toBe('acct-1');
    expect(events.join('')).toBe(
      'event: message_start\ndata: {"n":1}\n\nevent: message_stop\ndata: {"n":2}\n\n',
    );
    expect(events.length).toBeGreaterThan(1);
    const [seen] = o.seen;
    expect(seen).toMatchObject({
      method: 'POST',
      url: '/ai-gateway/claude/v1/messages?beta=true',
      body: '{"part-1":"part-2"}',
    });
    expect(seen?.headers.authorization).toBe('Bearer wat_agent');
    expect(seen?.headers['x-api-key']).toBe('wat_agent');
    expect(seen?.headers.host).toBe(new URL(o.url).host);
    for (const hop of ['x-hop', 'proxy-authorization', 'te']) expect(seen?.headers[hop], hop).toBeUndefined();
  });

  it('passes Codex’s Responses calls and the relay’s own answers (errors included) as they are', async () => {
    const o = await origin((req, res) => {
      req.resume();
      if (req.url?.endsWith('/responses'))
        res
          .writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' })
          .end('{"error":{"message":"used up"}}');
      else res.writeHead(200).end();
    });
    const { f } = await forwarder(o.url);
    const hello = await call(f.socket, { method: 'HEAD', path: '/ai-gateway/claude/api/hello' });
    expect(hello.status).toBe(200);
    const limited = await call(f.socket, {
      method: 'POST',
      path: '/ai-gateway/codex/v1/responses',
      headers: { authorization: 'Bearer wat_agent' },
      body: '{}',
    });
    expect(limited).toMatchObject({ status: 429, body: '{"error":{"message":"used up"}}' });
    expect(limited.headers['retry-after']).toBe('30');
    expect(o.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'HEAD /ai-gateway/claude/api/hello',
      'POST /ai-gateway/codex/v1/responses',
    ]);
  });

  it('refuses everything but /ai-gateway/, and the server never sees it', async () => {
    const o = await origin((req, res) => {
      req.resume();
      res.writeHead(200).end('reached');
    });
    const { f } = await forwarder(o.url);
    for (const path of [
      '/internal/runner/claim',
      '/mcp',
      '/api/v1/burrows',
      '/',
      '/ai-gateway',
      '/ai-gateway/../internal/runner/claim',
      '/ai-gateway/claude/../../internal/runner/claim',
      '/ai-gateway/%2e%2e/internal/runner/claim',
      '/ai-gateway/claude%2f..%2f..%2finternal',
      '/ai-gateway\\..\\internal',
      'http://127.0.0.1:1/ai-gateway/claude/v1/messages',
      '//evil.example/ai-gateway/claude/v1/messages',
    ]) {
      const res = await call(f.socket, { method: 'POST', path, body: '{}' });
      expect(res.status, path).toBe(404);
      expect(JSON.parse(res.body)).toEqual({
        type: 'error',
        error: { type: 'not_found_error', message: 'Only the AI gateway is reachable here.' },
      });
    }
    expect(o.seen).toEqual([]);
  });

  it('answers 502 in a shape the CLIs read when the server can’t be reached', async () => {
    const { f, logs } = await forwarder('http://127.0.0.1:1');
    const res = await call(f.socket, { method: 'POST', path: '/ai-gateway/claude/v1/messages', body: '{}' });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toMatchObject({ type: 'error', error: { type: 'api_error' } });
    expect(JSON.parse(res.body).error.message).toMatch(
      /^Whombat couldn’t reach the AI gateway \(.*ECONNREFUSED/,
    );
    expect(logs.join('\n')).toMatch(/didn’t answer/);
  });

  it('stops the model call when the CLI hangs up, and its socket and folder go with the turn', async () => {
    const upstreamClosed = gate();
    const o = await origin((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ping\ndata: {}\n\n');
      res.on('close', () => upstreamClosed.open());
    });
    const { f } = await forwarder(o.url);
    expect(statSync(f.socket).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.socket, '..')).mode & 0o777).toBe(0o700);
    await new Promise<void>((resolve, reject) => {
      const req = request(
        { socketPath: f.socket, method: 'POST', path: '/ai-gateway/claude/v1/messages' },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => {});
      req.end('{}');
      setTimeout(() => reject(new Error('no first event')), 5000).unref();
    });
    await upstreamClosed.opened;
    await f.close();
    expect(existsSync(f.socket)).toBe(false);
    expect(existsSync(join(f.socket, '..'))).toBe(false);
  });

  it('closes a connection that stays idle past its limit', async () => {
    const o = await origin(() => {
      // Never answers.
    });
    const { f } = await forwarder(o.url, 200);
    const res = await call(f.socket, {
      method: 'POST',
      path: '/ai-gateway/claude/v1/messages',
      body: '{}',
    }).catch((err: Error) => err);
    expect(res instanceof Error || (res as { status: number }).status === 502).toBe(true);
  });

  it('keeps a socket path a unix socket can take, even under a long temp root', async () => {
    const long = join(mkdtempSync(join(tmpdir(), 'wb-aig-long-')), 'x'.repeat(80));
    const f = await GatewayForwarder.open(
      { serverUrl: 'http://127.0.0.1:1', tmpRoot: long, log: () => {} },
      'dsp_1',
    );
    closers.push(() => f.close());
    expect(Buffer.byteLength(f.socket)).toBeLessThanOrEqual(100);
    expect(statSync(join(f.socket, '..')).mode & 0o777).toBe(0o700);
    await f.close();
    expect(existsSync(join(f.socket, '..'))).toBe(false);
  });
});

describe('a gateway turn’s route and base URL (AIG-07, AIG-08)', () => {
  const gw = {
    v: 1,
    provider: 'claude',
    connectionId: 'con_fusebox1',
    name: 'Fusebox',
    kind: 'fusebox',
  } as const;
  const ctx = (gateway: unknown, provider = 'claude') => {
    const c = testContext();
    return { ...c, agent: { ...c.agent, runtime: { ...c.agent.runtime, provider } }, gateway } as never;
  };

  it('goes through the gateway the server named, for the agent’s own provider', () => {
    expect(gatewayRouteOf(ctx(gw))).toEqual({ ok: true, gateway: gw });
    expect(gatewayRouteOf(ctx({ ...gw, provider: 'codex' }, 'codex'))).toMatchObject({ ok: true });
  });

  it('runs on the agent’s sign-in as before without one, and on a scripted runner', () => {
    expect(gatewayRouteOf(ctx(undefined))).toBeNull();
    expect(gatewayRouteOf(ctx(null))).toBeNull();
  });

  it('refuses what it can’t send there, never falling back to a sign-in', () => {
    for (const bad of [
      { ...gw, v: 2 },
      { ...gw, provider: 'codex' },
      { ...gw, connectionId: '../acc_1' },
      { ...gw, name: ' ' },
      { ...gw, kind: 'other' },
      'fusebox',
    ])
      expect(gatewayRouteOf(ctx(bad)), JSON.stringify(bad)).toEqual({
        ok: false,
        refusal: gatewayUnusableText(typeof bad === 'object' && bad.name.trim() ? bad.name : null),
      });
    expect(gatewayUnusableText('Fusebox')).toBe(
      'My turns go through Fusebox, but this Whombat couldn’t send this one there, so I didn’t start. Ask me again in a moment.',
    );
    // An ACP agent with a gateway: not Claude Code or Codex, refused.
    expect(gatewayRouteOf(ctx(gw, 'acp'))).toMatchObject({ ok: false });
  });

  it('sends the CLI to the sandbox’s bridge', () => {
    expect(gatewayBaseUrl('claude')).toBe('http://127.0.0.1:47104/ai-gateway/claude');
    expect(gatewayBaseUrl('codex')).toBe('http://127.0.0.1:47104/ai-gateway/codex/v1');
  });

  it('passes only paths under /ai-gateway/, resolved', () => {
    expect(gatewayPath('/ai-gateway/claude/v1/messages?beta=true')).toBe(
      '/ai-gateway/claude/v1/messages?beta=true',
    );
    expect(gatewayPath('/ai-gateway/codex/./v1/responses')).toBe('/ai-gateway/codex/v1/responses');
    expect(gatewayPath('/ai-gateway/../mcp')).toBeNull();
  });

  it('drops hop-by-hop headers, those Connection names too', () => {
    expect(
      endToEndHeaders(
        {
          connection: 'close, x-a',
          'x-a': '1',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
          'x-b': '2',
        },
        'server:4400',
      ),
    ).toEqual({ 'x-b': '2', host: 'server:4400' });
  });
});
