/**
 * Settings → Connections (AP-673, docs/decisions/settings-simplify.md SS-05; connections-redesign.md AP-1157…AP-1166;
 * sidebar-tabs.md; not in the mocks, B-05) in two places. The overview is what this Whombat is signed in to, and how:
 * NEEDS YOU first (a connection that needs connecting again or attention, with the fix on its row), then ACCOUNTS and
 * APPS AND SERVICES in one-line rows (logo, name, its line, a dot; one kind of connection, AP-5711; two that nothing
 * tells apart say so), then a strip of what was found on your network. Add a connection (`&connection=add`) is the
 * catalog: a search box, category chips, On your network, small tiles you press as a whole, and “Not in the list?” for
 * the Custom ones; `&found=1` (the assistant's link after the first scan, Whombat desk-found.md DF-05) opens it at On
 * your network (AP-3801). A row or a tile opens its own page (`&connection=github|google|feedback|homeassistant…`), where
 * connecting, the checks and an app's setup are. With nothing connected the overview shows the catalog itself.
 * Built from Settings' bordered-row cards and the Automations list's link rows.
 */
import { createLink, Link } from '@tanstack/react-router';
import { isBrandMark, WORDMARKS } from '@whombat/brand';
import { BrandMark } from '@whombat/brand/react';
import {
  type ConnectionWords,
  SETTINGS_CONNECTIONS_TEXT,
  sameNameKeys,
  settingsConnectionGroups,
} from '@whombat/client/connections';
import { thingHref } from '@whombat/core';
import {
  CATALOG_CATEGORY_LABELS,
  type CatalogCategory,
  CONNECTION_ACCESS_LABELS,
  type ConnectorProvider,
  type ConnectorsStatus,
  catalogEntry,
  FOUND_SERVER_ID,
} from '@whombat/core/domain';
import { ChevronRight, MessageSquareText, Plus, Search, Server } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import type { ConnectionPage } from '../../app/routing/search';
import { ButtonLink } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import { Tag } from '../../components/Tag';
import { AppLink } from '../files/AppLink';
import { GitHubMark } from '../settings/GitHubMark';
import settings from '../settings/SettingsScreen.module.css';
import { type ThingLinkProps, useThingLinkProps } from '../things/prefetch';
import c from './Connectors.module.css';
import { type CatalogRow, connectionSearch, groupByCategory, matchesSearch, type StateTone } from './catalog';
import { FoundOnNetwork, FoundStrip, foundCount, useFoundScan } from './FoundOnNetwork';
import { ADD_CONNECTION_LINK, useConnectionsBack } from './home';
import { PROVIDERS } from './providers';
import { googleConnectable } from './useConnectGoogle';
import { useConnectionWords } from './useConnectionWords';

const RouterButtonLink = createLink(ButtonLink);

/** The search that opens a connection's page (a builtin's, or a catalog entry's connect page). */
export function providerSearch(page: string) {
  return { tab: 'connections' as const, connection: page };
}

/** GitHub and Website feedback: burrow connections, beside the connector providers (SS-05). */
export const CONNECTION_PAGES: Record<'github' | 'feedback', { name: string; description: string }> = {
  github: { name: 'GitHub', description: 'Repositories, branches and pull requests for your agent.' },
  feedback: {
    name: 'Website feedback',
    description: 'A feedback button on your website; reports come to Feedback.',
  },
};

function isBurrowPage(page: ConnectionPage): page is keyof typeof CONNECTION_PAGES {
  return page === 'github' || page === 'feedback';
}

/** A connection's name: “GitHub”, “Google”, “Website feedback”. */
export function connectionName(page: ConnectionPage): string {
  return isBurrowPage(page) ? CONNECTION_PAGES[page].name : PROVIDERS[page].name;
}

/** What a connection brings, in a line: the tiles and the page header. */
export function connectionDescription(page: ConnectionPage): string {
  return isBurrowPage(page) ? CONNECTION_PAGES[page].description : PROVIDERS[page].description;
}

/** A builtin's line in the agent's words: GitHub's and Website feedback's name the agent (AP-1834, AP-4944). */
export function builtinDescription(page: ConnectionPage, words: ConnectionWords): string {
  if (page === 'github') return words.github;
  if (page === 'feedback' && words.feedback) return words.feedback;
  return connectionDescription(page);
}

/** The mark inside a logo's square, by the square's size; a wordmark across it (Synology's, QNAP's; AP-3800). */
const GLYPH = { 20: 12, 32: 18, 40: 22, 48: 26 } as const;
const WORDMARK_GLYPH = { 20: 16, 32: 26, 40: 32, 48: 38 } as const;

/**
 * A connection's logo: a 32px square on the overview's rows and the catalog's tiles (AP-1160, AP-1163), 40px on the
 * NEEDS YOU rows and the found rows, 20px on the found strip's chips, 48px in a page header. Builtins draw
 * their own marks; catalog entries the providers' marks from `@whombat/brand` (Simple Icons, CX-01, AP-760; every entry
 * has one since marks.md AP-2202), a monogram only for an id the brand package doesn't know yet.
 */
export function ProviderLogo({ provider, size = 40 }: { provider: string; size?: 20 | 32 | 40 | 48 }) {
  const glyph = (WORDMARKS.has(provider) ? WORDMARK_GLYPH : GLYPH)[size];
  // A mark that is a whole tile with its own corners (Mollie's) fills the box instead of sitting on it.
  if (TILE_MARKS.has(provider) && isBrandMark(provider))
    return (
      <span className={c.logo} data-size={size} data-tile="" aria-hidden="true">
        <BrandMark mark={provider} size={size} />
      </span>
    );
  return (
    <span className={c.logo} data-size={size} aria-hidden="true">
      {provider === 'github' ? (
        <GitHubMark size={glyph} />
      ) : provider === 'feedback' ? (
        <Icon icon={MessageSquareText} size={glyph} />
      ) : provider === FOUND_SERVER_ID ? (
        // A computer found on the network (connect-in-chat.md): no brand, a server.
        <Icon icon={Server} size={glyph} />
      ) : provider === 'google' || provider === 'microsoft' || provider === 'imap' ? (
        <ConnectorLogo provider={provider} size={glyph} />
      ) : (
        <CatalogMark catalogId={provider} size={glyph} />
      )}
    </span>
  );
}

/** Catalog marks drawn as a whole tile, rounded corners included (`@whombat/brand`'s Mollie mark). */
const TILE_MARKS: ReadonlySet<string> = new Set(['mollie']);

function CatalogMark({ catalogId, size }: { catalogId: string; size: number }) {
  if (isBrandMark(catalogId)) return <BrandMark mark={catalogId} size={size} />;
  const name = catalogEntry(catalogId)?.name ?? catalogId;
  return (
    <span className={c.monogram} data-size={size}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function ConnectorLogo({ provider, size }: { provider: ConnectorProvider; size: number }) {
  const { Logo } = PROVIDERS[provider];
  return <Logo size={size} />;
}

/** What a provider not connected yet says on its tile, and what its button does there. */
export function availableState(
  provider: ConnectorProvider,
  status: ConnectorsStatus,
): { note: string | null; action: string } {
  if (status.mode === 'off' && provider === 'google')
    return { note: 'Connecting accounts is turned off on this Whombat.', action: 'View' };
  // Google's app decides whether you can connect (CN-02); you set it up (CT-1553).
  if (provider === 'google' && !googleConnectable(status))
    return { note: 'Set it up once, then you can connect.', action: 'Set up' };
  if (provider === 'microsoft' && !status.microsoft?.app.configured)
    return { note: 'Set up a Microsoft Entra application to connect.', action: 'Set up' };
  return { note: null, action: 'Connect' };
}

/** One entry of the overview: a CONNECTED row, or a tile under ADD A CONNECTION. */
export interface ConnectionEntry {
  page: ConnectionPage;
  /**
   * Connected: the row's detail after the name (an account or a login in mono, `plain` for a name), its meta line and
   * its state.
   */
  connected: { detail: string | null; plain?: boolean; meta: string; ok: boolean; state: string } | null;
  /** Not connected: the tile's button and the line under it. */
  tile: { action: string; note: string | null };
}

/** A catalog entry's tile under ADD A CONNECTION (CX-70): what it is, its group, and its button. */
export interface CatalogTile {
  catalogId: string;
  name: string;
  description: string;
  category: CatalogCategory;
  action: string;
  note: string | null;
}

/**
 * The catalog's part of the overview (CX-70, AP-755): its connections as CONNECTED rows and its entries as tiles,
 * grouped by category with a search box.
 */
export interface CatalogOverview {
  rows: readonly CatalogRow[];
  tiles: readonly CatalogTile[];
}

/** The catalog's category that leaves the grid for “Not in the list?” (AP-1164). */
const CUSTOM: CatalogCategory = 'custom';

/**
 * A connection on the overview, a builtin's or a catalog one, in one shape (AP-1159, AP-1160, AP-1177): its name, where
 * it is, a tag and its state, and why when it needs you.
 */
export interface HaveRow {
  key: string;
  /** The builtin page or the catalog entry: its logo and `data-connection`. */
  page: string;
  search: { tab: 'connections'; connection: string; id?: string };
  /**
   * A catalog connection's own page (connection-pages.md CP-01): the row opens it instead of its Settings page; null for
   * a builtin.
   */
  thing: string | null;
  name: string;
  /** Where it is or which account (AP-1178): “10.100.0.5:8123”, “mara@example.com”, “@acme”; null for none. */
  address: string | null;
  /** The address is a name (a feedback integration's “Billing portal”), not an address: not in mono. */
  plain: boolean;
  /** “Look only” when agents may only look (CT-314); null otherwise. */
  tag: string | null;
  /** Why it needs you; null while it's fine. */
  reason: string | null;
  tone: StateTone;
  state: string;
  /** Another row shows the same name and place: “Same name as another connection. …”; else null. */
  note: string | null;
}

/** Every connection in the overview's order: the builtins (GitHub, Google, Microsoft, Website feedback), then the catalog's. */
export function haveRows(entries: readonly ConnectionEntry[], catalogRows: readonly CatalogRow[]): HaveRow[] {
  const rows: HaveRow[] = [];
  for (const entry of entries) {
    const conn = entry.connected;
    if (!conn) continue;
    rows.push({
      key: entry.page,
      page: entry.page,
      search: providerSearch(entry.page),
      thing: null,
      name: connectionName(entry.page),
      address: conn.detail,
      plain: conn.plain ?? false,
      tag: null,
      // What it brings (“Gmail, Google Calendar and Google Drive”, “3 repositories on”) is on its page; the line only
      // says why it needs you (AP-1177).
      reason: conn.ok ? null : conn.meta,
      tone: conn.ok ? 'ok' : 'warn',
      state: conn.state,
      note: null,
    });
  }
  for (const row of catalogRows)
    rows.push({
      key: row.id,
      page: row.catalogId,
      search: connectionSearch(row.catalogId, row.id),
      thing: thingHref(row.catalogId === 'device' ? 'device' : 'connection', row.id),
      name: row.name,
      address: row.address,
      plain: false,
      tag: row.lookOnly ? CONNECTION_ACCESS_LABELS.read : null,
      reason: row.reason,
      tone: row.tone,
      state: row.state,
      note: null,
    });
  const same = sameNameKeys(rows);
  return rows.map((r) => (same.has(r.key) ? { ...r, note: SETTINGS_CONNECTIONS_TEXT.sameName } : r));
}

/** A NEEDS YOU row's button: “Connect again” for a sign-in that ran out, “Open” for the rest (AP-1159). */
export function needsAction(state: string): string {
  return state === 'Needs you to sign in again' ? 'Sign in again' : 'Open';
}

/** Every tile of Add a connection, builtin or not, in one shape. */
interface Tile extends CatalogTile {
  search: { tab: 'connections'; connection: string };
  /** The viewer has one of these already: the tile says Connected (AP-1163). */
  connected: boolean;
}

/** Add a connection's chips (AP-1162): everything, what the scan found, or one category. */
type Show = 'all' | 'network' | CatalogCategory;

export function ConnectionsOverview({
  burrow,
  entries,
  catalog = null,
  canScan = false,
  adding = false,
  found = false,
}: {
  burrow: string;
  entries: readonly ConnectionEntry[];
  catalog?: CatalogOverview | null;
  /** The viewer manages the burrow on a runtime that scans (CS-51, AP-846): Found on your network shows. */
  canScan?: boolean;
  /** Add a connection (`&connection=add`, AP-1157) instead of the overview. */
  adding?: boolean;
  /** Add a connection at On your network (`&found=1`, AP-3801): the chip picked, the search box not focused. */
  found?: boolean;
}) {
  // What the overview says first (AP-1158), the assistant by its name in the assistant shell (AP-1802).
  const words = useConnectionWords(burrow);
  const home = useConnectionsBack();
  const rows = haveRows(entries, catalog?.rows ?? []);
  // A row's own page is read while the pointer rests on it (page-speed.md AP-2660).
  const linkProps = useThingLinkProps(burrow);
  const has = new Set(rows.map((r) => r.page));
  const tiles: Tile[] = [
    // A builtin you have stays on the list, Connected, and opens its page (AP-1163).
    ...entries.map(
      (entry): Tile => ({
        catalogId: entry.page,
        name: connectionName(entry.page),
        description: builtinDescription(entry.page, words),
        category: catalogEntry(entry.page)?.category ?? 'accounts',
        action: entry.connected ? 'Open' : entry.tile.action,
        note: entry.connected ? null : entry.tile.note,
        search: providerSearch(entry.page),
        connected: entry.connected !== null,
      }),
    ),
    ...(catalog?.tiles ?? []).map(
      (tile): Tile => ({
        ...tile,
        search: providerSearch(tile.catalogId),
        connected: has.has(tile.catalogId),
      }),
    ),
  ];
  if (adding)
    return (
      <>
        <Link to={home.link.to} search={home.link.search as never} className={c.back}>
          {home.label}
        </Link>
        <div className={c.addHead}>
          <h2 className={c.providerTitle}>Add a connection</h2>
          <span className={c.meta}>{words.addHint}</span>
        </div>
        <AddConnection
          key={found ? 'found' : 'add'}
          burrow={burrow}
          tiles={tiles}
          canScan={canScan}
          autoFocus={!found}
          initial={found ? 'network' : 'all'}
        />
      </>
    );
  if (rows.length === 0)
    return (
      <>
        <p className={c.intro}>{SETTINGS_CONNECTIONS_TEXT.intro}</p>
        <section className={settings.section} aria-labelledby="connections-connected">
          <SectionLabel as="h2" id="connections-connected">
            CONNECTED
          </SectionLabel>
          <div className={settings.card}>
            <p className={settings.empty}>Nothing connected yet.</p>
          </div>
        </section>
        <section className={settings.section} aria-labelledby="connections-available">
          <SectionLabel as="h2" id="connections-available">
            ADD A CONNECTION
          </SectionLabel>
          <AddConnection burrow={burrow} tiles={tiles} canScan={canScan} />
        </section>
      </>
    );
  const groups = settingsConnectionGroups(rows.map((r) => ({ ...r, ok: r.tone === 'ok' })));
  const needs = groups.needsYou;
  return (
    <>
      <div className={c.overviewHead}>
        <p className={c.intro}>{SETTINGS_CONNECTIONS_TEXT.intro}</p>
        {/* Adding happens on the Connections page, wherever the list is shown. */}
        <RouterButtonLink
          variant="primary"
          size="md"
          to={ADD_CONNECTION_LINK.to}
          search={ADD_CONNECTION_LINK.search as never}
          iconStart={<Icon icon={Plus} size={16} />}
        >
          Add a connection
        </RouterButtonLink>
      </div>
      {needs.length > 0 && (
        <section className={settings.section} aria-labelledby="connections-needs">
          <SectionLabel as="h2" id="connections-needs">
            NEEDS YOU<span aria-hidden="true"> · {needs.length}</span>
          </SectionLabel>
          <div className={`${settings.card} ${c.needsCard}`}>
            <ul className={c.connectedList}>
              {needs.map((row) => (
                <NeedsRow key={row.key} row={row} linkProps={linkProps} />
              ))}
            </ul>
          </div>
        </section>
      )}
      {groups.accounts.length > 0 && (
        <ConnectedSection
          id="connections-accounts"
          title={SETTINGS_CONNECTIONS_TEXT.accounts}
          rows={groups.accounts}
          linkProps={linkProps}
        />
      )}
      {groups.apps.length > 0 && (
        <ConnectedSection
          id="connections-connected"
          title={SETTINGS_CONNECTIONS_TEXT.apps}
          rows={groups.apps}
          linkProps={linkProps}
        />
      )}
      {canScan && <NetworkStrip burrow={burrow} />}
    </>
  );
}

/** ACCOUNTS · 2, APPS AND SERVICES · 13 (AP-1160): one-line rows. */
function ConnectedSection({
  id,
  title,
  rows,
  linkProps,
}: {
  id: string;
  title: string;
  rows: readonly HaveRow[];
  linkProps: (href: string) => ThingLinkProps;
}) {
  return (
    <section className={settings.section} aria-labelledby={id}>
      <div className={settings.sectionHead}>
        <SectionLabel as="h2" id={id}>
          {title}
          <span aria-hidden="true"> · {rows.length}</span>
        </SectionLabel>
      </div>
      <div className={settings.card}>
        <ul className={c.connectedList}>
          {rows.map((row) => (
            <HaveRowLink key={row.key} row={row} linkProps={linkProps} />
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The found strip on the overview (AP-1161): its own scan, so opening the overview still finds what's new. */
function NetworkStrip({ burrow }: { burrow: string }) {
  return <FoundStrip found={useFoundScan(burrow)} />;
}

/** Where it is, in a quiet pill after the name (AP-1178): mono for an address or an account, cut with an ellipsis. */
function Address({ row }: { row: HaveRow }) {
  return row.address ? (
    <span className={c.address} data-plain={row.plain ? '' : undefined} title={row.address}>
      {row.address}
    </span>
  ) : null;
}

/**
 * A healthy connection in one line (AP-1160, AP-1177): logo, name, where it is, Look only, the dot and the chevron. The names take one column so the addresses line up.
 */
function HaveRowLink({ row, linkProps }: { row: HaveRow; linkProps: (href: string) => ThingLinkProps }) {
  return (
    <li>
      <RowLink row={row} className={c.haveRow} linkProps={linkProps}>
        <ProviderLogo provider={row.page} size={32} />
        <span className={c.haveName} title={row.name}>
          {row.name}
        </span>
        <span className={c.haveWhere}>
          <Address row={row} />
          {row.tag && <Tag className={c.haveTag}>{row.tag}</Tag>}
          {row.note && <span className={c.haveNote}>{row.note}</span>}
        </span>
        <StatusDot tone="ok" size={8} label={null} />
        <span className={c.srOnly}>{row.state}</span>
        <span className={c.chevron} aria-hidden="true">
          <Icon icon={ChevronRight} size={16} />
        </span>
      </RowLink>
    </li>
  );
}

/** A connection that needs you: its state, why, and the fix as the row's button (AP-1159). The whole row is one link. */
function NeedsRow({ row, linkProps }: { row: HaveRow; linkProps: (href: string) => ThingLinkProps }) {
  const action = needsAction(row.state);
  return (
    <li>
      <RowLink row={row} className={c.needsRow} settings={action === 'Sign in again'} linkProps={linkProps}>
        <ProviderLogo provider={row.page} />
        <span className={c.main}>
          <span className={c.nameLine}>
            <span className={c.name}>{row.name}</span>
            <Address row={row} />
            <span className={c.needsState} data-tone={row.tone}>
              <StatusDot tone={row.tone} size={8} label={null} />
              {row.state}
            </span>
          </span>
          {row.reason && <span className={c.needsMeta}>{row.reason}</span>}
          {row.note && <span className={c.needsMeta}>{row.note}</span>}
        </span>
        <span className={c.needsAction} data-primary={action === 'Sign in again' ? '' : undefined}>
          {action}
        </span>
      </RowLink>
    </li>
  );
}

/** A row's link: the connection's own page (its Settings tab to connect again), else its Settings page. */
function RowLink({
  row,
  className,
  settings = false,
  linkProps,
  children,
}: {
  row: HaveRow;
  className: string | undefined;
  settings?: boolean;
  linkProps: (href: string) => ThingLinkProps;
  children: ReactNode;
}) {
  if (row.thing)
    return (
      <AppLink
        href={settings ? `${row.thing}?tab=settings` : row.thing}
        {...linkProps(row.thing)}
        className={className}
        data-connection={row.page}
      >
        {children}
      </AppLink>
    );
  return (
    <Link to="/settings" search={row.search} className={className} data-connection={row.page}>
      {children}
    </Link>
  );
}

/**
 * Add a connection's body (AP-1162…AP-1164): the search box, the chips, On your network (the full section), the
 * tiles by category, and “Not in the list?”. Also the overview's own body while nothing is connected (AP-1166).
 * `initial` is the chip it opens with (On your network for `&found=1`, AP-3801); where the viewer can't scan, All.
 */
function AddConnection({
  burrow,
  tiles,
  canScan,
  autoFocus = false,
  initial = 'all',
}: {
  burrow: string;
  tiles: readonly Tile[];
  canScan: boolean;
  autoFocus?: boolean;
  initial?: Show;
}) {
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<Show>(initial);
  const searchId = useId();
  const found = useFoundScan(canScan ? burrow : null);
  const custom = tiles.filter((t) => t.category === CUSTOM);
  const listed = tiles.filter((t) => t.category !== CUSTOM);
  const categories = groupByCategory(listed).map((g) => g.category);
  const network = !found.refused;
  const networkCount = foundCount(found);
  const picked = show === 'network' && !network ? 'all' : show;
  const matching = listed.filter(
    (t) => matchesSearch(t, query) && (picked === 'all' || picked === t.category),
  );
  const groups = groupByCategory(matching);
  const nothing = picked !== 'network' && groups.length === 0;
  return (
    <div className={c.add}>
      <label className={c.addSearch} htmlFor={searchId}>
        <span className={c.srOnly}>Search connections</span>
        <Icon icon={Search} size={16} className={c.addSearchIcon} />
        <Input
          id={searchId}
          type="search"
          size="md"
          className={c.addSearchInput}
          placeholder={`Search ${listed.length + custom.length} services`}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <fieldset className={c.addChips}>
        <legend className={c.srOnly}>Show</legend>
        <Chip active={picked === 'all'} onClick={() => setShow('all')}>
          All
        </Chip>
        {network && (
          <Chip
            active={picked === 'network'}
            count={networkCount > 0 ? networkCount : undefined}
            onClick={() => setShow('network')}
          >
            On your network
          </Chip>
        )}
        {categories.map((category) => (
          <Chip key={category} active={picked === category} onClick={() => setShow(category)}>
            {CATALOG_CATEGORY_LABELS[category]}
          </Chip>
        ))}
      </fieldset>
      {network && (picked === 'all' || picked === 'network') && (
        <FoundOnNetwork found={found} query={query} />
      )}
      {picked !== 'network' &&
        (nothing ? (
          <div className={settings.card}>
            <p className={settings.empty}>No connection matches “{query.trim()}”.</p>
          </div>
        ) : (
          groups.map((group) => (
            <section
              key={group.category}
              className={c.category}
              aria-labelledby={`${searchId}-${group.category}`}
            >
              <h3 id={`${searchId}-${group.category}`} className={c.categoryTitle}>
                {group.label}
              </h3>
              <ul className={c.pickTiles}>
                {group.items.map((tile) => (
                  <PickTile key={tile.catalogId} tile={tile} />
                ))}
              </ul>
            </section>
          ))
        ))}
      {picked !== 'network' && custom.length > 0 && <NotListed custom={custom} />}
    </div>
  );
}

/** “Not in the list? Connect any MCP server or any HTTP API.” — the Custom entries, out of the grid (AP-1164). */
function NotListed({ custom }: { custom: readonly Tile[] }) {
  const mcp = custom.find((t) => t.catalogId === 'custom_mcp');
  const rest = custom.find((t) => t.catalogId === 'custom_api');
  const link = (tile: Tile, text: string) => (
    <Link to="/settings" search={tile.search} className={c.notListedLink}>
      {text}
    </Link>
  );
  return (
    <p className={c.notListed}>
      Not in the list? Connect {mcp && link(mcp, 'any MCP server')}
      {mcp && rest ? ' or ' : null}
      {rest && link(rest, 'any HTTP API')}.
    </p>
  );
}

/**
 * A service on Add a connection (AP-1163): one link, its logo, name and a tag — Connected when you have one, Set up when
 * it needs setting up first — its line, and a note where it can't be connected yet. Its name says what pressing does.
 */
function PickTile({ tile }: { tile: Tile }) {
  const { action, note, name } = tile;
  return (
    <li>
      <Link
        to="/settings"
        search={tile.search}
        className={c.pickTile}
        data-provider={tile.catalogId}
        aria-label={`${action} ${name}`}
      >
        <ProviderLogo provider={tile.catalogId} size={32} />
        <span className={c.pickText}>
          <span className={c.pickName}>
            <span className={c.pickTitle}>{name}</span>
            {tile.connected ? (
              <Tag tone="ok" className={c.pickTag}>
                Connected
              </Tag>
            ) : action === 'Set up' ? (
              <Tag className={c.pickTag}>Set up</Tag>
            ) : null}
          </span>
          <span className={c.pickLine} title={tile.description}>
            {tile.description}
          </span>
          {note && <span className={c.pickNote}>{note}</span>}
        </span>
      </Link>
    </li>
  );
}
