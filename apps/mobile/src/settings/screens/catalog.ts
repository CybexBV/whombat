/**
 * *Add a widget* on the phone (Whombat desk-display.md DK-139, DK-143, DK-145, DK-153…DK-155, DK-159; desk-display-android.md
 * AP-6017, AP-6032…, AP-6120…): the runtime's groups (`desk.widgets`) in the shared sections (`catalogSections`) —
 * *Whombat and {assistant}*, *Servers* with a fold per server, each connection or device, *Your accounts* with a fold
 * per account, *Made by {assistant}* — each folding under its heading, search across all of them, a thing that listed
 * only part of what it has offering the rest, each item with the size it starts at and whether it's on this page
 * already; and an account widget's name and the other widgets of its account. Pure.
 */

import type {
  CatalogSectionKind,
  DeskCatalog,
  DeskCatalogGroup,
  DeskCatalogItem,
  DeskWidget,
  NewWidget,
} from '@whombat/client/desk';
import {
  CATALOG_FOLDED_AT_FIRST,
  catalogItemKey,
  catalogName,
  catalogSections,
  gridText,
  isAccountGroup,
  sameWidget,
  widgetSize,
} from '@whombat/client/desk';
import { DESK_ACCOUNT_GITHUB } from '@whombat/core';
import type { KnownWidget } from './tiles';

export interface CatalogRow {
  key: string;
  item: DeskCatalogItem;
  /** “3 × 2”: the size it starts at. */
  size: string;
  /** Something like it is on this page already. */
  here: boolean;
}

/**
 * A group in a section: most sections have one; *Servers* has one per server and *Your accounts* one per account, each
 * folding on its own.
 */
export interface CatalogGroupView {
  key: string;
  label: string;
  mark: string | null;
  /** A connection's or device's group. */
  thing: string | null;
  /** A server's own group (`server:<id>`) inside *Servers*: it has a heading and folds. */
  server: boolean;
  /** An account's group (`account:<id>`) inside *Your accounts*: it has a heading and folds, open at first. */
  account: boolean;
  folded: boolean;
  /** It listed only part of what it has: *Show its widgets* reads the rest. */
  more: boolean;
  rows: CatalogRow[];
}

export interface CatalogSectionView {
  key: string;
  kind: CatalogSectionKind;
  label: string;
  mark: string | null;
  folded: boolean;
  /** How many items it lists. */
  count: number;
  groups: CatalogGroupView[];
}

const matches = (q: string, ...words: (string | undefined)[]) =>
  words.some((w) => w?.toLowerCase().includes(q));

/** A server's group, which folds inside *Servers* (an older runtime's single *Servers* group doesn't). */
const isServerOwn = (key: string) => key.startsWith('server:');

/**
 * Whether a section or a server's group is folded: as it starts (Whombat's own, *Servers* and each server folded, the
 * rest open), unless the person turned it (`flipped`, by key: a section's or a server group's).
 */
export function catalogFolded(key: string, atFirst: boolean, flipped: ReadonlySet<string>): boolean {
  return flipped.has(key) ? !atFirst : atFirst;
}

/**
 * The sheet's sections for `query`: without one, every section folded or open as the person left it (`flipped`), a
 * thing's items as read on asking (`read`); with one, everything that matches open — a section's or a group's name
 * lists all of its items, else the items whose name or line does.
 */
export function catalogView(
  catalog: DeskCatalog,
  input: {
    query: string;
    onPage: readonly DeskWidget[];
    flipped: ReadonlySet<string>;
    read?: Readonly<Record<string, DeskCatalogGroup | undefined>>;
  },
): CatalogSectionView[] {
  const q = input.query.trim().toLowerCase();
  const searching = q !== '';
  const out: CatalogSectionView[] = [];
  for (const section of catalogSections(catalog)) {
    const sectionNamed = searching && matches(q, section.label);
    const groups: CatalogGroupView[] = [];
    for (const group of section.groups) {
      const thing = group.thing ?? null;
      const read = thing ? input.read?.[thing] : undefined;
      const items = read?.items ?? group.items;
      const account = section.kind === 'accounts' && isAccountGroup(group);
      const named =
        sectionNamed || (searching && matches(q, group.label, account ? accountName(group) : undefined));
      const shown =
        !searching || named ? items : items.filter((i) => matches(q, i.name, i.line, catalogName(group, i)));
      if (searching && shown.length === 0) continue;
      const server = section.kind === 'servers' && isServerOwn(group.key);
      groups.push({
        key: group.key,
        label: group.label,
        mark: group.mark ?? null,
        thing,
        server,
        account,
        // A server's parts are many, so each server starts folded; a person's accounts have a few widgets each.
        folded: !searching && (server || account) && catalogFolded(group.key, server, input.flipped),
        more: Boolean(thing && !read && group.partial),
        rows: shown.map((item) => ({
          key: catalogItemKey(item),
          item,
          size: startSize(item),
          here: input.onPage.some((w) => sameWidget(item, w)),
        })),
      });
    }
    if (searching && groups.length === 0) continue;
    out.push({
      key: section.key,
      kind: section.kind,
      label: section.label,
      mark: section.mark ?? null,
      folded:
        !searching && catalogFolded(section.key, CATALOG_FOLDED_AT_FIRST.has(section.kind), input.flipped),
      count: groups.reduce((n, g) => n + g.rows.length, 0),
      groups,
    });
  }
  return out;
}

/** The size an item starts at: a server's by its part, a panel's by the view it draws. */
function startSize(item: DeskCatalogItem): string {
  const s = widgetSize({ id: '', type: item.type, opts: item.opts }, () => item.view).def;
  return gridText(s[0], s[1]);
}

/**
 * What the editor adds for an item, and what it remembers of it for the tile: its name (a server's by the server,
 * “pve-01 · Storage”), mark and view, and the thing or account it belongs to (“Google · anna@example.com”).
 */
export function fromCatalog(
  item: DeskCatalogItem,
  group: Pick<CatalogGroupView, 'key' | 'label' | 'thing'> & { mark?: string | null | undefined },
): { widget: NewWidget; known: KnownWidget } {
  const account = isAccountGroup(group);
  const mark = item.mark ?? (account ? group.mark : undefined);
  return {
    widget: { type: item.type, ...(item.ref ? { ref: item.ref } : {}), opts: { ...item.opts } },
    known: {
      name: item.type === 'server' ? catalogName(group, item) : item.name,
      ...(mark ? { mark } : {}),
      ...(item.view ? { view: item.view } : {}),
      ...(account ? { of: accountName(group) } : group.thing ? { of: group.label } : {}),
    },
  };
}

/** Who holds an account, by its mark (the runtime marks an account by its provider). */
const ACCOUNT_PROVIDERS: Readonly<Record<string, string>> = {
  google: 'Google',
  microsoft: 'Microsoft 365',
  mail: 'Email',
  imap: 'Email',
  github: 'GitHub',
};

/**
 * An account by who holds it and its address, “Google · anna@example.com”: the runtime's label with the provider in
 * front where the label doesn't say it already (“GitHub” stays “GitHub”).
 */
export function accountName(group: { label: string; mark?: string | null | undefined }): string {
  const provider = group.mark ? ACCOUNT_PROVIDERS[group.mark] : undefined;
  if (!provider || group.label.toLowerCase().startsWith(provider.toLowerCase())) return group.label;
  return `${provider} · ${group.label}`;
}

/** What an account's widget shows, for its icon where it has no brand mark of its own. */
export type AccountShows = 'calendar' | 'mail' | 'pulls';

/**
 * What an account's widget shows, by its panel (*Today* and *Next meeting* a calendar, *Unread mail* mail, *Pull
 * requests* and *Waiting for review* pull requests; everything of the Whombat's GitHub is pull requests), or null for
 * a widget that isn't an account's or a panel it doesn't recognise.
 */
export function accountShows(w: {
  ref?: string | undefined;
  opts: Readonly<Record<string, string>>;
}): AccountShows | null {
  if (!w.ref?.startsWith('account:')) return null;
  if (w.ref === DESK_ACCOUNT_GITHUB) return 'pulls';
  const panel = w.opts.panel ?? '';
  if (/mail|unread|inbox/.test(panel)) return 'mail';
  if (/pull|review|^prs?\b/.test(panel)) return 'pulls';
  if (/today|next|meeting|calendar|agenda|event/.test(panel)) return 'calendar';
  return null;
}

/** An account widget's account in the catalogue: its group, by the widget's ref. */
export function accountGroup(
  catalog: DeskCatalog | undefined,
  ref: string | undefined,
): DeskCatalogGroup | null {
  if (!ref?.startsWith('account:')) return null;
  return catalog?.groups.find((g) => isAccountGroup(g) && (g.key === ref || g.thing === ref)) ?? null;
}

/**
 * The widgets an account widget can switch to: its account's of the same type (a panel's other panels), for its
 * sheet's *Shows*.
 */
export function accountChoices(
  catalog: DeskCatalog | undefined,
  w: Pick<DeskWidget, 'type' | 'ref'>,
): DeskCatalogItem[] {
  return (accountGroup(catalog, w.ref)?.items ?? []).filter((i) => i.type === w.type && i.ref === w.ref);
}

/**
 * An account widget switched to another of its account's widgets: that one's options, with *On a locked screen*
 * kept where the new one is private too.
 */
export function withAccountItem(
  opts: Readonly<Record<string, string>>,
  item: Pick<DeskCatalogItem, 'opts' | 'private'>,
): Record<string, string> {
  return { ...item.opts, ...(item.private && opts.lock ? { lock: opts.lock } : {}) };
}

/**
 * Whether a widget shows what a locked screen leaves out (DK-138), so its sheet offers *On a locked screen*: as the
 * item it comes from says (`private`: what was read of the thing's page, a server's alerts, an account's calendar and
 * mail), else by what it draws — what's playing, camera stills and photos are — or by what it names: an account's
 * widgets are, but for the Whombat's GitHub.
 */
export function widgetPrivate(
  w: Pick<DeskWidget, 'type' | 'ref' | 'opts'>,
  groups: readonly Pick<DeskCatalogGroup, 'items'>[],
  view: string | undefined,
): boolean {
  if (w.type !== 'panel' && w.type !== 'figures' && w.type !== 'widget' && w.type !== 'server') return false;
  for (const g of groups)
    for (const item of g.items) if (sameWidget(item, w) && item.private !== undefined) return item.private;
  if (w.ref?.startsWith('account:')) return w.ref !== DESK_ACCOUNT_GITHUB;
  return w.type !== 'server' && (view === 'posters' || view === 'camera' || view === 'photo');
}

/** A server widget's options showing part `show` (the overview's is empty: no `show`), its other choices kept. */
export function withServerPart(opts: Readonly<Record<string, string>>, show: string): Record<string, string> {
  const { show: _was, ...rest } = opts;
  return show && show !== 'overview' ? { ...rest, show } : rest;
}

/** A server widget moved to another server: the same part when that server offers it, else its overview. */
export function onAnotherServer(
  opts: Readonly<Record<string, string>>,
  parts: readonly { show: string }[],
): Record<string, string> {
  const show = opts.show ?? '';
  return parts.some((p) => p.show === show) ? { ...opts } : withServerPart(opts, '');
}
