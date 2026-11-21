/**
 * Pure logic of the connect side (docs/decisions/connections-catalog.md): the OAuth challenge and discovery addresses,
 * the return path guard, the service's answers (who it is, the choices of a `fromService` field), MCP answers and the
 * repair text.
 */
import { CATALOG, catalogEntry } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { KeyCustody } from '../keys/custody';
import { ApiError } from '../lib/errors';
import { type CheckOutcome, externalNameFrom, mcpAnswer, serviceChoices } from './checks';
import {
  CHALLENGE_TTL_MS,
  chooseServiceFields,
  cleanFields,
  openChallenge,
  sealChallenge,
  withProvisionNote,
} from './connect';
import { repairText } from './notify';
import { authServerCandidates, parseWwwAuthenticate, protectedResourceCandidates } from './oauth';
import { withParams } from './oauth-connect';
import { provisionUrl } from './provision/run';
import { appRedirectUri, haClientId, mcpRedirectUris } from './redirect';

const outcome = (json: unknown): CheckOutcome => ({
  ok: true,
  refused: false,
  status: 200,
  message: null,
  json,
  checks: [],
});

describe('the OAuth challenge (RFC 6750, RFC 9728)', () => {
  it('reads resource_metadata, scope and error, quoted or not', () => {
    expect(
      parseWwwAuthenticate(
        'Bearer realm="mcp", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="read write", error=invalid_token',
      ),
    ).toEqual({
      scheme: 'Bearer',
      resourceMetadata: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
      scope: 'read write',
      error: 'invalid_token',
    });
    expect(parseWwwAuthenticate('Bearer')).toEqual({
      scheme: 'Bearer',
      resourceMetadata: null,
      scope: null,
      error: null,
    });
    expect(parseWwwAuthenticate('Bearer error_description="a \\"quoted\\" word"')?.error).toBeNull();
  });
});

describe('discovery addresses', () => {
  it('inserts the well-known path before the resource path, then the root (RFC 9728 §3.1)', () => {
    expect(protectedResourceCandidates('https://mcp.notion.com/mcp')).toEqual([
      'https://mcp.notion.com/.well-known/oauth-protected-resource/mcp',
      'https://mcp.notion.com/.well-known/oauth-protected-resource',
    ]);
    expect(protectedResourceCandidates('https://mcp.example.com/')).toEqual([
      'https://mcp.example.com/.well-known/oauth-protected-resource',
    ]);
  });

  it('tries OAuth then OpenID metadata, path-inserted first (RFC 8414 §3.1)', () => {
    expect(authServerCandidates('https://auth.example.com')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration',
    ]);
    expect(authServerCandidates('https://auth.example.com/tenant1/')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/openid-configuration/tenant1',
      'https://auth.example.com/tenant1/.well-known/openid-configuration',
    ]);
  });
});

describe('the return path (IN-19)', () => {
  it('adds the result and keeps what the path has', () => {
    expect(
      withParams('/hq/settings?tab=connections&connect_error=x', {
        connected: 'dropbox',
        connection: 'con_1',
      }),
    ).toBe('/hq/settings?tab=connections&connected=dropbox&connection=con_1');
  });

  it('never leaves this Whombat', () => {
    expect(
      withParams('//evil.com/x', { connect_error: 'invalid_state' }, '/hq/settings?tab=connections'),
    ).toBe('/hq/settings?tab=connections&connect_error=invalid_state');
    expect(withParams('/.//evil.com', { connect_error: 'invalid_state' })).toBe(
      '/?connect_error=invalid_state',
    );
  });
});

describe('what the service answered', () => {
  it('names who the credential is', () => {
    expect(externalNameFrom({ email: 'mara@example.com', name: 'Mara' })).toBe('mara@example.com');
    expect(externalNameFrom({ login: 'mara' })).toBe('mara');
    expect(externalNameFrom({ name: { display_name: 'Mara Okafor' } })).toBe('Mara Okafor');
    expect(externalNameFrom({ message: 'API running.' })).toBeNull();
    expect(externalNameFrom([{ id: 1 }])).toBeNull();
  });

  it('lists the choices of a fromService field', () => {
    expect(serviceChoices([{ id: 1234567, name: 'Okafor BV' }, { id: '2' }, 'x'])).toEqual([
      { value: '1234567', label: 'Okafor BV' },
      { value: '2', label: '2' },
    ]);
  });

  it('picks the only administration, asks among several, and checks a given one (CT-268)', () => {
    const moneybird = catalogEntry('moneybird');
    if (!moneybird) throw new Error('no moneybird');
    expect(chooseServiceFields(moneybird, 'token', {}, outcome([{ id: '7', name: 'A' }]))).toEqual({
      administration: '7',
    });
    const several = outcome([
      { id: '7', name: 'A' },
      { id: '8', name: 'B' },
    ]);
    try {
      chooseServiceFields(moneybird, 'token', {}, several);
      throw new Error('no refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).extra.details).toMatchObject({
        code: 'field_choice_needed',
        field: 'administration',
        options: [
          { value: '7', label: 'A' },
          { value: '8', label: 'B' },
        ],
      });
    }
    expect(chooseServiceFields(moneybird, 'token', { administration: '8' }, several)).toEqual({
      administration: '8',
    });
    expect(() => chooseServiceFields(moneybird, 'token', { administration: '9' }, several)).toThrow(ApiError);
  });

  it('reads an MCP answer as JSON or from an event stream', () => {
    const json = { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'x' } } };
    expect(
      mcpAnswer({ body: Buffer.from(JSON.stringify(json)), headers: { 'content-type': 'application/json' } }),
    ).toEqual(json);
    expect(
      mcpAnswer({
        body: Buffer.from(`event: message\ndata: ${JSON.stringify(json)}\n\n`),
        headers: { 'content-type': 'text/event-stream' },
      }),
    ).toEqual(json);
  });
});

describe('small helpers', () => {
  it('drops empty fields', () => {
    expect(cleanFields({ url: ' http://ha.local:8123 ', username: '  ' })).toEqual({
      url: 'http://ha.local:8123',
    });
  });

  it('says what to reconnect and why', () => {
    const text = repairText({ label: 'Todoist', reauthReason: 'token_invalid' });
    expect(text).toContain('Todoist');
    expect(text).toContain('stopped accepting my sign-in');
    expect(text).toContain('Settings → Connections');
    expect(repairText({ label: 'Home Assistant · home.lan', reauthReason: null })).toContain(
      'took my access back',
    );
  });
});

describe('where sign-ins come back (CX-D04, CX-D05)', () => {
  const config = { WHOMBAT_APP_URL: 'https://app.whombat.com/' };

  it('the hosted UI’s route, and its origin as Home Assistant’s client id', () => {
    expect(appRedirectUri(config, 'homeassistant')).toBe('https://app.whombat.com/connect/homeassistant');
    expect(haClientId(config)).toBe('https://app.whombat.com/');
  });

  it('names a redirect for every MCP sign-in', () => {
    // Every entry that signs in to an MCP server (Notion, the vendor MCP servers of SG-20, Custom MCP), in catalog order.
    const mcp = CATALOG.filter((e) => e.signIn.some((m) => m.kind === 'mcp_oauth')).map((e) => e.id);
    expect(mcp).toEqual(expect.arrayContaining(['notion', 'custom_mcp']));
    expect(mcpRedirectUris(config)).toEqual(mcp.map((id) => `https://app.whombat.com/connect/${id}`));
  });
});

describe('sign in once (connections-setup.md CS-01, CS-08)', () => {
  it('turns the provisioner’s note into the credential line, a warning', () => {
    const ok = { id: 'credential' as const, state: 'ok' as const, message: null };
    const http = {
      id: 'destination' as const,
      state: 'warning' as const,
      message: 'This address uses http.',
    };
    expect(withProvisionNote([ok, http], null)).toEqual([ok, http]);
    expect(withProvisionNote([ok, http], ' Read this. ')).toEqual([
      { id: 'credential', state: 'warning', message: 'Read this.' },
      http,
    ]);
    expect(withProvisionNote([], 'Read this.')).toEqual([
      { id: 'credential', state: 'warning', message: 'Read this.' },
    ]);
  });

  it('keeps a provisioner’s requests on the service’s own address', () => {
    expect(provisionUrl('https://pve.local:8006/', '/api2/json/version')).toBe(
      'https://pve.local:8006/api2/json/version',
    );
    expect(provisionUrl('https://cloud.local/nextcloud', '/ocs/v2.php/core/getapppassword')).toBe(
      'https://cloud.local/nextcloud/ocs/v2.php/core/getapppassword',
    );
    expect(provisionUrl('https://pve.local:8006', 'https://pve.local:8006/other')).toBe(
      'https://pve.local:8006/other',
    );
    expect(() => provisionUrl('https://pve.local:8006', 'https://pve.local:8007/x')).toThrow(
      'Sign in once stays on the service’s own address.',
    );
    expect(() => provisionUrl('https://pve.local:8006', 'not a url')).toThrow('Not a URL.');
  });
});

describe('a second factor’s challenge (connection-signin.md SG-06)', () => {
  let now = new Date('2026-10-21T10:00:00Z');
  const services = { custody: new KeyCustody(Buffer.alloc(32, 9).toString('base64')), clock: () => now };
  const bound = {
    entryId: 'unifi_network',
    baseUrl: 'https://192.168.1.1/proxy/network/integration',
    account: 'Mara',
  };

  it('opens only for the entry, the address’s origin and the account it was made for, for 10 minutes', () => {
    const sealed = sealChallenge(services, bound, 'challenge-jwt') as string;
    expect(sealed).not.toContain('challenge-jwt');
    // Another path on the same origin and the account in other letters are the same.
    expect(
      openChallenge(services, { ...bound, baseUrl: 'https://192.168.1.1/', account: ' mara' }, sealed),
    ).toBe('challenge-jwt');
    expect(openChallenge(services, { ...bound, entryId: 'unifi_protect' }, sealed)).toBeNull();
    expect(openChallenge(services, { ...bound, baseUrl: 'https://192.168.1.2' }, sealed)).toBeNull();
    expect(openChallenge(services, { ...bound, account: 'pip' }, sealed)).toBeNull();
    expect(openChallenge(services, bound, `${sealed.slice(0, -4)}AAAA`)).toBeNull();
    expect(openChallenge(services, bound, undefined)).toBeNull();
    now = new Date(now.getTime() + CHALLENGE_TTL_MS);
    expect(openChallenge(services, bound, sealed)).toBeNull();
  });

  it('hands back nothing without a challenge, or one too long to carry', () => {
    expect(sealChallenge(services, bound, null)).toBeNull();
    expect(sealChallenge(services, bound, 'x'.repeat(5000))).toBeNull();
  });
});
