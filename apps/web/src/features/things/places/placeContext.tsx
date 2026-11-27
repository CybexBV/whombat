/**
 * Whether a server's or connection's page is drawn in its place (servers-connections-places.md): beside
 * the list the page has no crumb (the list is right there); alone on a narrow window its crumb goes back to the list
 * (“‹ Servers”). Outside a place (no provider, or undefined) the page keeps its own crumb to Overview.
 */
import { createContext, useContext } from 'react';

export type PlaceCrumb = { href: string; label: string } | null;

const PlaceCrumbContext = createContext<PlaceCrumb | undefined>(undefined);

export const PlaceCrumbProvider = PlaceCrumbContext.Provider;

/** The crumb a page in a place draws instead of its own: null for none, undefined outside a place. */
export function usePlaceCrumb(): PlaceCrumb | undefined {
  return useContext(PlaceCrumbContext);
}
