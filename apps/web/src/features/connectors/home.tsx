/**
 * Where the connections' pages are (settings-groups.md, sidebar-tabs.md): at Overview's address — Add a connection, a
 * catalog entry's page, Google's, Microsoft's and Email's (`/connections?connection=…`) — or in Settings (the
 * Connections tab's list; GitHub and Website feedback under Advanced). A page's “back” goes home to where it is shown.
 */
import { createContext, useContext } from 'react';
import { CHAT_WORDS } from '../../i18n/shared';

export type ConnectionsHome = 'connections' | 'settings';

const Home = createContext<ConnectionsHome>('settings');

export const ConnectionsHomeProvider = Home.Provider;

/** A link's `to` and `search`, spread on a router `Link` (`{...(link as never)}`). */
export interface ConnectionsLink {
  to: '/connections' | '/settings';
  search: Record<string, string>;
}

/** Add a connection, on the Connections page wherever it is opened from. */
export const ADD_CONNECTION_LINK: ConnectionsLink = { to: '/connections', search: { connection: 'add' } };

/** The way back to everything connected: Overview, or Settings → Connections. */
export function useConnectionsBack(): { link: ConnectionsLink; label: string } {
  return useContext(Home) === 'connections'
    ? { link: { to: '/connections', search: {} }, label: `← ${CHAT_WORDS.dashboard}` }
    : { link: { to: '/settings', search: { tab: 'connections' } }, label: '← All connections' };
}
