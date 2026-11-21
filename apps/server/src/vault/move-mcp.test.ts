/** How a Vault MCP entry signs in as a Custom MCP server, or why it stays (docs/decisions/vault-simplify.md VLT-30). */
import { describe, expect, it } from 'vitest';
import { mcpMovePlan } from './move-mcp';

const entry = (auth: unknown, sealed: string | null = 'sealed') =>
  ({ url: 'https://mcp.example.com/mcp', auth, sealed }) as Parameters<typeof mcpMovePlan>[0];

describe('mcpMovePlan', () => {
  it('moves no sign-in, a bearer token and a header of its own', () => {
    expect(mcpMovePlan(entry({ type: 'none' }, null))).toEqual({ ok: true, signIn: 'none', auth: null });
    expect(mcpMovePlan(entry({ type: 'bearer' }))).toEqual({
      ok: true,
      signIn: 'token',
      auth: { type: 'bearer' },
    });
    expect(mcpMovePlan(entry({ type: 'header', name: 'X-Api-Key' }))).toEqual({
      ok: true,
      signIn: 'token',
      auth: { type: 'header', name: 'X-Api-Key', template: '{secret}' },
    });
  });

  it('keeps what a Custom MCP server can’t sign in with, and what has no secret or address', () => {
    expect(mcpMovePlan(entry({ type: 'basic', username: 'mara' }))).toEqual({ ok: false, block: 'sign_in' });
    expect(mcpMovePlan(entry({ type: 'query', name: 'token' }))).toEqual({ ok: false, block: 'sign_in' });
    expect(mcpMovePlan(entry({ type: 'header', name: 'Cookie' }))).toEqual({ ok: false, block: 'sign_in' });
    expect(mcpMovePlan(entry({ type: 'bearer' }, null))).toEqual({ ok: false, block: 'no_secret' });
    expect(mcpMovePlan({ ...entry({ type: 'none' }), url: null })).toEqual({
      ok: false,
      block: 'no_address',
    });
  });
});
