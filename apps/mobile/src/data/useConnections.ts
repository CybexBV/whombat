/**
 * What the Connections and Add a connection screens read (connections-redesign-android.md AP-1170, AP-1173): the
 * catalog connections (`connections.list`), the catalog's statuses (`connections.catalog`) and your Google /
 * Microsoft 365 / Email (IMAP) (`connectors.status`, CN-04: not in `connections.list`; a
 * Whombat without them just has none), turned into the CONNECTED rows and the offered entries. Both screens share the queries' cache, so
 * opening Add a connection asks for nothing new. Where the runtime has no `connections.catalog` nothing is asked.
 */
import { useCatalogConnections, useConnectionsCatalog, useConnectors } from '@whombat/client/react';
import { useMemo } from 'react';
import { useBurrow } from './BurrowProvider';
import { addConnectionRows, connectedRows } from './connections';

export function useConnections() {
  const { slug } = useBurrow();
  // Fusebox and the AI gateway offered (AP-1123); the rows say only where a connection is (AP-1177).
  const list = useCatalogConnections({ params: { burrow: slug } });
  const catalog = useConnectionsCatalog({});
  const accounts = useConnectors({}, { retry: false });
  const connectedAccounts = useMemo(() => accounts.data?.connections ?? [], [accounts.data]);
  const rows = useMemo(
    () => connectedRows(list.data?.connections ?? [], connectedAccounts, slug),
    [list.data, connectedAccounts, slug],
  );
  const offered = useMemo(
    () =>
      addConnectionRows(
        catalog.data?.entries,
        rows.map((r) => r.catalogId),
        slug,
        // Email (IMAP) where this Whombat offers it (absent from an older one, CT-482; AP-2816).
        { gateway: true, imap: accounts.data?.imap?.available === true },
      ),
    [catalog.data, rows, slug, accounts.data],
  );
  const refetch = () => {
    void list.refetch();
    void catalog.refetch();
    void accounts.refetch();
  };
  // What Add a connection waits for before it lists (AP-1173, AP-2816): the statuses (what's turned off or missing
  // here) and your accounts (whether Email (IMAP) is offered), each answered or failed.
  const settled =
    (catalog.data !== undefined || catalog.error !== null) &&
    (accounts.data !== undefined || accounts.error !== null);
  return { list, catalog, rows, offered, settled, refetch };
}
