/**
 * Setting a connection up from the chat (Whombat connect-in-chat.md): what the assistant's `connection_add` card
 * fills in. Pure, shared by the server (which makes the card), the web and the phone (which open the form it points at).
 *
 * - **Which entry.** The assistant names it by catalog id or name (“homeassistant”, “Home Assistant”); only entries a
 *   person connects for agents qualify (not builtins, not automations' or gateways').
 * - **Look only or Manage, by risk.** Manage where everyday use is changing things and a mistake is easy to undo
 *   (lights and scenes, an ad blocker's pause, adding a film to a list); Look only for everything that holds data or
 *   keeps the house or the network running (a NAS, photos, the router, doors and cameras, DNS, money, code). And Manage
 *   where the service is connected to hand work over (T3 Code's coding agents). The person changes it on the
 *   connection's page whenever they like.
 * - **The link.** The connect form with the address filled in and the level chosen
 *   (`/settings?tab=connections&connection=homeassistant&url=…&access=manage`); the form identifies the address at once
 *   and trusts a home-network server's own certificate (connections-setup.md CS-54), the one the scan saw. Sign in once
 *   is the form's first sign-in, so it is the default.
 * - **Set up by talking** (connect-by-talking.md): an MCP server or API outside the catalog is a Custom entry the
 *   assistant fills in from its documentation; the card says what it connects, takes the key and connects on the card.
 */

import {
  type CatalogEntry,
  CONNECTION_ACCESS_DEFAULTS,
  CONNECTION_ACCESS_LABELS,
  CONNECTION_LABEL_MAX,
  type ConnectionAccessLevel,
  HeaderName,
  QueryName,
  type TokenAuth,
} from './connections-catalog/shared.js';
import {
  CATALOG_CONNECTABLE,
  catalogEntry,
  isAgentConnection,
  tokenAuthProblem,
} from './connections-catalog.js';
import { GuideCard, GuideConnectAsk } from './guides.js';

/**
 * Entries set to Manage when the assistant connects them: what people use them for is changing things, and a mistake
 * is easy to put right, or (T3 Code) they are connected to hand work to their agents. Everything else starts at Look
 * only.
 */
export const CONNECT_MANAGE_FIRST: readonly string[] = [
  'homeassistant',
  'esphome',
  'pihole',
  'adguard',
  'plex',
  'jellyfin',
  'sonarr',
  'radarr',
  'overseerr',
  'sabnzbd',
  'qbittorrent',
  'nzbhydra',
  'todoist',
  't3code',
];

/** The level the assistant's card chooses for an entry (by risk, above). */
export function suggestedAccess(entry: Pick<CatalogEntry, 'id'>): ConnectionAccessLevel {
  return CONNECT_MANAGE_FIRST.includes(entry.id) ? 'manage' : 'read';
}

/** An entry a person can connect for the assistant: connectable, used by agents. */
export function connectableForAgent(entry: CatalogEntry | null): entry is CatalogEntry {
  return !!entry && entry.transport !== 'builtin' && isAgentConnection(entry);
}

/** Lower case, letters and digits only: “Home Assistant” and “home-assistant” read the same. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The entry the assistant named: its id, its name or its handle, without regard to case, spaces or dashes; null when
 * none (or more than one) is meant.
 */
export function connectEntryOf(named: string): CatalogEntry | null {
  const exact = catalogEntry(named.trim());
  if (connectableForAgent(exact)) return exact;
  const want = squash(named);
  if (!want) return null;
  const matches = CATALOG_CONNECTABLE.filter(
    (e) =>
      connectableForAgent(e) &&
      (squash(e.id) === want || squash(e.name) === want || squash(e.handle) === want),
  );
  return matches.length === 1 ? (matches[0] as CatalogEntry) : null;
}

/** What a level means for this entry, said of the assistant (“Dusty can see your VMs … and change nothing.”). */
export function connectAccessLine(entry: CatalogEntry, level: ConnectionAccessLevel, agent: string): string {
  const text = entry.access?.[level] ?? CONNECTION_ACCESS_DEFAULTS[level];
  return text.replace(/^(The agent|Agents|Your agent) /, `${agent} `);
}

/**
 * The card's paragraph on the level: “Look only to start: Dusty can see … and change nothing. You can switch it to
 * Manage on its page.” / “Manage: Dusty can also switch devices … still ask you first.”
 */
export function connectAccessWords(entry: CatalogEntry, level: ConnectionAccessLevel, agent: string): string {
  const line = connectAccessLine(entry, level, agent);
  return level === 'manage'
    ? `${CONNECTION_ACCESS_LABELS.manage}: ${line}`
    : `${CONNECTION_ACCESS_LABELS.read} to start: ${line} You can switch it to ${CONNECTION_ACCESS_LABELS.manage} on its page.`;
}

/** What the connect form opens with from the assistant's card. */
export interface ConnectAsk {
  catalogId: string;
  /** The address to identify at once; null: the form asks where it is. */
  url: string | null;
  access: ConnectionAccessLevel;
}

/** The connect form's address on this Whombat, filled in: `/settings?tab=connections&connection=…&url=…&access=…`. */
export function connectAskHref(ask: ConnectAsk): string {
  const pairs: [string, string][] = [
    ['tab', 'connections'],
    ['connection', ask.catalogId],
    ...(ask.url ? ([['url', ask.url]] as [string, string][]) : []),
    ['access', ask.access],
  ];
  return `/settings?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

/** The level a link asks the form for (`&access=read|manage`), or null when it names none. */
export function connectAccessOf(raw: unknown): ConnectionAccessLevel | null {
  return raw === 'read' || raw === 'manage' ? raw : null;
}

/* An MCP server or API set up by talking (Whombat connect-by-talking.md) ------------------------------------------------ */

/** The form on a card that connects on the card, its Not now and its fields' ids (sent back in `guides.act`). */
export const CONNECT_HERE_FORM = 'connect';
export const CONNECT_HERE_DECLINE = 'no';
export const CONNECT_HERE_FIELDS = { secret: 'secret', username: 'username' } as const;

/** The card's words; `{assistant}` is the assistant's short name. */
export const CONNECT_HERE_TEXT = {
  title: (label: string) => `Connect ${label}`,
  signInTitle: (label: string) => `Sign in to ${label}`,
  where: { mcp: (at: string) => `An MCP server at ${at}.`, api: (at: string) => `An API at ${at}.` },
  none: 'It needs no sign-in.',
  token: (assistant: string) =>
    `Paste its token below. Whombat keeps it sealed and ${assistant} never sees it.`,
  key: (assistant: string) => `Paste its key below. Whombat keeps it sealed and ${assistant} never sees it.`,
  basic: (assistant: string) =>
    `Type its username and password below. Whombat keeps the password sealed and ${assistant} never sees it.`,
  oauth: (label: string) => `It signs in with your ${label} account: the button opens its sign-in.`,
  labels: { token: 'Token', key: 'Key', password: 'Password', username: 'Username' },
  connect: 'Connect',
  signIn: 'Sign in…',
  notNow: 'Not now',
  connected: (label: string) => `Connected · ${label}`,
  declined: 'Not now',
  empty: {
    token: 'Paste the token.',
    key: 'Paste the key.',
    password: 'Type the password.',
    username: 'Type the username.',
  },
} as const;

/** What the assistant chose, as `connection_add` takes it. */
export interface ConnectHereChoice {
  label: string;
  url: string;
  signIn: 'none' | 'bearer' | 'header' | 'basic' | 'query';
  keyName?: string | undefined;
  keyPrefix?: string | undefined;
  username?: string | undefined;
  notes?: string | undefined;
  access: ConnectionAccessLevel;
}

/** Whether an entry is set up by talking (a Custom entry: any MCP server, any API) rather than through its form. */
export function connectsByTalking(entry: Pick<CatalogEntry, 'category'>): boolean {
  return entry.category === 'custom';
}

/**
 * The card's destination from what the assistant chose (pure): the entry's sign-in way for that shape (`method`, the
 * index among its token ways), the header or query name it gave, the username; or why it doesn't fit, to the agent.
 */
export function connectHereAsk(
  entry: CatalogEntry,
  choice: ConnectHereChoice,
): { ask: GuideConnectAsk } | { problem: string } {
  const base = {
    catalogId: entry.id,
    label: choice.label.trim().slice(0, CONNECTION_LABEL_MAX),
    url: choice.url,
    username: null,
    notes: (choice.notes ?? '').trim().slice(0, 1500),
    access: choice.access,
  };
  if (choice.signIn === 'none') {
    if (!entry.signIn.some((m) => m.kind === 'none'))
      return {
        problem:
          'An API connection needs a key. An API without a sign-in needs no connection: call it from your commands.',
      };
    return { ask: GuideConnectAsk.parse({ ...base, signIn: 'none' }) };
  }
  let auth: TokenAuth;
  if (choice.signIn === 'header') {
    const name = HeaderName.safeParse(choice.keyName ?? '');
    if (!name.success)
      return { problem: 'header needs keyName, the header’s name: letters, digits and dashes.' };
    auth = { type: 'header', name: name.data, template: `${choice.keyPrefix ?? ''}{secret}` };
  } else if (choice.signIn === 'query') {
    const name = QueryName.safeParse(choice.keyName ?? '');
    if (!name.success) return { problem: 'query needs keyName, the parameter’s name, like api_key.' };
    auth = { type: 'query', name: name.data };
  } else if (choice.signIn === 'basic') auth = { type: 'basic', usernameField: CONNECT_HERE_FIELDS.username };
  else auth = { type: 'bearer' };
  const ways = entry.signIn.filter((m) => m.kind === 'token');
  const method = ways.findIndex((m) => m.kind === 'token' && m.auth.type === auth.type);
  const way = ways[method];
  if (way?.kind !== 'token')
    return {
      problem: `${entry.name} can’t sign in that way. Use ${entry.id === 'custom_mcp' ? 'bearer or header' : 'bearer, header, basic or query'}.`,
    };
  const problem = tokenAuthProblem(entry, auth);
  if (problem) return { problem };
  const own = auth.type === 'header' || auth.type === 'query';
  return {
    ask: GuideConnectAsk.parse({
      ...base,
      signIn: 'token',
      method,
      ...(own ? { auth } : {}),
      username: auth.type === 'basic' ? choice.username?.trim() || null : null,
    }),
  };
}

/** An address as the card shows it: without `https://` and a trailing slash (`mcp.linear.app/mcp`). */
export function connectHereAddress(url: string): string {
  return url.replace(/^https:\/\//i, '').replace(/\/+$/, '');
}

/** Which secret the card asks for: a token (Bearer), a key (header or query) or a password (basic). */
export function connectHereSecretKind(
  entry: CatalogEntry,
  ask: Pick<GuideConnectAsk, 'method' | 'auth'>,
): 'token' | 'key' | 'password' {
  const way = entry.signIn.filter((m) => m.kind === 'token')[ask.method];
  const type = ask.auth?.type ?? (way?.kind === 'token' ? way.auth.type : 'bearer');
  return type === 'basic' ? 'password' : type === 'bearer' ? 'token' : 'key';
}

/**
 * The card (topic `add_connection`, node `here`) for an MCP server or API set up by talking: what it connects and
 * where, how it signs in, the level in plain words, then a write-only field and Connect (or Connect alone when it
 * needs no sign-in), and Not now. Whombat writes every word; the assistant's notes go to the connection, not the card.
 */
export function connectHereCard(entry: CatalogEntry, ask: GuideConnectAsk, assistant: string): GuideCard {
  const at = connectHereAddress(ask.url);
  const where = entry.transport === 'mcp' ? CONNECT_HERE_TEXT.where.mcp(at) : CONNECT_HERE_TEXT.where.api(at);
  const kind = ask.signIn === 'none' ? null : connectHereSecretKind(entry, ask);
  const signIn =
    kind === null
      ? CONNECT_HERE_TEXT.none
      : kind === 'password'
        ? CONNECT_HERE_TEXT.basic(assistant)
        : CONNECT_HERE_TEXT[kind](assistant);
  const notNow = {
    id: CONNECT_HERE_DECLINE,
    label: CONNECT_HERE_TEXT.notNow,
    style: 'quiet' as const,
    href: null,
  };
  const fields = [
    ...(kind === 'password' && !ask.username
      ? [
          {
            id: CONNECT_HERE_FIELDS.username,
            label: CONNECT_HERE_TEXT.labels.username,
            kind: 'text' as const,
          },
        ]
      : []),
    ...(kind
      ? [{ id: CONNECT_HERE_FIELDS.secret, label: CONNECT_HERE_TEXT.labels[kind], kind: 'secret' as const }]
      : []),
  ];
  const blocks =
    fields.length > 0
      ? [
          { type: 'form', id: CONNECT_HERE_FORM, fields, submitLabel: CONNECT_HERE_TEXT.connect },
          { type: 'actions', actions: [notNow] },
        ]
      : [
          {
            type: 'actions',
            actions: [
              { id: CONNECT_HERE_FORM, label: CONNECT_HERE_TEXT.connect, style: 'primary', href: null },
              notNow,
            ],
          },
        ];
  return GuideCard.parse({
    kind: 'guide',
    guide: 'add_connection',
    node: 'here',
    title: CONNECT_HERE_TEXT.title(ask.label).slice(0, 120),
    body: [where, signIn, connectAccessWords(entry, ask.access, assistant)].join('\n\n').slice(0, 1200),
    blocks,
    state: 'open',
    connectAsk: ask,
  });
}

/**
 * The card for an MCP server that signs in with its own account (OAuth): what it is and where, and one button to the
 * connect form filled in, which opens the server's sign-in (the sign-in needs the browser).
 */
export function connectSignInCard(
  entry: CatalogEntry,
  ask: { label: string; url: string; access: ConnectionAccessLevel },
  assistant: string,
): GuideCard {
  const at = connectHereAddress(ask.url);
  return GuideCard.parse({
    kind: 'guide',
    guide: 'add_connection',
    node: 'connect',
    title: CONNECT_HERE_TEXT.signInTitle(ask.label).slice(0, 120),
    body: [
      CONNECT_HERE_TEXT.where.mcp(at),
      CONNECT_HERE_TEXT.oauth(ask.label),
      connectAccessWords(entry, ask.access, assistant),
    ]
      .join('\n\n')
      .slice(0, 1200),
    blocks: [
      {
        type: 'actions',
        actions: [
          {
            id: 'connect',
            label: CONNECT_HERE_TEXT.signIn,
            style: 'primary',
            href: connectAskHref({ catalogId: entry.id, url: ask.url, access: ask.access }),
          },
        ],
      },
    ],
    state: 'open',
  });
}

/** What the locked card says. */
export function connectHereLocked(outcome: 'connected' | 'declined', label: string): string {
  return outcome === 'connected'
    ? CONNECT_HERE_TEXT.connected(label).slice(0, 200)
    : CONNECT_HERE_TEXT.declined;
}
