/**
 * `/mcp` reads a large body only for an authenticated agent (security review SEC-MCP-BODY): the body limit is
 * raised for `upload_file`, so the bearer token is checked in `onRequest`, before Fastify reads or parses the
 * body. An unauthenticated request is answered 401 whatever its body (oversized, malformed); an authenticated
 * one still gets the large limit.
 */
import { MCP_PATH } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { useTestServer } from '../test/harness';
import { MCP_BODY_LIMIT } from './server';

const t = useTestServer({ seed: true, app: true });

const padded = (bytes: number) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { _meta: { pad: 'x'.repeat(bytes) } },
  });

const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('SEC-MCP-BODY: /mcp authenticates before it reads the body', () => {
  it('answers an unauthenticated request 401 without parsing its body', async () => {
    expect(MCP_BODY_LIMIT).toBeGreaterThan(14 * 1024 * 1024);
    // Malformed JSON: had the body been parsed first, this would be a 400.
    const malformed = await t.api.inject({
      method: 'POST',
      url: MCP_PATH,
      headers,
      payload: `{"jsonrpc": "2.0", ${'x'.repeat(12 * 1024 * 1024)}`,
    });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.headers['www-authenticate']).toBe('Bearer realm="whombat-mcp"');
    // Over the (large) limit: had the body been read first, this would be a 413.
    const oversized = await t.api.inject({
      method: 'POST',
      url: MCP_PATH,
      headers: { ...headers, authorization: 'Bearer wat_nope' },
      payload: padded(MCP_BODY_LIMIT + 1024),
    });
    expect(oversized.statusCode).toBe(401);
  });

  it('refuses other methods before the body as well', async () => {
    const res = await t.api.inject({ method: 'DELETE', url: MCP_PATH, headers, payload: '{nope' });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });
});
