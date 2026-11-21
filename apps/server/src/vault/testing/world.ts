/**
 * A Vault test world on the seeded burrow: the fakes (a Home Assistant–like MCP server and a plain API) behind virtual
 * home-network addresses (`useVaultNetForTests`), this Whombat's home network list naming them, and REST helpers as
 * the person, Mara (one-person.md OP-S01).
 */
import { type AnyEndpoint, api, buildPath, toQueryString } from '@whombat/core';
import { afterAll, beforeAll } from 'vitest';
import { IDS } from '../../seed/test-world';
import type { TestServer } from '../../test/harness';
import { sessionFor } from '../../test/tokens';
import { useVaultNetForTests } from '../net';
import { type FakeApi, type FakeHome, fakeApi, fakeHomeAssistant } from './fakes';

export const HA_TOKEN = 'ha-llat-9f8e7d6c/5b4a39281706f5e4d3c2b1a0';
export const API_TOKEN = 'api-token-Zq8Wm3Rt5Yv7Ux9Np2Kd4Hf6';

/** Virtual addresses the resolver answers with (tests change them to rebind). */
export const HOSTS: Record<string, string[]> = {
  'ha.home.test': ['192.168.77.10'],
  'api.home.test': ['192.168.77.11'],
  'printer.home.test': ['192.168.78.5'],
  'rebind.home.test': ['192.168.77.12'],
  'mixed.example': ['192.168.77.13', '93.184.216.34'],
  'public.example': ['93.184.216.34'],
  'meta.home.test': ['169.254.169.254'],
  'loop.home.test': ['127.0.0.1'],
};

export interface VaultWorld {
  ha: FakeHome;
  api: FakeApi;
  /** The person's session cookie. */
  cookies: Record<'mara', string>;
  call(
    ep: AnyEndpoint,
    params: Record<string, string | number>,
    body?: unknown,
    who?: keyof VaultWorld['cookies'],
    query?: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown>; raw: string }>;
  haUrl(path?: string): string;
  apiUrl(path?: string): string;
  /** Adds the fakes' network (192.168.77.0/24 with both ports) as Mara. */
  listHomeNetwork(): Promise<void>;
}

export function useVaultWorld(t: TestServer, options: { deadlineMs?: number } = {}): VaultWorld {
  const world = { cookies: {} } as VaultWorld;
  beforeAll(async () => {
    world.ha = await fakeHomeAssistant(HA_TOKEN);
    world.api = await fakeApi((req) => req.headers.authorization === `Bearer ${API_TOKEN}`);
    useVaultNetForTests(t.services, {
      resolve: async (host) => {
        const list = HOSTS[host];
        if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
        return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
      },
      // The fakes stand behind 192.168.77.0/24; everything else is dialled as resolved (and refused before that).
      dialAddress: (address) => (address.startsWith('192.168.77.') ? '127.0.0.1' : address),
      deadlineMs: options.deadlineMs ?? 1500,
    });
    world.cookies.mara = (await sessionFor(t.services, IDS.mara)).cookie;
  });
  afterAll(async () => {
    await world.ha?.close();
    await world.api?.close();
  });
  world.call = async (ep, params, body, who = 'mara', query) => {
    const res = await t.api.inject({
      method: ep.method,
      url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', ...params })}${toQueryString(query as never)}`,
      headers: { cookie: world.cookies[who] },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = res.json();
    } catch {
      parsed = {};
    }
    return { status: res.statusCode, body: parsed, raw: res.body };
  };
  world.haUrl = (path = '/api/mcp') => `http://ha.home.test:${world.ha.port}${path}`;
  world.apiUrl = (path = '/v1') => `http://api.home.test:${world.api.port}${path}`;
  world.listHomeNetwork = async () => {
    const res = await world.call(
      api.vaultNetworks.add,
      {},
      { cidr: '192.168.77.0/24', ports: [world.ha.port, world.api.port], note: 'The fakes' },
      'mara',
    );
    if (res.status !== 201 && !(res.status === 409 && res.raw.includes('network_listed')))
      throw new Error(`could not list the home network: ${res.status} ${res.raw}`);
  };
  return world;
}
