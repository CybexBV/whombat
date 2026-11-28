/**
 * Where the connections' pages are (settings-groups.md, sidebar-tabs.md): at `/connections` — Add a connection, a
 * catalog entry's page, Google's, Microsoft's and Email's (`/connections?connection=…`) — or in Settings (the
 * Connections tab's list; GitHub and Website feedback under Advanced). A page's “back” goes to the Connections list
 * (`/connected`, servers-connections-places.md) or to Settings, where it was opened from.
 */
import { placeWords } from '@whombat/client';
import { createContext, useContext } from 'react';
import { currentLocale } from '../../i18n/provider';

export type ConnectionsHome = 'connections' | 'settings';

const Home = createContext<ConnectionsHome>('settings');

export const ConnectionsHomeProvider = Home.Provider;

/** A link's `to` and `search`, spread on a router `Link` (`{...(link as never)}`). */
export interface ConnectionsLink {
  to: '/connections' | '/connected' | '/settings';
  search: Record<string, string>;
}

/** Add a connection, on the Connections page wherever it is opened from. */
export const ADD_CONNECTION_LINK: ConnectionsLink = { to: '/connections', search: { connection: 'add' } };

/** The way back to everything connected: the Connections list, or Settings → Connections. */
export function useConnectionsBack(): { link: ConnectionsLink; label: string } {
  return useContext(Home) === 'connections'
    ? { link: { to: '/connected', search: {} }, label: `← ${placeWords(currentLocale()).connections.title}` }
    : { link: { to: '/settings', search: { tab: 'connections' } }, label: '← All connections' };
}
