/**
 * *Add a widget*, shared by the web and the phone (Whombat desk-display.md DK-139, DK-154, DK-163…DK-165): the
 * runtime's groups (`desk.widgets`) in sections — *Whombat and {assistant}*, *Servers*, the connections and devices,
 * *Your accounts*, *Made by {assistant}* — and the rows they list: each service once (its main view is what adding it
 * adds; *What it shows* chooses among the rest), or with a search each view that matches; what two widgets showing the
 * same thing are, the group a widget belongs to, and an item's name in the editor. Pure.
 */
import { serverShow, sizeOf } from '@whombat/screen';
import { DESK_SCREEN_WORDS, type DeskCatalog, type DeskCatalogGroup, type DeskCatalogItem } from './contract';
import { DESK_SCREENS_TEXT } from './screens';

/**
 * What a section is: Whombat's own, the servers, a connection or device, the person's own accounts (3.7), the
 * assistant's Home widgets.
 */
export type CatalogSectionKind = 'own' | 'servers' | 'thing' | 'accounts' | 'widgets';

export interface CatalogSection {
  /** `own`, `servers`, `widgets`, or the thing's group key. */
  key: string;
  kind: CatalogSectionKind;
  label: string;
  mark?: string | undefined;
  /** Its groups: one for most, every server's under *Servers*, every account's under *Your accounts*. */
  groups: DeskCatalogGroup[];
}

/** Sections that start folded (DK-155): Whombat's own and the servers, so the connections show first. */
export const CATALOG_FOLDED_AT_FIRST: ReadonlySet<CatalogSectionKind> = new Set(['own', 'servers']);

/** How many items a section lists. */
export const sectionCount = (section: CatalogSection) =>
  section.groups.reduce((n, g) => n + g.items.length, 0);

/** A server's group (`server:<id>`), or an older runtime's single *Servers* group. */
export const isServerGroup = (group: Pick<DeskCatalogGroup, 'key'>) =>
  group.key === 'servers' || group.key.startsWith('server:');

/** One of the person's accounts (`account:<id>`, `account:github`). */
export const isAccountGroup = (group: Pick<DeskCatalogGroup, 'key'>) => group.key.startsWith('account:');

/**
 * The sections in the runtime's order: each group its own section, but every server's group under one *Servers* and
 * every account's under one *Your accounts* (where the first of them was).
 */
export function catalogSections(catalog: DeskCatalog | undefined): CatalogSection[] {
  const out: CatalogSection[] = [];
  let servers: CatalogSection | null = null;
  let accounts: CatalogSection | null = null;
  for (const group of catalog?.groups ?? []) {
    if (isServerGroup(group)) {
      if (!servers) {
        servers = { key: 'servers', kind: 'servers', label: DESK_SCREEN_WORDS.groups.servers, groups: [] };
        out.push(servers);
      }
      servers.groups.push(group);
      continue;
    }
    if (isAccountGroup(group)) {
      if (!accounts) {
        accounts = {
          key: 'accounts',
          kind: 'accounts',
          label: DESK_SCREEN_WORDS.groups.accounts,
          groups: [],
        };
        out.push(accounts);
      }
      accounts.groups.push(group);
      continue;
    }
    const kind: CatalogSectionKind =
      group.key === 'own' ? 'own' : group.key === 'widgets' ? 'widgets' : 'thing';
    out.push({ key: group.key, kind, label: group.label, mark: group.mark, groups: [group] });
  }
  return out;
}

type Shows = Pick<DeskCatalogItem, 'type' | 'ref' | 'opts'>;

/** Two widgets show the same thing: the same type and ref, the same panel, the same part of a server. */
export function sameWidget(a: Shows, b: Shows): boolean {
  return (
    a.type === b.type &&
    (a.ref ?? '') === (b.ref ?? '') &&
    (a.opts.panel ?? '') === (b.opts.panel ?? '') &&
    (a.type !== 'server' || serverShow(a.opts) === serverShow(b.opts))
  );
}

/** An item's key in a list: what it shows. */
export function catalogItemKey(item: Shows): string {
  const part = item.type === 'server' ? serverShow(item.opts) : '';
  return `${item.type}|${item.ref ?? ''}|${item.opts.panel ?? ''}|${part}`;
}

/**
 * An item's name in the editor, with what it belongs to where its own name doesn't say: a server's overview by the
 * server's name, its parts “pve-01 · Storage”, a thing's figures “Plex · Figures”, an account's “Google · Today”.
 */
export function catalogName(group: Pick<DeskCatalogGroup, 'key' | 'label'>, item: DeskCatalogItem): string {
  if (item.type === 'server' && group.key.startsWith('server:'))
    return serverShow(item.opts) === 'overview' ? group.label : `${group.label} · ${item.name}`;
  if (item.type === 'figures') return `${group.label} · ${item.name}`;
  // An account's widget by its provider, not its address: “Google · Today”, “GitHub · Pull requests”.
  if (isAccountGroup(group)) return `${group.label.split(' · ')[0]} · ${item.name}`;
  return item.name;
}

/** The catalogue's item for a widget, and its group. */
export function catalogFind(
  catalog: DeskCatalog | undefined,
  w: Shows,
): { group: DeskCatalogGroup; item: DeskCatalogItem } | null {
  for (const group of catalog?.groups ?? []) {
    const item = group.items.find((i) => sameWidget(w, i));
    if (item) return { group, item };
  }
  return null;
}

/** The servers *Add a widget* lists, once each (their overview items), for a server widget's *Server*. */
export function catalogServers(catalog: DeskCatalog | undefined): DeskCatalogItem[] {
  const seen = new Set<string>();
  const out: DeskCatalogItem[] = [];
  for (const group of catalog?.groups ?? [])
    for (const item of group.items) {
      if (item.type !== 'server' || !item.ref || seen.has(item.ref)) continue;
      seen.add(item.ref);
      // An older runtime names the item by the server; a newer one names the group.
      out.push(group.key.startsWith('server:') ? { ...item, name: group.label } : item);
    }
  return out;
}

/** The parts a server's group offers (`opts.show`, the overview's empty), for a server widget's *Shows*. */
export function serverParts(
  catalog: DeskCatalog | undefined,
  ref: string | undefined,
): { show: string; name: string }[] {
  const group = catalog?.groups.find((g) => g.key === ref && g.key.startsWith('server:'));
  return (group?.items ?? []).map((i) => ({ show: i.opts.show ?? '', name: i.name }));
}

type OnPage = Pick<DeskCatalogItem, 'type' | 'ref' | 'opts'>;

/**
 * A view's name out of its group, as a search lists it: the editor's name (`catalogName`), with the connection's name in
 * front of a panel's own (“Plex · Now playing”, “Fusebox · Limits now”), since a search's rows are under no group.
 */
export function catalogViewName(
  group: Pick<DeskCatalogGroup, 'key' | 'label' | 'thing'>,
  item: DeskCatalogItem,
) {
  const name = catalogName(group, item);
  return item.type === 'panel' && group.thing && !isAccountGroup(group) ? `${group.label} · ${name}` : name;
}

/** A row of *Add a widget* (DK-163). */
export interface CatalogEntry {
  /** The service's group key, or the view's own (`catalogItemKey`). */
  key: string;
  group: DeskCatalogGroup;
  /** What adding it adds: a service's main view (its group's first item), else the view itself. */
  item: DeskCatalogItem;
  /** “Plex”, “pve-01”, “Google · anna@example.com”; a view found by a search by `catalogViewName`. */
  name: string;
  line: string;
  mark: string | undefined;
  /** A whole service (a connection or device, a server, an account), whose widget's *What it shows* offers the rest. */
  service: boolean;
  /** Something of it is on the page: any of a service's views, else this one. */
  here: boolean;
  /** The size it starts at (`def`, cells). */
  size: { w: number; h: number };
}

export interface CatalogRows {
  /** `own`, `servers`, `things` (every connection and device together), `accounts`, `widgets`. */
  key: string;
  kind: CatalogSectionKind;
  label: string;
  rows: CatalogEntry[];
}

/** Whether `w` is one of a service's widgets: any of its views (a server's by its ref, a connection's by its thing). */
function ofService(w: OnPage, group: DeskCatalogGroup, main: DeskCatalogItem): boolean {
  const ref = group.thing ?? main.ref;
  return !!ref && w.ref === ref && (w.type === main.type || (w.type !== 'server' && main.type !== 'server'));
}

/**
 * A service's line: its main view's, but a connection's or device's main view is its figures, whose line is the same
 * for every one (“Its main figures”), so one with more views says which (“Now playing · Recently added · Library”).
 */
function serviceLine(group: DeskCatalogGroup, main: DeskCatalogItem): string {
  const more = group.items.slice(1).map((i) => i.name);
  return main.type === 'figures' && more.length > 0 ? more.join(' · ') : main.line;
}

/** Whether a section's groups are services, listed once each: a server's own group, a connection's, an account's. */
const listsServices = (kind: CatalogSectionKind, group: DeskCatalogGroup) =>
  kind === 'thing' || kind === 'accounts' || (kind === 'servers' && group.key.startsWith('server:'));

/**
 * *Add a widget*'s sections and rows (DK-163). Without a search: Whombat's own and the assistant's Home widgets one row
 * each; every server, connection or device and account once, by its name and mark with its main view's line and size,
 * the connections and devices under one heading where the first of them was. With a search (`query`): every view whose
 * name, line, group or section has it, by its name out of its group (`catalogViewName`), so a view is offered
 * directly. A group listed only partly (`partial`) is found by the views it listed. `onPage`: the open page's widgets.
 */
export function catalogRows(
  catalog: DeskCatalog | undefined,
  query = '',
  onPage: readonly OnPage[] = [],
): CatalogRows[] {
  const q = query.trim().toLowerCase();
  const out: CatalogRows[] = [];
  let things: CatalogRows | null = null;
  const sizeAt = (item: DeskCatalogItem) => {
    const def = sizeOf(item, item.view).def;
    return { w: def[0], h: def[1] };
  };
  for (const section of catalogSections(catalog)) {
    const rows: CatalogEntry[] = [];
    for (const group of section.groups) {
      const main = group.items[0];
      if (!q && main && listsServices(section.kind, group)) {
        rows.push({
          key: group.key,
          group,
          item: main,
          name: group.label,
          line: serviceLine(group, main),
          mark: group.mark ?? main.mark,
          service: true,
          here: onPage.some((w) => ofService(w, group, main)),
          size: sizeAt(main),
        });
        continue;
      }
      for (const item of group.items) {
        const name = catalogViewName(group, item);
        if (
          q &&
          ![name, item.name, item.line, group.label, section.label].join('\n').toLowerCase().includes(q)
        )
          continue;
        rows.push({
          key: catalogItemKey(item),
          group,
          item,
          name,
          line: item.line,
          mark: item.mark ?? group.mark,
          service: false,
          here: onPage.some((w) => sameWidget(w, item)),
          size: sizeAt(item),
        });
      }
    }
    if (rows.length === 0) continue;
    if (section.kind === 'thing') {
      if (!things) {
        things = { key: 'things', kind: 'thing', label: DESK_SCREENS_TEXT.editor.connections, rows: [] };
        out.push(things);
      }
      things.rows.push(...rows);
      continue;
    }
    out.push({ key: section.key, kind: section.kind, label: section.label, rows });
  }
  return out;
}

/**
 * The group a widget's *What it shows* chooses in (DK-164): a server widget's server, a connection's or device's, an
 * account's; null for Whombat's own, the assistant's Home widgets and a server of an older runtime's single group.
 */
export function catalogGroupOf(
  catalog: DeskCatalog | undefined,
  w: Pick<DeskCatalogItem, 'type' | 'ref'>,
): DeskCatalogGroup | null {
  if (!w.ref) return null;
  if (w.type === 'server') return catalog?.groups.find((g) => g.key === w.ref) ?? null;
  if (w.type !== 'figures' && w.type !== 'panel') return null;
  return catalog?.groups.find((g) => g.thing === w.ref || (isAccountGroup(g) && g.key === w.ref)) ?? null;
}
