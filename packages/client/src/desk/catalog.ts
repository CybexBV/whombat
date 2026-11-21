/**
 * *Add a widget*'s sections, shared by the web and the phone (Whombat desk-display.md DK-139, DK-154, DK-155): the
 * runtime's groups (`desk.widgets`) under the headings the person folds — *Whombat and {assistant}*, *Servers* with a
 * group per server, each connection or device, *Made by {assistant}* — which start folded, what two widgets showing the
 * same thing are, and an item's name in the editor. Pure.
 */
import { serverShow } from '@whombat/screen';
import { DESK_SCREEN_WORDS, type DeskCatalog, type DeskCatalogGroup, type DeskCatalogItem } from './contract';

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

/** How many items a section lists. */
export const sectionCount = (section: CatalogSection) =>
  section.groups.reduce((n, g) => n + g.items.length, 0);

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
