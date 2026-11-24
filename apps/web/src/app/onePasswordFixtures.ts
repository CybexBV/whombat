/**
 * A 1Password vault kept in step with Mara's Vault, in fixture mode (`VITE_FIXTURE_ONEPASSWORD=synced|waiting|failing|
 * paused`, option `onePassword`; Whombat onepassword-sync.md; app docs/app/decisions/onepassword-sync.md): the
 * 1Password connection Mara made, its page part as the last pass left it, and the Vault entries it keeps in step.
 *
 * - `synced`: the last pass went well 3 min ago; one entry waits to go, one stopped fitting; five items aren't in the
 *   Vault, each with its reason.
 * - `waiting`: 1Password's limit, the next try at 11:40.
 * - `failing`: 1Password didn't answer, and the token turned out to only read.
 * - `paused`: 1Password says 4 items are gone; the page and a card in the Inbox ask “Remove them here too” or “Keep
 *   them here”.
 *
 * It answers the connection's page and part, Sync now (a pass for a moment), the guard's answer (refused when the set
 * changed), Check again and Remove (keeping or removing the entries), and adds its row to the connections and the
 * entries' `source` to the Vault (inside the connections' own pages, which find it there), and the card to the Inbox
 * (outside the one-Whombat layer, which answers Home). State lives in the closure, built to the contracts' schemas. The
 * mock world's moment is 09:22 UTC (11:22 in Amsterdam).
 */
import { API_ENDPOINTS, api, buildPath, matchPath } from '@whombat/core/contracts';
import type { ConnectionView, HomeOverview, NeedsYouItem } from '@whombat/core/domain';
import {
  ONEPASSWORD_WORDS,
  type OnePasswordSyncView,
  onePasswordGoneTitle,
  type VaultEntry,
  type VaultEntryDetail,
  type VaultEntrySource,
} from '@whombat/core/vault';
import { burrow, mara, vaultGrafana, vaultPrinter, vaultShopLogin } from '@whombat/fixtures';

const API_BASE = '/api/v1';
export const ONEPASSWORD_CONNECTION_ID = 'con_fixture_1password';

export const ONEPASSWORD_FIXTURE_KINDS = ['synced', 'waiting', 'failing', 'paused'] as const;
export type OnePasswordFixtureKind = (typeof ONEPASSWORD_FIXTURE_KINDS)[number];

/** `VITE_FIXTURE_ONEPASSWORD`'s kind, or none. */
export function onePasswordFixtureOf(value: string | undefined): OnePasswordFixtureKind | undefined {
  return ONEPASSWORD_FIXTURE_KINDS.find((k) => k === value);
}

const at = (iso: string) => new Date(iso).toISOString();
const CHECKED = at('2026-09-23T09:19:00Z');
const SYNCED = at('2026-09-23T09:20:00Z');
/** 11:40 in Amsterdam. */
const NEXT_TRY = at('2026-09-23T09:40:00Z');

/** A login from 1Password: the shop login's shape with its own name and page. */
function login(id: string, name: string, url: string, username: string): VaultEntryDetail {
  return {
    ...structuredClone(vaultShopLogin),
    id,
    name,
    description: '',
    url,
    auth: { type: 'form', username },
    recentUses: [],
  };
}

/** An API token from 1Password: Grafana's shape with its own name and address. */
function apiToken(id: string, name: string, url: string): VaultEntryDetail {
  return { ...structuredClone(vaultGrafana), id, name, description: '', url, recentUses: [] };
}

/** The entries 1Password brought into Mara's Vault (the fixture world's own Grafana and Printer admin are kept too). */
export const ONEPASSWORD_FIXTURE_ENTRIES: readonly VaultEntryDetail[] = [
  login(
    'vlt_1p_billing',
    'Billing portal',
    'https://billing.burrowhq.example/login',
    'mara@burrowhq.example',
  ),
  apiToken('vlt_1p_status', 'Status page API', 'https://status.burrowhq.example/api'),
  login('vlt_1p_router', 'Old router', 'https://10.100.0.1/', 'admin'),
  login('vlt_1p_mail', 'Mail admin', 'https://mail.burrowhq.example/admin', 'postmaster@burrowhq.example'),
  apiToken('vlt_1p_backups', 'Backups API', 'https://backups.burrowhq.example/v1'),
];

/** How each entry stands with 1Password. */
const SOURCES: Record<string, VaultEntrySource> = {
  [vaultGrafana.id]: { kind: 'onepassword', state: 'synced', syncedAt: SYNCED },
  [vaultPrinter.id]: { kind: 'onepassword', state: 'synced', syncedAt: SYNCED },
  vlt_1p_billing: { kind: 'onepassword', state: 'synced', syncedAt: SYNCED },
  vlt_1p_status: { kind: 'onepassword', state: 'synced', syncedAt: SYNCED },
  vlt_1p_router: { kind: 'onepassword', state: 'synced', syncedAt: SYNCED },
  vlt_1p_mail: {
    kind: 'onepassword',
    state: 'problem',
    syncedAt: SYNCED,
    problem: '1Password’s item has no website now',
  },
  vlt_1p_backups: { kind: 'onepassword', state: 'pending', syncedAt: null },
};

/** What 1Password says is gone in `paused`. */
const GONE = ['vlt_1p_billing', 'vlt_1p_status', 'vlt_1p_router', 'vlt_1p_mail'];

const NOT_IN_VAULT: OnePasswordSyncView['notInVault'] = [
  { itemId: 'p6x2hk3z4m5n6b7v8c9x0z1a2s', title: 'Bank card', reason: 'other_kind' },
  { itemId: 'q7w8e9r0t1y2u3i4o5p6a7s8d9', title: 'NAS admin', reason: 'unreachable' },
  { itemId: 'r8t9y0u1i2o3p4a5s6d7f8g9h0', title: 'Server key', reason: 'ssh_key' },
  { itemId: 's9d0f1g2h3j4k5l6z7x8c9v0b1', title: 'Forum', reason: 'no_website' },
  { itemId: 't0f1g2h3j4k5l6z7x8c9v0b1n2', title: 'Office printer', reason: 'vault_full' },
];

export function createOnePasswordFixtures({ kind }: { kind: OnePasswordFixtureKind }) {
  let connection: ConnectionView | null = {
    id: ONEPASSWORD_CONNECTION_ID,
    catalogId: 'onepassword',
    label: '1Password',
    handle: 'onepassword',
    connectedBy: { id: mara.id, name: mara.name },
    detail: null,
    signIn: 'token',
    transport: 'rest',
    fields: { vault: 'k3ntq6b7f2x4yhd5wzmuv9cj8a', entries: 'put' },
    status: 'active',
    reauthReason: null,
    checks: [{ id: 'credential', state: 'ok', message: null }],
    checkedAt: CHECKED,
    toolCount: 0,
    access: 'manage',
    poller: null,
    createdAt: '2026-09-21T14:02:00.000Z',
    lastUsedAt: null,
  };
  /** Entries kept in step now, by id; one Mara kept only here loses its tag. */
  const sources = new Map(Object.entries(SOURCES));
  let removals: OnePasswordSyncView['removals'] =
    kind === 'paused'
      ? {
          token: 'set_fixture_1',
          since: CHECKED,
          entries: GONE.map((id) => ({
            entryId: id,
            name: ONEPASSWORD_FIXTURE_ENTRIES.find((e) => e.id === id)?.name ?? id,
          })),
        }
      : null;
  let outcome: OnePasswordSyncView['outcome'] =
    kind === 'synced' ? 'ok' : kind === 'waiting' ? 'waiting' : kind === 'failing' ? 'failing' : 'paused';
  let checkedAt = CHECKED;
  let syncing = false;
  let seq = 0;

  const view = (): OnePasswordSyncView => {
    const states = [...sources.values()];
    return {
      connectionId: ONEPASSWORD_CONNECTION_ID,
      vaultTitle: 'Whombat',
      kept: states.filter((s) => s.state !== 'pending').length,
      pending: states.filter((s) => s.state === 'pending').length,
      localOnly: Object.keys(SOURCES).length - sources.size,
      checkedAt,
      outcome,
      problem: null,
      nextTryAt: outcome === 'waiting' ? NEXT_TRY : null,
      readOnly: kind === 'failing',
      syncing,
      notInVault: NOT_IN_VAULT,
      removals: outcome === 'paused' ? removals : null,
    };
  };

  /** The guard's card in the Inbox while it holds removals. */
  const card = (): NeedsYouItem | null => {
    if (!connection || outcome !== 'paused' || !removals) return null;
    const token = removals.token;
    const href = `/things/connection%3A${connection.id}`;
    return {
      id: `connection:${connection.id}`,
      ref: { kind: 'connection', id: connection.id },
      kind: 'connection',
      severity: 'warn',
      nature: 'you',
      group: 'you',
      title: onePasswordGoneTitle(removals.entries.length),
      body: removals.entries.map((e) => e.name).join(', '),
      at: removals.since,
      href,
      subject: { kind: 'connection', id: connection.id, name: connection.label },
      actions: [
        {
          id: 'remove',
          label: ONEPASSWORD_WORDS.removeHere,
          style: 'secondary',
          kind: 'onepassword_removals',
          removals: { answer: 'remove', token },
        },
        {
          id: 'keep',
          label: ONEPASSWORD_WORDS.keepHere,
          style: 'primary',
          kind: 'onepassword_removals',
          removals: { answer: 'keep', token },
        },
      ],
    };
  };

  const match = (req: Request) => {
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
    for (const ep of API_ENDPOINTS) {
      if (ep.method !== req.method) continue;
      const params = matchPath(ep.path, path);
      if (params && params.burrow === burrow.slug) return { id: ep.id, params, url };
    }
    return null;
  };

  const ours = (params: Record<string, string>) => !!connection && params.connectionId === connection.id;

  /** Removes entries through the world inside, as the person's own removal does. */
  const removeEntries = async (ids: readonly string[], inner: (r: Request) => Promise<Response>) => {
    for (const entryId of ids) {
      sources.delete(entryId);
      await inner(
        new Request(
          new URL(
            `${API_BASE}${buildPath(api.vault.remove.path, { burrow: burrow.slug, entryId })}`,
            'http://fixtures.local',
          ),
          { method: 'DELETE' },
        ),
      );
    }
  };

  return {
    /** Its own answers: the connection's page and part, Sync now, the guard's answer, Check again and Remove. */
    async handle(req: Request, inner: (r: Request) => Promise<Response>): Promise<Response | null> {
      const m = match(req);
      if (!m || !ours(m.params)) return null;
      switch (m.id) {
        case 'connections.tools':
          return json({ connection, tools: [], guide: '', truncated: false });
        case 'connections.recheck':
          return json({ connection, eventId: `evt_1p_${++seq}` });
        case 'connections.onePassword':
          return json(view());
        case 'connections.onePasswordSync': {
          // A pass for a moment; its end changes nothing the page didn't show, so it reads again while it runs.
          syncing = true;
          setTimeout(() => {
            syncing = false;
            checkedAt = new Date().toISOString();
          }, 2500);
          return json(view());
        }
        case 'connections.onePasswordRemovals': {
          const body = (await req.clone().json()) as { answer?: 'remove' | 'keep'; token?: string };
          if (!removals || body.token !== removals.token)
            return json(
              { error: { code: 'conflict', message: 'The removals changed since they were shown.' } },
              409,
            );
          const ids = removals.entries.map((e) => e.entryId);
          if (body.answer === 'remove') await removeEntries(ids, inner);
          else for (const id of ids) sources.delete(id);
          removals = null;
          outcome = 'ok';
          return json(view());
        }
        case 'connections.disconnect': {
          // 1Password itself never changes; the entries stay as Whombat entries unless Mara removes them too.
          if (m.url.searchParams.get('vaultEntries') === 'remove')
            await removeEntries([...sources.keys()], inner);
          sources.clear();
          connection = null;
          return json({ ok: true, eventId: `evt_1p_${++seq}`, notice: null });
        }
        default:
          return null;
      }
    },

    /** Its parts of other answers: the connections' row, the entries' tags and lines, the Inbox's card. */
    async decorate(req: Request, response: Response): Promise<Response> {
      if (req.method !== 'GET' || !response.ok) return response;
      const m = match(req);
      if (!m) return response;
      switch (m.id) {
        case 'connections.list': {
          const data = (await response.json()) as { connections: ConnectionView[] };
          return json({
            ...data,
            connections: connection ? [connection, ...data.connections] : data.connections,
          });
        }
        case 'vault.list': {
          const data = (await response.json()) as { entries: VaultEntry[] };
          return json({ ...data, entries: data.entries.map(withSource) });
        }
        case 'vault.get': {
          const data = (await response.json()) as { entry: VaultEntryDetail };
          return json({ ...data, entry: withSource(data.entry) });
        }
        default:
          return response;
      }
    },

    /** The guard's card in the Inbox, over the one-Whombat layer that answers Home. */
    async decorateInbox(req: Request, response: Response): Promise<Response> {
      if (req.method !== 'GET' || !response.ok || match(req)?.id !== 'home.overview') return response;
      const data = (await response.json()) as HomeOverview;
      const item = card();
      if (!item || !data.needsYouList) return json(data);
      // It needs Mara: the one count follows.
      return json({
        ...data,
        summary: { ...data.summary, needsYou: data.summary.needsYou + 1 },
        needsYouList: [item, ...data.needsYouList],
      });
    },
  };

  function withSource<T extends VaultEntry>(entry: T): T {
    const source = connection ? sources.get(entry.id) : undefined;
    return source ? { ...entry, source } : entry;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
