/**
 * The connections catalog on the web (Whombat connections-catalog.md CX-70…CX-72; app AP-755…AP-764): what the
 * overview's rows and tiles say, and a tool's tier. The connect form's part — how it signs in, which fields
 * show, what a refusal means in a sentence with its fix, a connection's state in words — is `@whombat/client/connections`,
 * shared with the phone (phone-connect.md PC-04, AP-2901), and re-exported here. Pure: the components and the tests read
 * it.
 */
import { connectionReason, connectionState, type StateTone } from '@whombat/client/connections';
import {
  CATALOG_CATEGORIES,
  CATALOG_CATEGORY_LABELS,
  type CatalogCategory,
  type CatalogEntry,
  type CatalogEntryStatus,
  type ConnectionToolTier,
  type ConnectionToolView,
  type ConnectionView,
  catalogEntry,
  connectionHost,
} from '@whombat/core/domain';
import { formatAgo } from '@whombat/core/text';

export {
  CONNECTABLE,
  CONNECTION_CONNECT_ERROR_TEXT,
  CONNECTION_STATE,
  type ConnectProblem,
  checkFailedText,
  connectableEntry,
  connectButtonText,
  connectionState,
  connectProblem,
  httpWarning,
  NO_PROBLEM,
  reauthText,
  type SignInChoice,
  type StateTone,
  sessionSecret,
  signInChoices,
  signInRefusedText,
  switchText,
  usedByAgents,
  usedByAutomations,
  usedByGateway,
  usedByVaultSync,
  visibleFields,
} from '@whombat/client/connections';

import { addressReasonNote, addressReasonOf, CATALOG_REASON_TEXT } from '@whombat/client/connections';

/* The overview (CX-70) ------------------------------------------------------------------------- */

/**
 * A row of a catalog connection on the overview (CX-70; connections-redesign.md AP-1177): its name, where it is, “Look
 * only” when agents may only look, and its state — and why, when it needs you (one kind of connection, AP-5711). Who connected it, who looks
 * after it, its tools and a gateway's or automations' line are on its own page, not on the row.
 */
export interface CatalogRow {
  id: string;
  catalogId: string;
  label: string;
  /** The label without the address it ends with (“Home Assistant · home.lan:8123” → “Home Assistant”). */
  name: string;
  /** Where it is: the host and port (no scheme), else the account (“mara@example.com”); null when there is neither. */
  address: string | null;
  /** Agents may only look (CT-314): the row's “Look only” tag. */
  lookOnly: boolean;
  state: string;
  tone: StateTone;
  /** Why it needs you (“Nextcloud signed Whombat out. Connect again to keep using it.”); null while it's fine. */
  reason: string | null;
}

export function toolsText(n: number): string {
  return n === 1 ? '1 tool' : `${n} tools`;
}

/**
 * Where a connection is, for its row (AP-1178): the host and port of its address, else the server's detail (the
 * account it signed in as); null when there is neither.
 */
export function connectionAddress(c: Pick<ConnectionView, 'catalogId' | 'fields' | 'detail'>): string | null {
  const entry = catalogEntry(c.catalogId);
  return (entry ? connectionHost(entry, c.fields) : null) ?? c.detail ?? null;
}

/** A label without the address it ends with (the default label, CX-05); the label itself otherwise. */
export function labelName(label: string, address: string | null): string {
  const suffix = address ? ` · ${address}` : null;
  return suffix && label.endsWith(suffix) && label.length > suffix.length
    ? label.slice(0, -suffix.length)
    : label;
}

export function catalogRow(c: ConnectionView): CatalogRow {
  const entry = catalogEntry(c.catalogId);
  const address = connectionAddress(c);
  const state = connectionState(c);
  return {
    id: c.id,
    catalogId: c.catalogId,
    label: c.label,
    name: labelName(c.label, address),
    address,
    lookOnly: c.status === 'active' && c.access === 'read',
    state: state.text,
    tone: state.tone,
    reason: connectionReason(entry, c),
  };
}

/** Rows in the overview's order: by label (the list answers by label already). */
export function catalogRows(connections: readonly ConnectionView[]): CatalogRow[] {
  return [...connections].sort((a, b) => a.label.localeCompare(b.label)).map((c) => catalogRow(c));
}

/* Connections only automations use (Whombat report-trackers.md TA-01…TA-03; contracts 0.69.0) ---------------- */

/**
 * What a connection only automations use says instead of the agents' lines (TA-02): the row's tag and the page's
 * block. A report tracker is the one such entry, so the words are its reports'. From contracts 0.71 (`automations.suggestions`;
 * Whombat TA-22, TA-23) the block adds `organization`: looking inside the reporting organization follows the token's
 * scope, not a switch in Whombat.
 */
export const USED_BY_AUTOMATIONS = {
  title: 'Used by automations',
  /** Automations answer its customers too (AP-1112). */
  text: 'Automations read its new reports, write their assessments back and reply to the customers. Your agent doesn’t use it in chats: in an automation it reads the report it’s given.',
  organization:
    'In an automation your agent also looks inside the organization a report comes from, read-only, when the token has reports:assess.',
} as const;

/** What the poller that reads it for automations says (TA-03, TA-05), in plain words with the time. */
export interface PollerNote {
  tone: 'ok' | 'warn';
  text: string;
}

/**
 * The poller's line on a connection's page (TA-03): “Checked for new reports 2 min ago.”; with a problem “Couldn’t reach
 * Acme Desk dev: <the server's words>.” (`name`: the connection's) and “Last reached 1 hour ago.” when it ever got
 * through. Null without a poller (no
 * automation listens, or an older runtime).
 */
export function pollerNote(
  poller: ConnectionView['poller'] | undefined,
  name: string,
  now: Date,
  timeZone: string,
): PollerNote | null {
  if (!poller) return null;
  const ago = (at: string) => formatAgo(at, now, timeZone);
  if (poller.problem) {
    const why = poller.problem.trim().replace(/[.!?]+$/, '');
    const last = poller.succeededAt ? ` Last reached ${ago(poller.succeededAt)}.` : '';
    return { tone: 'warn', text: `Couldn’t reach ${name}: ${why}.${last}` };
  }
  return {
    tone: 'ok',
    text: poller.checkedAt
      ? `Checked for new reports ${ago(poller.checkedAt)}.`
      : 'Hasn’t checked for new reports yet.',
  };
}

/**
 * Which installation it is (0.75, TA-32, AP-1112): “Development · Acme Desk 0.1.174”, “Production · Acme Desk 0.1.180”
 * (`product`: the tracker's name; “version 0.1.174” without it), either part alone when the tracker said only one, null
 * before the first read and from an older runtime.
 */
export function installationLine(
  poller: ConnectionView['poller'] | undefined,
  product?: string,
): string | null {
  if (!poller) return null;
  const version = poller.version?.trim();
  const parts = [
    ...(poller.environment ? [poller.environment === 'development' ? 'Development' : 'Production'] : []),
    ...(version ? [`${product?.trim() || 'version'} ${version}`] : []),
  ];
  return parts.length ? parts.join(' · ') : null;
}

/** What an entry's tile says under ADD A CONNECTION, and its button. */
export interface TileState {
  action: 'Connect' | 'Set up' | 'View' | typeof CATALOG_REASON_TEXT.needsMacAction;
  note: string | null;
  /** The tile opens Add a server instead of its page: Find My without a Mac (`needs_mac`). */
  addServer?: boolean;
}

/**
 * A catalog entry's tile (CX-70): Connect; an `app_oauth` entry not set up yet gets Set up (CT-1553); Find My without a
 * Mac says Add a Mac first and opens Add a server; an entry this Whombat turned off, or a report tracker without a
 * driver installed here (nothing could read it), is left out (null).
 */
export function catalogTileState(status: CatalogEntryStatus | undefined): TileState | null {
  if (!status || status.available) return { action: 'Connect', note: null };
  if (status.reason === 'off' || status.reason === 'no_driver') return null;
  // It can't sign in here yet: its page says what to do first, or Find My's tile opens Add a server for a Mac.
  const address = addressReasonOf(status);
  if (address === 'needs_mac')
    return { action: CATALOG_REASON_TEXT.needsMacAction, note: addressReasonNote(address), addServer: true };
  if (address) return { action: 'View', note: addressReasonNote(address) };
  return { action: 'Set up', note: 'Set it up once, then you can connect.' };
}

/** Whether a text has every word of the search box in it, in any order (an empty box matches everything). */
export function matchesWords(text: string, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  return words.every((w) => lower.includes(w));
}

/** Whether a tile matches the search box: its name, line or category, any word in any order. */
export function matchesSearch(entry: Pick<CatalogEntry, 'name' | 'description' | 'category'>, q: string) {
  return matchesWords(`${entry.name} ${entry.description} ${CATALOG_CATEGORY_LABELS[entry.category]}`, q);
}

/** Tiles grouped by category in the catalog's order (CX-70), empty groups left out. */
export function groupByCategory<T extends { category: CatalogCategory }>(
  items: readonly T[],
): { category: CatalogCategory; label: string; items: T[] }[] {
  return CATALOG_CATEGORIES.map((category) => ({
    category,
    label: CATALOG_CATEGORY_LABELS[category],
    items: items.filter((i) => i.category === category),
  })).filter((g) => g.items.length > 0);
}

/* Tools (CX-72) ----------------------------------------------------------------------------------- */

/** The tier a tool shows: a sensitive one asks whatever its tier (CX-31), unless it's off. */
export function shownTier(tool: Pick<ConnectionToolView, 'tier' | 'sensitive'>): ConnectionToolTier {
  return tool.sensitive && tool.tier === 'can' ? 'ask' : tool.tier;
}

/** Whether a tier can be chosen for a tool: Allowed means nothing for one that always asks. */
export function tierSelectable(
  tool: Pick<ConnectionToolView, 'sensitive'>,
  tier: ConnectionToolTier,
): boolean {
  return !(tool.sensitive && tier === 'can');
}

/** A tool's access in words: “Reads” or “Changes things”. */
export function accessText(tool: Pick<ConnectionToolView, 'access'>): string {
  return tool.access === 'read' ? 'Reads' : 'Changes things';
}

/** The Settings address of a connection page: the entry's connect page, or one connection (`&id=`). */
export function connectionSearch(catalogId: string, id?: string) {
  return { tab: 'connections' as const, connection: catalogId, ...(id ? { id } : {}) };
}
