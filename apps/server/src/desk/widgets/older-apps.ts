/**
 * What an older app can't read (docs/decisions/desk-display.md DK-161): an app at session protocol minor 1 parses a
 * screen's views and *Add a widget* with the 3.6 contract, which has no `photo` or `board` views and no `account:`
 * refs, and refuses a whole answer with one it doesn't know. So its answers leave those out — its editor shows such a
 * widget empty until the app is updated — and a newer app gets everything.
 */
import type { DeskCatalogGroup, DeskWidgetView } from '@whombat/core';

/** The protocol minor that reads `photo`, `board` and accounts' widgets. */
export const PHOTO_BOARD_ACCOUNTS_MINOR = 2;

const NEW_VIEWS: ReadonlySet<string> = new Set(['photo', 'board']);

/**
 * Whether a session at `minor` reads them; outside a session (`undefined`), it does. Every app of session major 5
 * (contracts 4.0) reads them, whatever its minor: the minor counts again from 0 within the new major.
 */
export const readsNewWidgets = (_minor: number | undefined) => true;

/** A screen's views as an app at `minor` reads them. */
export function viewsFor<V extends Pick<DeskWidgetView, 'kind'>>(
  views: readonly V[],
  minor: number | undefined,
): V[] {
  return readsNewWidgets(minor) ? [...views] : views.filter((v) => !NEW_VIEWS.has(v.kind));
}

/** *Add a widget* as an app at `minor` reads it: no accounts' groups, nothing drawn as a photo or a board. */
export function catalogFor(
  groups: readonly DeskCatalogGroup[],
  minor: number | undefined,
): DeskCatalogGroup[] {
  if (readsNewWidgets(minor)) return [...groups];
  return groups
    .filter((g) => !g.key.startsWith('account:') && !g.thing?.startsWith('account:'))
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.view || !NEW_VIEWS.has(i.view)) }));
}
