/**
 * Connections on Android (Whombat docs/decisions/connections-catalog.md CX-74, read-only; the redesign in
 * connections-redesign-android.md AP-1170…): the Connections screen shows what you have — NEEDS YOU (a connection whose
 * state isn't fine, with Connect again or Open) above CONNECTED · N (compact rows, one meta line) — and Add a connection is
 * its own screen: every entry offered here by category, searched by any word, with category chips and a Connected / Set
 * up tag (catalog connections from `connections.list`, plus your own Google / Microsoft 365 accounts, which live
 * in `connectors.status`). One connection's page says its state, last check, who connected it, TOOLS with their tier.
 * Since phone-connect.md (PC-01, PC-02, AP-2902) the phone connects too: an entry opens its Connect {Name}, an account
 * its own screen (`entryOpens`), never the web page the managed app would catch itself. Pure: the screens render these,
 * and the words come from core's catalog
 * (`CONNECTION_TOOL_TIER_LABELS`, `ALWAYS_ASKS_LABEL`, …). One kind of connection: every one is yours
 * (one-person-android.md AP-5766). A connection's page says what the agent may do with it, Look only or Manage
 * (CT-314, AP-847), changed on its page since PC-09 with its name, a new key, Check again and Disconnect. Nobody looks
 * after a connection: the agent is the one that uses it (Whombat one-agent.md OA-07; app one-agent.md AP-4991). An AI
 * gateway (Fusebox or the generic one, Whombat ai-gateway.md AIG-01; AP-1123) has none of the agent's parts — no tools
 * or guide — but which tools go through it, and its switches (`ConnectionScreen`).
 */

import { type BrandMarkName, isBrandMark } from '@whombat/brand';
import { withBurrow } from '@whombat/client';
import {
  addressReasonNote,
  addressReasonOf,
  sameNameKeys,
  settingsConnectionGroups,
  settingsConnectionsText,
} from '@whombat/client/connections';
import {
  type Connection as AccountConnection,
  CATALOG,
  CATALOG_CATEGORIES,
  type CatalogCategory,
  type CatalogConnectionState,
  type CatalogEntry,
  type CatalogEntryStatus,
  type ConnectionToolTier,
  type ConnectionToolView,
  type ConnectionView,
  catalogCategoryLabels,
  catalogEntry,
  connectionAccessLabels,
  connectionHost,
  connectionToolTierLabels,
  FEEDBACK_THING_ID,
  FOUND_SERVER_ID,
  type GatewayKind,
  GITHUB_THING_ID,
  gatewayKindOf,
  isGatewayConnection,
  isVaultSyncConnection,
  type Tone,
  thingId,
} from '@whombat/core';
import type {
  ConnectionToolsResponse,
  FeedbackIntegrationHealth,
  GitHubStatusResponse,
} from '@whombat/core/contracts';
import { formatAgo } from '@whombat/core/text';
import { mobileTranslator } from '../i18n/translate';
import { type AccountPage, isAccountPage } from '../navigation/connectionLinks';

/* Words ------------------------------------------------------------------------------------------ */

export function connectionsText(locale?: string) {
  const { t, tp } = mobileTranslator(locale);
  const settings = settingsConnectionsText(locale);
  return {
    kicker: t('connections.connectionsText.kicker'),
    title: t('connections.connectionsText.title'),
    /** The same line as the web's Settings → Connections (sidebar-tabs.md). */
    intro: settings.intro,
    /** The button under the intro, and the Add a connection screen's title (AP-1170). */
    add: t('connections.connectionsText.add'),
    needsYou: settings.needsYou,
    accounts: settings.accounts,
    apps: settings.apps,
    connected: t('connections.connectionsText.connected'),
    nothingConnected: t('connections.connectionsText.nothingConnected'),
    /** A NEEDS YOU row's action word (AP-1171). */
    connectAgain: t('connections.connectionsText.connectAgain'),
    openRow: t('connections.connectionsText.openRow'),
    notSetUp: t('connections.connectionsText.notSetUp'),
    tools: t('connections.connectionsText.tools'),
    noTools: t('connections.connectionsText.noTools'),
    /** The guide's label: “FOR NEO”. */
    guide: (assistant: string) => t('data.connections.guide', { name: assistant.toUpperCase() }),
    connection: t('connections.connectionsText.connection'),
    notChecked: t('connections.connectionsText.notChecked'),
    loadFailed: t('connections.connectionsText.loadFailed'),
    loading: t('connections.connectionsText.loading'),
    detailFailed: t('connections.connectionsText.detailFailed'),
    notFound: t('connections.connectionsText.notFound'),
    loadingDetail: t('connections.connectionsText.loadingDetail'),
    truncated: t('connections.connectionsText.truncated'),
    /** GitHub's row: how many of its repositories Whombat works in (the web's overview). */
    reposOn: (n: number) => tp('data.connections.reposOn', n),
    /** Website feedback's row: its one site's name, else how many. */
    sites: (n: number) => tp('data.connections.sites', n),
    reports: (n: number) => (n === 0 ? t('data.connections.noReports') : tp('data.connections.reports', n)),
    /** Website feedback's state when it's fine: it takes reports. */
    on: t('connections.connectionsText.on'),
  } as const;
}
export const CONNECTIONS_TEXT = connectionsText();

/* Where things open on the web ------------------------------------------------------------------- */

/**
 * The web page of an entry (`?tab=connections&connection=<catalogId>`, CX-71) or of one connection (`&id=…`, CX-72),
 * in this burrow.
 */
export function connectionsWebPath(slug: string, catalogId: string, connectionId?: string | null): string {
  const id = connectionId ? `&id=${encodeURIComponent(connectionId)}` : '';
  return withBurrow(`/settings?tab=connections&connection=${encodeURIComponent(catalogId)}${id}`, slug);
}

/**
 * Where an entry opens on the phone (phone-connect.md PC-01, PC-02, AP-2902): a connectable entry its Connect {Name},
 * Google, Microsoft 365, Email (IMAP), GitHub and Website feedback their own screen; null for one the phone has no
 * screen for. Never a web page: on a managed Whombat the app caught it and opened Settings → Connections again.
 */
export type ConnectionOpens =
  | { screen: 'Connect'; catalogId: string }
  | { screen: 'ConnectAccount'; page: AccountPage }
  /** Add a server: Find My without a Mac (`needs_mac`, findmy-connection.md §1.2). */
  | { screen: 'AddServer' };

/** What a Connections row opens: an entry's screen, or an account's page (`connection:con_…`, `connection:github`). */
export type RowOpens = ConnectionOpens | { screen: 'Thing'; thingId: string };

export function entryOpens(catalogId: string): ConnectionOpens | null {
  if (isAccountPage(catalogId)) return { screen: 'ConnectAccount', page: catalogId };
  const entry = catalogEntry(catalogId);
  return entry && entry.transport !== 'builtin' ? { screen: 'Connect', catalogId } : null;
}

/* Logos ------------------------------------------------------------------------------------------ */

/** How a logo tile is drawn: the provider's mark, one of our icons, or the name's first letter. */
export type ConnectionLogoKind =
  | { kind: 'mark'; mark: BrandMarkName }
  | { kind: 'icon'; icon: 'plug' | 'message' | 'server' }
  | { kind: 'monogram'; letter: string };

const LOGO_ICONS: Partial<Record<string, 'plug' | 'message' | 'server'>> = {
  feedback: 'message',
  // A computer found on the network (connect-in-chat.md): no brand, a server.
  [FOUND_SERVER_ID]: 'server',
};

/** The logo of a catalog entry: its brand mark (every catalog entry has one, AP-2202), else an icon for Website feedback, else a monogram. */
export function connectionLogo(catalogId: string, name?: string | null): ConnectionLogoKind {
  if (isBrandMark(catalogId)) return { kind: 'mark', mark: catalogId };
  const icon = LOGO_ICONS[catalogId];
  if (icon) return { kind: 'icon', icon };
  const word = name ?? catalogEntry(catalogId)?.name ?? catalogId;
  return { kind: 'monogram', letter: (word.trim()[0] ?? '?').toUpperCase() };
}

/* State ------------------------------------------------------------------------------------------ */

export interface ConnectionState {
  tone: Tone;
  /** The status line's words, and what TalkBack says for the dot. */
  label: string;
}

export function connectionStates(locale?: string): Record<CatalogConnectionState, ConnectionState> {
  const { t } = mobileTranslator(locale);
  return {
    active: { tone: 'ok', label: t('data.connections.state.active') },
    needs_reauth: { tone: 'warn', label: t('data.connections.state.needsReauth') },
    error: { tone: 'bad', label: t('data.connections.state.error') },
  };
}

export const CONNECTION_STATES: Record<CatalogConnectionState, ConnectionState> = connectionStates();

/* CONNECTED -------------------------------------------------------------------------------------- */

export interface ConnectedRow {
  key: string;
  /** `catalog`: opens the connection's page; `account` (Google, Microsoft 365, Email, GitHub, Website feedback): `opens`. */
  kind: 'catalog' | 'account';
  /** The connection's id (catalog) or the account connection's id. */
  id: string;
  catalogId: string;
  title: string;
  /** The host or the account (“home.lan:8123”, “mara@example.com”); null when there is none. */
  meta: string | null;
  state: ConnectionState;
  logo: ConnectionLogoKind;
  /** The page on the web (kept for a self-hosted Whombat's sign-ins elsewhere). */
  webPath: string;
  /**
   * An account row's page on a box that has them (session minor 7), else its own screen (Google, Microsoft 365, Email
   * (IMAP), GitHub, Website feedback); for a catalog connection its page when the sync lives there (1Password,
   * whose page opens on its own tab), else null (its Connection screen).
   */
  opens: RowOpens | null;
  /**
   * The compact row's one meta line (AP-1172, AP-1177): where it is (the host and port, else the account) and “Look
   * only” when the agent may only look; null when there's neither. A gateway's line is on its
   * screen, not on the row.
   */
  line: string | null;
  accessibilityLabel: string;
}

function rowLabel(title: string, meta: string | null, state: ConnectionState): string {
  return [`${title}, ${state.label}`, meta].filter(Boolean).join('. ');
}

/** Parts of a line joined with “ · ”, the empty ones left out; null when nothing is left. */
function joinLine(parts: readonly (string | null | undefined)[]): string | null {
  return parts.filter(Boolean).join(' · ') || null;
}

/** Where a connection is (AP-1177): the host and port from the entry's fields, else the server's detail (the account). */
function connectionMeta(c: ConnectionView, entry: CatalogEntry | null): string | null {
  let host: string | null = null;
  try {
    host = entry ? connectionHost(entry, c.fields) : null;
  } catch {
    host = null;
  }
  return host ?? c.detail ?? null;
}

/** A label without the address it ends with (“Home Assistant · home.lan:8123” → “Home Assistant”), else the label. */
export function labelName(label: string, address: string | null): string {
  const suffix = address ? ` · ${address}` : null;
  return suffix && label.endsWith(suffix) && label.length > suffix.length
    ? label.slice(0, -suffix.length)
    : label;
}

export function connectedRow(c: ConnectionView, slug: string, locale?: string): ConnectedRow {
  const entry = catalogEntry(c.catalogId);
  const meta = connectionMeta(c, entry);
  const state = connectionStates(locale)[c.status];
  const title = labelName(c.label, meta);
  const lookOnly = c.status === 'active' && c.access === 'read' ? connectionAccessLabels(locale).read : null;
  return {
    key: `catalog:${c.id}`,
    kind: 'catalog',
    id: c.id,
    catalogId: c.catalogId,
    title,
    meta,
    state,
    logo: connectionLogo(c.catalogId, entry?.name ?? c.label),
    webPath: connectionsWebPath(slug, c.catalogId, c.id),
    // The Vault's sync is on its page's own tab, not on the Connection screen (Whombat onepassword-sync.md).
    opens: isVaultSyncConnection(c.catalogId)
      ? { screen: 'Thing', thingId: thingId('connection', c.id) }
      : null,
    line: joinLine([meta, lookOnly]),
    accessibilityLabel: rowLabel(title, joinLine([meta, lookOnly]), state),
  };
}

/**
 * Where an account's row goes: its page (`connection:<its id>`) when the box answers account pages (`pages`, session
 * minor 7), else its own screen as before.
 */
function accountOpens(page: AccountPage, thing: string, pages: boolean): RowOpens {
  return pages ? { screen: 'Thing', thingId: thing } : { screen: 'ConnectAccount', page };
}

/** Your Google / Microsoft 365 / Email account (CN-04), shown as a connection; it opens its page or its own screen. */
export function accountRow(a: AccountConnection, slug: string, pages = false, locale?: string): ConnectedRow {
  const title = catalogEntry(a.provider)?.name ?? a.provider;
  const state = connectionStates(locale)[a.status];
  return {
    key: `account:${a.id}`,
    kind: 'account',
    id: a.id,
    catalogId: a.provider,
    title,
    meta: a.email,
    state,
    logo: connectionLogo(a.provider, title),
    webPath: connectionsWebPath(slug, a.provider),
    opens: isAccountPage(a.provider)
      ? accountOpens(a.provider, thingId('connection', a.id), pages)
      : entryOpens(a.provider),
    line: joinLine([a.email]),
    accessibilityLabel: rowLabel(title, a.email, state),
  };
}

/**
 * GitHub, when this Whombat is connected to it (the web's overview): the account it acts as and how many repositories
 * are on; Needs attention when GitHub can't be reached. Null while it isn't connected or didn't answer.
 */
export function githubRow(
  status: Pick<GitHubStatusResponse, 'connected' | 'login' | 'error'> | null | undefined,
  repos: { connected: boolean; on: number } | null | undefined,
  slug: string,
  pages = false,
  locale?: string,
): ConnectedRow | null {
  const connected = status?.connected ?? repos?.connected ?? false;
  if (!connected) return null;
  const title = catalogEntry('github')?.name ?? 'GitHub';
  const login = status?.login ? `@${status.login}` : null;
  const states = connectionStates(locale);
  const state = status?.error ? states.error : states.active;
  const line = joinLine([login, repos ? connectionsText(locale).reposOn(repos.on) : null]);
  return {
    key: 'account:github',
    kind: 'account',
    id: 'github',
    catalogId: 'github',
    title,
    meta: login,
    state,
    logo: connectionLogo('github', title),
    webPath: connectionsWebPath(slug, 'github'),
    opens: accountOpens('github', GITHUB_THING_ID, pages),
    line,
    accessibilityLabel: rowLabel(title, line, state),
  };
}

/**
 * Website feedback, once it has a site (the web's overview): the site's name or how many, and the reports of the last
 * 24 hours; Needs attention while a site has a warning. Null without a site.
 */
export function feedbackRow(
  integrations:
    | readonly {
        integration: { name: string };
        health: Pick<FeedbackIntegrationHealth, 'reportsLast24h' | 'warnings'>;
      }[]
    | null
    | undefined,
  slug: string,
  pages = false,
  locale?: string,
): ConnectedRow | null {
  const list = integrations ?? [];
  if (!list.length) return null;
  const text = connectionsText(locale);
  const title = catalogEntry('feedback')?.name ?? mobileTranslator(locale).t('data.connections.feedback');
  const detail = list.length === 1 ? (list[0]?.integration.name ?? null) : text.sites(list.length);
  const reports = list.reduce((n, { health }) => n + health.reportsLast24h, 0);
  const state = list.some(({ health }) => health.warnings.length > 0)
    ? connectionStates(locale).error
    : { tone: 'ok' as const, label: text.on };
  const line = joinLine([detail, text.reports(reports)]);
  return {
    key: 'account:feedback',
    kind: 'account',
    id: 'feedback',
    catalogId: 'feedback',
    title,
    meta: detail,
    state,
    logo: connectionLogo('feedback', title),
    webPath: connectionsWebPath(slug, 'feedback'),
    opens: accountOpens('feedback', FEEDBACK_THING_ID, pages),
    line,
    accessibilityLabel: rowLabel(title, line, state),
  };
}

/** What `connectedRows` adds to the catalog connections and the person's own accounts. */
export interface ConnectedExtras {
  /** The box answers account pages (session minor 7): an account's row opens its page. */
  pages?: boolean;
  /** GitHub's and Website feedback's rows, when they are connected (`githubRow`, `feedbackRow`). */
  builtins?: readonly (ConnectedRow | null)[];
  locale?: string;
}

/**
 * CONNECTED: your accounts first (the Accounts category comes first), GitHub and Website feedback after them, then the
 * server's order (by label).
 */
export function connectedRows(
  connections: readonly ConnectionView[],
  accounts: readonly AccountConnection[],
  slug: string,
  extras: ConnectedExtras = {},
): ConnectedRow[] {
  const builtins = (extras.builtins ?? []).filter((r): r is ConnectedRow => r !== null);
  return [
    ...accounts.map((a) => accountRow(a, slug, extras.pages ?? false, extras.locale)),
    ...builtins,
    ...connections.map((c) => connectedRow(c, slug, extras.locale)),
  ];
}

/* The Connections screen: NEEDS YOU, then CONNECTED · N (AP-1171, AP-1172) ------------------------------------ */

/** A NEEDS YOU row: a connection whose state isn't fine, with the word for what pressing it does. */
export interface NeedsYouRow extends ConnectedRow {
  /** “Connect again” when it needs connecting again, else “Open”. */
  action: string;
  /** The reason line after the state: the detail (host or account), or null. */
  reason: string | null;
}

export interface ConnectionsOverview {
  needsYou: NeedsYouRow[];
  /** Your accounts that are fine (Google, Microsoft 365, Email). */
  accounts: ConnectedRow[];
  /** Every other connection that is fine. */
  apps: ConnectedRow[];
  /** “ACCOUNTS · 2”. */
  accountsTitle: string;
  /** “APPS AND SERVICES · 13”. */
  appsTitle: string;
  /** Nothing is connected at all: the “Nothing connected yet.” card under CONNECTED. */
  empty: boolean;
}

/**
 * What this Whombat is signed in to, problems first (AP-1171; sidebar-tabs.md): every row whose state isn't Connected
 * goes to NEEDS YOU, the rest to ACCOUNTS or APPS AND SERVICES, in the server's order. A row needing connecting again
 * says Sign in again; two rows that show the same name and place say so.
 */
export function connectionsOverview(all: readonly ConnectedRow[], locale?: string): ConnectionsOverview {
  const text = connectionsText(locale);
  const sameName = settingsConnectionsText(locale).sameName;
  const same = sameNameKeys(all.map((r) => ({ key: r.key, name: r.title, address: r.meta })));
  const rows = all.map((r) => (same.has(r.key) ? { ...r, line: joinLine([r.line, sameName]) } : r));
  const groups = settingsConnectionGroups(
    rows.map((r) => ({ ...r, page: r.catalogId, ok: r.state.tone === 'ok' })),
  );
  const needsYou: NeedsYouRow[] = groups.needsYou.map((row) => ({
    ...row,
    // Only a connection that needs signing in again has the warn tone; the others that need you are bad.
    action: row.state.tone === 'warn' ? text.connectAgain : text.openRow,
    reason: joinLine([row.meta, same.has(row.key) ? sameName : null]),
  }));
  return {
    needsYou,
    accounts: groups.accounts,
    apps: groups.apps,
    accountsTitle: `${text.accounts} · ${groups.accounts.length}`,
    appsTitle: `${text.apps} · ${groups.apps.length}`,
    empty: all.length === 0,
  };
}

/** Settings' Connections row (sidebar-tabs.md): what needs the viewer first, else how many are connected. */
export function connectionsLine(
  rows: readonly ConnectedRow[],
  locale?: string,
): {
  value: string;
  tone: 'warn' | 'bad' | null;
} {
  const { t } = mobileTranslator(locale);
  const off = rows.filter((r) => r.state.tone !== 'ok');
  const first = off[0];
  if (first) {
    const tone = off.some((r) => r.state.tone === 'bad') ? 'bad' : 'warn';
    return {
      value:
        off.length === 1
          ? t('data.connections.oneNeedsYou', { name: first.title })
          : t('data.connections.manyNeedYou', { count: off.length }),
      tone,
    };
  }
  if (rows.length === 0) return { value: connectionsText(locale).nothingConnected, tone: null };
  return { value: t('data.connections.connectedCount', { count: rows.length }), tone: null };
}

/* Add a connection (AP-1173…AP-1176) ------------------------------------------------------------------------------- */

export function addConnectionText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    title: connectionsText(locale).add,
    all: t('connections.addConnectionText.all'),
    connected: t('connections.addConnectionText.connected'),
    setUp: t('connections.addConnectionText.setUp'),
    footer: t('connections.addConnectionText.footer'),
    connect: t('connections.addConnectionText.connect'),
    mcp: t('connections.addConnectionText.mcp'),
    or: t('connections.addConnectionText.or'),
    api: t('connections.addConnectionText.api'),
    loading: t('connections.addConnectionText.loading'),
  } as const;
}
export const ADD_CONNECTION_TEXT = addConnectionText();

/** “Search 31 services”: the field's placeholder and label, with how many entries are offered here. */
export function addSearchPlaceholder(count: number, locale?: string): string {
  return mobileTranslator(locale).tp('data.connections.search', count);
}

/** “No connection matches “mail”.” */
export function addNoMatch(query: string, locale?: string): string {
  return mobileTranslator(locale).t('data.connections.noMatch', { query: query.trim() });
}

export interface AvailableRow {
  id: string;
  category: CatalogCategory;
  title: string;
  description: string;
  /** “Not set up on this Whombat yet” (its app is registered first, CX-14); null otherwise. */
  note: string | null;
  /** “Connected” (ok) when you have a connection of it, else “Set up” when it must be set up first, else null. */
  tag: { text: string; tone: Tone } | null;
  logo: ConnectionLogoKind;
  webPath: string;
  /** Its Connect {Name} or its own screen (AP-2902); null when the phone has none. */
  opens: ConnectionOpens | null;
  /** Name, tag, description and note. */
  accessibilityLabel: string;
}

export interface AvailableGroup {
  category: CatalogCategory;
  /** “PRODUCTIVITY”. */
  title: string;
  rows: AvailableRow[];
}

/**
 * Builtin entries Whombat makes itself, never added by a person (contracts 0.80, CT-340, CT-342): the Servers connection
 * (provisioned when the hosts service runs) and device connections (made by a device skill's Switch on).
 */
const PROVISIONED_CATALOG_IDS: ReadonlySet<string> = new Set(['whombat_servers', 'device']);

/** Email (IMAP)'s entry (contracts 0.97, CM-19): offered only where the Whombat says people can connect a mailbox. */
export const IMAP_CATALOG_ID = 'imap';

export interface AddConnectionOptions {
  /** The runtime has `ai.gateway` (AP-1123): Fusebox and the AI gateway are offered. */
  gateway?: boolean;
  /**
   * `connectors.status`'s `imap.available` (connections-more-android.md AP-2816): true where people can connect a
   * mailbox over IMAP; false or absent (an older Whombat, or the status didn't answer) leaves Email (IMAP) out.
   */
  imap?: boolean;
  locale?: string;
}

/**
 * Every entry offered here, in the catalog's order (AP-1173): one this Whombat turned off (`reason: 'off'`) is left out,
 * and so is a report tracker without a driver installed here (`no_driver`: nothing could read it), and one its statuses
 * don't list — an entry newer than the Whombat (AP-2816; until the statuses answer, or when
 * they fail, the catalog as it is); one whose app isn't registered yet stays, with a note and the Set up tag (the web
 * says how to set it up). An entry you already have a connection of — a CONNECTED row with its id, their Google,
 * Microsoft 365 or Email (IMAP) account included — stays too, tagged Connected (a second account, or a second server,
 * is connected the same way). Fusebox and the AI gateway only where the runtime has `ai.gateway` (`gateway`, AP-1123);
 * Email (IMAP) only where `connectors.status` says it is available (`imap`). The Custom entries are in the list too,
 * for the count and search; `addConnectionGroups` lists them only when searching, the footer offers them otherwise.
 */
export function addConnectionRows(
  statuses: readonly CatalogEntryStatus[] | null | undefined,
  connected: readonly string[],
  slug: string,
  options: AddConnectionOptions = {},
): AvailableRow[] {
  const byId = new Map((statuses ?? []).map((s) => [s.catalogId, s]));
  const has = new Set(connected);
  const locale = options.locale;
  const text = addConnectionText(locale);
  return CATALOG.flatMap((entry): AvailableRow[] => {
    if (PROVISIONED_CATALOG_IDS.has(entry.id)) return [];
    if (isGatewayConnection(entry) && !options.gateway) return [];
    if (entry.id === IMAP_CATALOG_ID && !options.imap && !has.has(entry.id)) return [];
    const status = byId.get(entry.id);
    // The Whombat lists every entry it has (AP-2816): one it doesn't list is newer than it (a newer phone on an older box).
    if (statuses && !status) return [];
    if (status && !status.available && (status.reason === 'off' || status.reason === 'no_driver')) return [];
    const address = addressReasonOf(status);
    const note = address
      ? addressReasonNote(address, locale)
      : status && !status.available
        ? connectionsText(locale).notSetUp
        : null;
    const tag = has.has(entry.id)
      ? { text: text.connected, tone: 'ok' as const }
      : note && !address
        ? { text: text.setUp, tone: 'neutral' as const }
        : null;
    return [
      {
        id: entry.id,
        category: entry.category,
        title: entry.name,
        description: entry.description,
        note,
        tag,
        logo: connectionLogo(entry.id, entry.name),
        webPath: connectionsWebPath(slug, entry.id),
        // Find My without a Mac opens Add a server; you add the Mac there first.
        opens: address === 'needs_mac' && !has.has(entry.id) ? { screen: 'AddServer' } : entryOpens(entry.id),
        // The description's own full stop goes: the parts are joined with “. ”.
        accessibilityLabel: [
          tag ? `${entry.name}, ${tag.text}` : entry.name,
          entry.description.replace(/\.$/, ''),
          note,
        ]
          .filter(Boolean)
          .join('. '),
      },
    ];
  });
}

/**
 * Whether a row matches what was typed (AP-1174): every word, in any order, somewhere in its name, description or
 * category (the web's `matchesSearch`); nothing typed matches everything.
 */
export function matchesConnectionSearch(
  row: Pick<AvailableRow, 'title' | 'description' | 'category'>,
  query: string,
  locale?: string,
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${row.title} ${row.description} ${catalogCategoryLabels(locale)[row.category]}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

export type AddCategory = CatalogCategory | 'all';

export interface AddChip {
  value: AddCategory;
  label: string;
}

/** The chips (AP-1174): All, then each category with an entry here in the catalog's order, Custom left out (the footer). */
export function addConnectionChips(rows: readonly AvailableRow[], locale?: string): AddChip[] {
  const labels = catalogCategoryLabels(locale);
  return [
    { value: 'all', label: addConnectionText(locale).all },
    ...CATALOG_CATEGORIES.filter((c) => c !== 'custom' && rows.some((r) => r.category === c)).map((c) => ({
      value: c,
      label: labels[c],
    })),
  ];
}

/**
 * The list (AP-1174): the rows grouped by category in the catalog's order, only the chosen chip's, those matching the
 * search, empty groups left out. The Custom group only while searching under All: otherwise the footer offers it.
 */
export function addConnectionGroups(
  rows: readonly AvailableRow[],
  category: AddCategory,
  query: string,
  locale?: string,
): AvailableGroup[] {
  const labels = catalogCategoryLabels(locale);
  const searching = query.trim() !== '';
  const shown = rows.filter(
    (r) =>
      (category === 'all' ? r.category !== 'custom' || searching : r.category === category) &&
      matchesConnectionSearch(r, query, locale),
  );
  return CATALOG_CATEGORIES.flatMap((c) => {
    const list = shown.filter((r) => r.category === c);
    return list.length ? [{ category: c, title: labels[c].toUpperCase(), rows: list }] : [];
  });
}

/** The footer's links (AP-1175): Custom MCP and Custom API, each only when offered here. */
export function addConnectionFooter(rows: readonly AvailableRow[]): {
  mcp: AvailableRow | null;
  api: AvailableRow | null;
} {
  return {
    mcp: rows.find((r) => r.id === 'custom_mcp') ?? null,
    api: rows.find((r) => r.id === 'custom_api') ?? null,
  };
}

/* One connection --------------------------------------------------------------------------------- */

export interface ConnectionToolRow {
  name: string;
  description: string | null;
  /** `read` / `write`: the row's mono meta. */
  access: string;
  tier: ConnectionToolTier;
  /** Allowed / Asks / Off. */
  tierLabel: string;
  tierTone: Tone;
  /** “Always asks”: a sensitive tool (CX-31); null otherwise. */
  alwaysAsks: string | null;
  /** “New”: new or changed since the last check (CX-18); null otherwise. */
  isNew: string | null;
  accessibilityLabel: string;
}

const TIER_TONES: Record<ConnectionToolTier, Tone> = { can: 'ok', ask: 'warn', off: 'neutral' };

/** A tool as the connection page lists it (CX-72): a sensitive one that would be Allowed shows Asks. */
export function connectionToolRow(t: ConnectionToolView, locale?: string): ConnectionToolRow {
  const tr = mobileTranslator(locale);
  const tier: ConnectionToolTier = t.sensitive && t.tier === 'can' ? 'ask' : t.tier;
  const tierLabel = connectionToolTierLabels(locale)[tier];
  const alwaysAsks = t.sensitive ? tr.t('data.connections.alwaysAsks') : null;
  const isNew = t.isNew ? tr.t('data.connections.newTool') : null;
  const description = t.description.trim() || null;
  return {
    name: t.name,
    description,
    access: t.access,
    tier,
    tierLabel,
    tierTone: TIER_TONES[tier],
    alwaysAsks,
    isNew,
    accessibilityLabel: [`${t.name}, ${tierLabel}`, alwaysAsks, isNew, t.access, description]
      .filter(Boolean)
      .join('. '),
  };
}

export interface ConnectionCheckLine {
  id: string;
  tone: Tone;
  message: string;
}

export interface ConnectionDetail {
  id: string;
  catalogId: string;
  title: string;
  /** The catalog entry's name (“Home Assistant”). */
  meta: string;
  /** The host or the account. */
  detail: string | null;
  /** What the agent may do with it: “Look only” or “Manage” (CT-314; an older runtime's connections manage). */
  access: string;
  state: ConnectionState;
  /** “Checked 12 min ago” / “Not checked yet”. */
  checked: string;
  /** “Connected by Mara”. */
  connectedBy: string;
  /**
   * An AI gateway (AIG-01, AP-1123): its kind, for the switches and Fusebox's confirmation; null for every other
   * connection. It has no tools or guide.
   */
  gateway: { kind: GatewayKind } | null;
  /**
   * The Vault kept in step with a vault elsewhere (1Password; Whombat onepassword-sync.md): the agent never uses it, so
   * it has no level, tools or guide; the screen shows the sync instead.
   */
  vaultSync: boolean;
  /** The last check's lines that aren't fine, with what they said. */
  checks: ConnectionCheckLine[];
  tools: ConnectionToolRow[];
  /** What the agent is told about the service; null when there's nothing. */
  guide: string | null;
  truncated: string | null;
  logo: ConnectionLogoKind;
  webPath: string;
  stateLabel: string;
}

const CHECK_TONES = { ok: 'ok', warning: 'warn', error: 'bad' } as const;

export function connectionDetail(
  response: ConnectionToolsResponse,
  now: Date,
  timeZone: string,
  slug: string,
  locale?: string,
): ConnectionDetail {
  const { t } = mobileTranslator(locale);
  const text = connectionsText(locale);
  const c = response.connection;
  const row = connectedRow(c, slug, locale);
  const entry = catalogEntry(c.catalogId);
  const kind = gatewayKindOf(c.catalogId);
  const gateway = kind ? { kind } : null;
  const vaultSync = isVaultSyncConnection(c.catalogId);
  // Neither the gateway nor the Vault's sync is the agent's: no tools, nothing it is told.
  const agents = !gateway && !vaultSync;
  const checked = c.checkedAt
    ? t('data.connections.checked', { ago: formatAgo(c.checkedAt, now, timeZone, locale) })
    : text.notChecked;
  return {
    id: c.id,
    catalogId: c.catalogId,
    title: c.label,
    meta: entry?.name ?? '',
    detail: row.meta,
    access: connectionAccessLabels(locale)[c.access ?? 'manage'],
    state: row.state,
    checked,
    connectedBy: t('data.connections.connectedBy', { name: c.connectedBy.name }),
    gateway,
    vaultSync,
    checks: c.checks.flatMap((k) =>
      k.state !== 'ok' && k.message ? [{ id: k.id, tone: CHECK_TONES[k.state], message: k.message }] : [],
    ),
    tools: agents ? response.tools.map((tool) => connectionToolRow(tool, locale)) : [],
    guide: agents ? response.guide.trim() || null : null,
    truncated: response.truncated && agents ? text.truncated : null,
    logo: row.logo,
    webPath: row.webPath,
    stateLabel: [`${row.state.label}`, checked].join(' · '),
  };
}
