/**
 * The agent in Mara's Vault, in the fixture world (Whombat vault-self-serve.md VS-01, VS-02, one-agent.md OA-09; app
 * vault-self-serve.md AP-4006, one-agent.md AP-4940; since contracts 0.125 on or off, CT-1240, AP-5240). Every entry but
 * a secret starts on for the agent on All servers (the runtime gives it when the entry is saved); `vault.giveKey`,
 * `vault.takeKey`, `vault.setKeyServers` and `vault.setKeyEnvName` change it, and every answer that carries the entry
 * carries it as `key`, the list as `agentOn`. The shared fixtures' uses are their agent's: here they are this world's
 * agent's.
 */
import type { VaultEntryWriteResponse, VaultGetResponse, VaultListResponse } from '@whombat/core/contracts';
import { defaultVaultEnvName, type VaultKeyView } from '@whombat/core/vault';
import { burrow } from '@whombat/fixtures';
import { ASSISTANT_NAME, WHOMBAT_ID } from './oneFixtures';

const VAULT = `/api/v1/burrows/${burrow.slug}/vault`;
const KEY_PATH = new RegExp(`^${VAULT}/([^/]+)/key(/env-name|/servers)?$`);

type Fetch = (req: Request) => Promise<Response>;

export interface VaultAssistantFixtures {
  /** The agent's key writes, answered here; null for anything else. */
  handle(req: Request, inner: Fetch): Promise<Response | null>;
  /** The list's `agentOn`, and every answer's entry with the agent's key. */
  decorate(req: Request, response: Response): Promise<Response>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createVaultAssistantFixtures(now: () => number = Date.now): VaultAssistantFixtures {
  /** The agent's key per entry: absent until first seen (then on), null once switched off. */
  const keys = new Map<string, VaultKeyView | null>();
  let seq = 0;

  const keyOf = (entry: { id: string; kind: string; name: string }): VaultKeyView | null => {
    if (entry.kind === 'secret') return null;
    if (!keys.has(entry.id))
      keys.set(entry.id, {
        givenAt: new Date(now()).toISOString(),
        servers: null,
        envName: entry.kind === 'http' ? defaultVaultEnvName(entry.name) : null,
      });
    return keys.get(entry.id) ?? null;
  };

  const withKey = (entry: VaultGetResponse['entry']): VaultGetResponse['entry'] => {
    const key = keyOf(entry);
    // The shared world's uses are its Dusty's: here they are this world's agent's, in their words too.
    const recentUses = entry.recentUses.map((u) => ({
      ...u,
      agentId: WHOMBAT_ID,
      what: u.what.replaceAll('Dusty', ASSISTANT_NAME),
    }));
    return { ...entry, key, agentOn: !!key, recentUses };
  };

  async function current(entryId: string, req: Request, inner: Fetch): Promise<VaultGetResponse | null> {
    const res = await inner(new Request(new URL(`${VAULT}/${entryId}`, req.url)));
    return res.ok ? ((await res.json()) as VaultGetResponse) : null;
  }

  return {
    async handle(req, inner) {
      const path = new URL(req.url, 'http://fixtures.local').pathname;
      const match = KEY_PATH.exec(path);
      if (!match || (req.method !== 'PUT' && req.method !== 'DELETE')) return null;
      const entryId = match[1] as string;
      // The shared world signs the Vault event (“Switched off … for Neo”) for switching the entry on or off itself.
      const forward = match[2] ? null : req.clone();
      const got = await current(entryId, req, inner);
      if (!got) return json({ error: { code: 'not_found', message: 'No such Vault entry.' } }, 404);
      const before = keyOf(got.entry);
      const body = req.method === 'PUT' ? ((await req.json()) as Partial<VaultKeyView>) : {};
      if (match[2]) {
        if (!before) return json({ error: { code: 'not_found', message: 'It’s off for the agent.' } }, 404);
        keys.set(
          entryId,
          match[2] === '/servers'
            ? { ...before, servers: body.servers ?? null }
            : { ...before, envName: body.envName ?? before.envName },
        );
      } else if (req.method === 'DELETE') {
        if (!before) return json({ error: { code: 'not_found', message: 'It’s off for the agent.' } }, 404);
        keys.set(entryId, null);
      } else {
        if (got.entry.kind === 'secret')
          return json({ error: { code: 'wrong_kind', message: 'Nothing uses this entry any more.' } }, 409);
        keys.set(entryId, {
          givenAt: before?.givenAt ?? new Date(now()).toISOString(),
          servers: body.servers === undefined ? (before?.servers ?? null) : body.servers,
          envName:
            got.entry.kind === 'http'
              ? (body.envName ?? before?.envName ?? defaultVaultEnvName(got.entry.name))
              : null,
        });
      }
      seq += 1;
      const signed = forward ? await inner(forward) : null;
      const eventId = signed?.ok
        ? (((await signed.json()) as { eventId?: string | null }).eventId ?? null)
        : null;
      return json({
        entry: withKey(got.entry),
        eventId: eventId ?? `evt_vault-assistant-${seq}`,
      } satisfies VaultEntryWriteResponse);
    },

    async decorate(req, response) {
      const path = new URL(req.url, 'http://fixtures.local').pathname;
      if (!response.ok || !path.startsWith(VAULT)) return response;
      if (req.method === 'GET' && path === VAULT) {
        const list = (await response.json()) as VaultListResponse;
        return json({
          ...list,
          entries: list.entries.map((e) => (e.kind === 'secret' ? e : { ...e, agentOn: !!keyOf(e) })),
        } satisfies VaultListResponse);
      }
      if (!(response.headers.get('content-type') ?? '').includes('json')) return response;
      // Every answer that carries the entry (a check, a replaced secret, a tool) carries the agent's key.
      const body = (await response.clone().json()) as Partial<VaultGetResponse> | null;
      if (!body?.entry || !('key' in body.entry)) return response;
      return json({ ...body, entry: withKey(body.entry) }, response.status);
    },
  };
}
