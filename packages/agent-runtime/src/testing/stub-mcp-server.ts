/**
 * Minimal Whombat MCP server for tests and live smoke runs: streamable HTTP with plain JSON responses,
 * bearer-token auth, the real tool list from `@whombat/core/contracts`, and every call recorded.
 * Tool calls answer `{status: 'ok'}` with a fake id; nothing is committed anywhere.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inputJsonSchema, MCP_TOOL_NAMES, MCP_TOOLS } from '@whombat/core/contracts';

export interface RecordedCall {
  name: string;
  arguments: Record<string, unknown>;
  authorization: string | undefined;
}

export interface StubMcpServer {
  url: string;
  token: string;
  calls: RecordedCall[];
  /** Requests rejected for a missing / wrong bearer token. */
  unauthorized: number;
  /** Resolves when a `tools/call` arrives (optionally for a given tool). */
  waitForCall(name?: string): Promise<RecordedCall>;
  close(): Promise<void>;
}

type Rpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startStubMcpServer(options: { token?: string; port?: number } = {}) {
  const token = options.token ?? `stub-${randomUUID()}`;
  const calls: RecordedCall[] = [];
  const waiters: Array<{ name?: string; resolve: (c: RecordedCall) => void }> = [];
  const state = { unauthorized: 0 };

  const tools = MCP_TOOL_NAMES.map((name) => ({
    name,
    title: MCP_TOOLS[name].title,
    description: MCP_TOOLS[name].description,
    inputSchema: inputJsonSchema(name),
    annotations: { readOnlyHint: MCP_TOOLS[name].readOnly },
  }));

  function handle(rpc: Rpc, authorization: string | undefined): unknown {
    switch (rpc.method) {
      case 'initialize':
        return {
          protocolVersion: (rpc.params?.protocolVersion as string | undefined) ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'whombat', version: '0.0.0-stub' },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools };
      case 'tools/call': {
        const call: RecordedCall = {
          name: String(rpc.params?.name ?? ''),
          arguments: (rpc.params?.arguments as Record<string, unknown> | undefined) ?? {},
          authorization,
        };
        calls.push(call);
        for (const waiter of [...waiters]) {
          if (!waiter.name || waiter.name === call.name) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(call);
          }
        }
        const result = { status: 'ok', messageId: `msg_stub${calls.length}` };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        };
      }
      case 'resources/list':
        return { resources: [] };
      case 'prompts/list':
        return { prompts: [] };
      default:
        throw Object.assign(new Error(`Method not found: ${rpc.method}`), { code: -32601 });
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const authorization = req.headers.authorization;
      if (authorization !== `Bearer ${token}`) {
        state.unauthorized += 1;
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(405).end();
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200).end();
        return;
      }
      let body: Rpc | Rpc[];
      try {
        body = JSON.parse(await readBody(req)) as Rpc | Rpc[];
      } catch {
        res.writeHead(400).end();
        return;
      }
      const batch = Array.isArray(body) ? body : [body];
      const replies: unknown[] = [];
      for (const rpc of batch) {
        if (rpc.id === undefined || rpc.id === null) continue; // notification
        try {
          replies.push({ jsonrpc: '2.0', id: rpc.id, result: handle(rpc, authorization) });
        } catch (error) {
          const e = error as Error & { code?: number };
          replies.push({ jsonrpc: '2.0', id: rpc.id, error: { code: e.code ?? -32603, message: e.message } });
        }
      }
      if (!replies.length) {
        res.writeHead(202).end();
        return;
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (batch.some((r) => r.method === 'initialize')) headers['mcp-session-id'] = randomUUID();
      res.writeHead(200, headers).end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
    })();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const stub: StubMcpServer = {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    calls,
    get unauthorized() {
      return state.unauthorized;
    },
    waitForCall(name?: string) {
      const existing = calls.find((c) => !name || c.name === name);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ name, resolve }));
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return stub;
}
