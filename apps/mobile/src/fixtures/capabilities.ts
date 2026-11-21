/**
 * The agent's capabilities in the app's demo world (AP-238), on top of `@whombat/fixtures` (one agent, Whombat
 * one-agent.md OA-01), so “Explore the demo burrow” shows what the phone does with them:
 *
 * - **A website login** in Mara's Vault: `@whombat/fixtures`' opt-in “Shop admin” (`vaultShopLogin`) in the list, its
 *   entry, and switched on and off for the agent in the app (`vault.giveKey`, `vault.takeKey`; CT-125, CT-1240).
 *
 * The agent's skill library is the fixture server's own world. Pure TypeScript over `Response`, unit-tested next to
 * the fixture server.
 */
import type { VaultListResponse } from '@whombat/core/contracts';
import type { VaultEntryDetail } from '@whombat/core/vault';
import { vaultShopLogin, vaultSignInEntries } from '@whombat/fixtures';

/** `vault.setTotp`'s `{totp}`: the key as sent, or null to remove it. */
function readTotp(body: string | null | undefined): string | null {
  try {
    const parsed = JSON.parse(body ?? '{}') as { totp?: unknown };
    return typeof parsed.totp === 'string' && parsed.totp.trim() ? parsed.totp : null;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface CapabilityFixturesOptions {
  now: () => Date;
  /** The login with its authenticator key set (AP-6680); default `EXPO_PUBLIC_WHOMBAT_SIGNIN=1`. */
  signIns?: boolean;
}

export interface CapabilityFixtures {
  /** A response for the endpoints this layer serves, or null to let the world answer. */
  handle(id: string | undefined, params: Record<string, string>, body?: string | null): Response | null;
  /** The world's answer with this layer's additions (the login in `vault.list`). */
  after(id: string | undefined, data: unknown): unknown;
}

export function createCapabilityFixtures(options: CapabilityFixturesOptions): CapabilityFixtures {
  const { now } = options;
  // The website login (CT-125), switched on and off for the agent in the app (CT-1240).
  const signIns = options.signIns ?? process.env.EXPO_PUBLIC_WHOMBAT_SIGNIN === '1';
  const shop = (signIns && vaultSignInEntries.find((e) => e.id === vaultShopLogin.id)) || vaultShopLogin;
  let login: VaultEntryDetail = structuredClone(shop);
  const setKey = (on: boolean) => {
    const key = on ? { givenAt: now().toISOString(), servers: null, envName: null } : null;
    login = { ...login, key, agentOn: key !== null };
    return json({ entry: login, eventId: null });
  };

  // Only whether a key is set is kept: the key itself goes nowhere (CT-1663).
  const setTotp = (on: boolean) => {
    const at = now().toISOString();
    login = { ...login, totp: on ? { set: true, setAt: at } : { set: false, setAt: null } };
    return json({ entry: login, eventId: null });
  };

  return {
    handle(id, params, body) {
      switch (id) {
        case 'vault.get':
          return params.entryId === login.id ? json({ entry: login }) : null;
        case 'vault.giveKey':
        case 'vault.takeKey':
          if (params.entryId !== login.id) return null;
          return setKey(id === 'vault.giveKey');
        case 'vault.setTotp':
          // The key itself is dropped here: only that one is set (CT-1663).
          if (params.entryId !== login.id) return null;
          return setTotp(readTotp(body) !== null);
        case 'vault.uses':
          return params.entryId === login.id ? json({ uses: [], before: null, hasMore: false }) : null;
        default:
          return null;
      }
    },
    after(id, data) {
      if (id === 'vault.list') {
        const list = data as VaultListResponse;
        const entries = [...list.entries.filter((e) => e.id !== login.id), login];
        return { ...list, entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
      }
      return data;
    },
  };
}
