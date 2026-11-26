import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import type { SettingsSearch } from '../../app/routing/search';
import { ConnectionsHomeProvider } from '../connectors/home';
import { ConnectionsTab } from './ConnectionsTab';
import styles from './SettingsScreen.module.css';

/**
 * The connections' pages on the Connections page (`/connections?connection=…`; settings-groups.md): Add
 * a connection (`connection=add`, `&found=1` at On your network), a catalog entry's page (`&url=` from the network
 * scan, `&id=` one of its connections), and Google's, Microsoft's and Email's. A sign-in elsewhere comes back here with
 * its answer (`connected=`, `connect_error=`), shown once. Every “back” on them goes to the Connections page.
 */
export function ConnectionsPages({ burrow, search }: { burrow: string; search: SettingsSearch }) {
  const navigate = useNavigate();
  const outcome =
    search.connected || search.connect_error
      ? { connected: search.connected, connectError: search.connect_error }
      : undefined;
  // The page stays open once its answer is off the address (AP-673).
  const onOutcomeSeen = useCallback(
    () =>
      void navigate({
        to: '/connections',
        search: { connection: search.connection ?? 'google', ...(search.id ? { id: search.id } : {}) },
        replace: true,
      } as never),
    [navigate, search.connection, search.id],
  );
  return (
    <ConnectionsHomeProvider value="connections">
      <div className={styles.scroll}>
        <div className={styles.page} data-connections-page={search.connection ?? ''}>
          <div className={styles.panel}>
            <ConnectionsTab
              burrow={burrow}
              provider={search.connection}
              connectionId={search.id}
              url={search.url}
              access={search.access}
              returnTo={search.returnTo}
              found={search.found === true}
              outcome={outcome}
              onOutcomeSeen={onOutcomeSeen}
            />
          </div>
        </div>
      </div>
    </ConnectionsHomeProvider>
  );
}
