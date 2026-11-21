/**
 * Every catalog entry that signs in to a vendor's own MCP server (Notion's pattern; Todoist, Airtable, Mollie and
 * Cloudflare, connection-signin.md SG-20) works the same way on this server: the fixed MCP address without any field,
 * the `mcp` transport, the MCP check, the vendor's tools only (no typed or `request` tools for a token the MCP server
 * holds), and a callback among the redirect URIs every registration covers. A token made by hand keeps the REST API
 * and the entry's typed tools: the transport is the sign-in's.
 */
import {
  CATALOG,
  catalogEntry,
  catalogSignIn,
  connectionTransport,
  fieldsProblems,
  resolveMcpUrl,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { checkKindFor } from './checks';
import { appRedirectUri, mcpRedirectUris } from './redirect';
import { ownDefinitions } from './sync';

const config = { WHOMBAT_APP_URL: 'https://whombat.example.org' };

const vendorMcp = CATALOG.filter((entry) => {
  const method = catalogSignIn(entry, 'mcp_oauth');
  return method?.kind === 'mcp_oauth' && !!method.mcpUrl;
});

describe('connections without a sign-in', () => {
  it.each([
    ['ps5', 'request'],
    ['custom_mcp', 'mcp'],
    ['esphome', 'socket'],
  ])('%s checks its own service', (id, expected) => {
    const entry = catalogEntry(id as string);
    if (!entry) throw new Error(`No catalog entry: ${id}`);
    expect(checkKindFor(entry, 'none')).toBe(expected);
  });
});

describe('signing in to a vendor’s MCP server (SG-20)', () => {
  it('covers Notion at least', () => {
    expect(vendorMcp.map((e) => e.id)).toContain('notion');
  });

  for (const entry of vendorMcp) {
    it(`${entry.id}: the fixed address, the MCP transport and check, the vendor’s tools only`, () => {
      const method = catalogSignIn(entry, 'mcp_oauth');
      const mcpUrl = method?.kind === 'mcp_oauth' ? method.mcpUrl : null;
      expect(fieldsProblems(entry, 'mcp_oauth', {})).toEqual({});
      expect(connectionTransport(entry, 'mcp_oauth')).toBe('mcp');
      expect(resolveMcpUrl(entry, {}, 'mcp_oauth')).toBe(mcpUrl);
      expect(checkKindFor(entry, 'mcp_oauth')).toBe('mcp');
      expect(
        ownDefinitions(entry, { baseUrl: entry.baseUrl ?? '', fields: {}, signIn: 'mcp_oauth' }),
      ).toEqual([]);
      expect(mcpRedirectUris(config)).toContain(appRedirectUri(config, entry.id));
    });

    if (catalogSignIn(entry, 'token'))
      it(`${entry.id}: a token keeps the REST API, its check and its typed tools`, () => {
        expect(connectionTransport(entry, 'token')).toBe('rest');
        expect(resolveMcpUrl(entry, {}, 'token')).toBeNull();
        expect(checkKindFor(entry, 'token')).toBe(entry.check?.kind ?? null);
        const own = ownDefinitions(entry, { baseUrl: entry.baseUrl ?? '', fields: {}, signIn: 'token' });
        expect(own.filter((d) => d.origin === 'adapter').map((d) => d.name)).toEqual(
          entry.tools.map((t) => t.name),
        );
        expect(own.some((d) => d.origin === 'request')).toBe(!!entry.request);
      });
  }
});
