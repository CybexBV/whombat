import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HERMES_MCP_BRIDGE } from './provider';

/** A streamable HTTP MCP endpoint: JSON for `initialize`, SSE for `tools/call`, 202 for notifications. */
const seen: { method: string; auth?: string; session?: string; version?: string }[] = [];
const server = createServer(async (req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (req.method === 'DELETE') {
    seen.push({
      method: 'DELETE',
      ...(req.headers['mcp-session-id'] ? { session: String(req.headers['mcp-session-id']) } : {}),
    });
    res.writeHead(200).end();
    return;
  }
  const m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  seen.push({
    method: m.method ?? 'response',
    ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
    ...(req.headers['mcp-session-id'] ? { session: String(req.headers['mcp-session-id']) } : {}),
    ...(req.headers['mcp-protocol-version'] ? { version: String(req.headers['mcp-protocol-version']) } : {}),
  });
  if (req.headers.authorization !== 'Bearer tok') {
    res.writeHead(401).end('no');
    return;
  }
  if (m.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  if (m.method === 'initialize') {
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: m.id,
        result: { protocolVersion: '2025-11-25', capabilities: {} },
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`,
  );
  res.end(
    `data: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } })}\n\n`,
  );
});
let url = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => server.close());

/** Runs the bridge, writes `messages`, and collects what it answered until `count` messages came back. */
async function bridge(token: string, messages: unknown[], count: number): Promise<Record<string, unknown>[]> {
  const child = spawn(process.execPath, [HERMES_MCP_BRIDGE, url], {
    env: { PATH: process.env.PATH, WHOMBAT_MCP_TOKEN: token },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const out: Record<string, unknown>[] = [];
  const lines = createInterface({ input: child.stdout });
  const done = new Promise<void>((resolve) => {
    lines.on('line', (l) => {
      out.push(JSON.parse(l));
      if (out.length >= count) resolve();
    });
  });
  for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  await done;
  child.stdin.end();
  await new Promise((r) => child.once('exit', r));
  return out;
}

describe('the MCP bridge (stdio ↔ streamable HTTP)', () => {
  it('relays JSON and SSE answers, with the token, the session and the protocol version after initialize', async () => {
    seen.length = 0;
    const out = await bridge(
      'tok',
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'set_status', arguments: {} } },
      ],
      3,
    );
    expect(out.map((m) => m.id ?? m.method)).toEqual([1, 'notifications/progress', 2]);
    expect(seen.find((s) => s.method === 'tools/call')).toMatchObject({
      auth: 'Bearer tok',
      session: 'sess-1',
      version: '2025-11-25',
    });
    expect(seen.some((s) => s.method === 'DELETE' && s.session === 'sess-1')).toBe(true);
  });

  it('a refused token is a JSON-RPC error for the request, never a hang', async () => {
    const out = await bridge('wrong', [{ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }], 1);
    expect(out[0]).toMatchObject({ id: 7, error: { code: -32603 } });
  });
});
