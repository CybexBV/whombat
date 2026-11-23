/**
 * What the Connections and Add a connection screens read (connections-redesign-android.md AP-1170, AP-1173): the
 * catalog connections (`connections.list`), the catalog's statuses (`connections.catalog`) and your Google /
 * Microsoft 365 / Email (IMAP) (`connectors.status`, CN-04: not in `connections.list`; a
 * Whombat without them just has none), GitHub and Website feedback once connected, turned into the CONNECTED rows and
 * the offered entries. Both screens share the queries' cache, so
 * opening Add a connection asks for nothing new. Where the runtime has no `connections.catalog` nothing is asked.
 */
import {
  useCatalogConnections,
  useConnectionsCatalog,
  useConnectors,
  useFeedbackIntegrations,
  useGitHubStatus,
  useRepos,
  useSessionProtocol,
} from '@whombat/client/react';
import { ACCOUNT_PAGES_MINOR, protocolAtLeast } from '@whombat/protocol/session';
import { useMemo } from 'react';
import { useBurrow } from './BurrowProvider';
import { addConnectionRows, connectedRows, feedbackRow, githubRow } from './connections';

export function useConnections() {
  const { slug } = useBurrow();
  // Fusebox and the AI gateway offered (AP-1123); the rows say only where a connection is (AP-1177).
  const list = useCatalogConnections({ params: { burrow: slug } });
  const catalog = useConnectionsCatalog({});
  const accounts = useConnectors({}, { retry: false });
  // GitHub and Website feedback are accounts too (the web's overview): rows once connected.
  const github = useGitHubStatus({ params: { burrow: slug } }, { retry: false });
  const repos = useRepos({ params: { burrow: slug } }, { retry: false });
  const feedback = useFeedbackIntegrations({ params: { burrow: slug } }, { retry: false });
  // A box at session minor 7 answers an account's page: its row opens that; an older one keeps the account's screen.
  const pages = protocolAtLeast(useSessionProtocol(), ACCOUNT_PAGES_MINOR);
  const connectedAccounts = useMemo(() => accounts.data?.connections ?? [], [accounts.data]);
  const rows = useMemo(() => {
    const repoList = repos.data;
    const builtins = [
      githubRow(
        github.data,
        repoList
          ? { connected: repoList.githubConnected, on: repoList.repos.filter((r) => r.enabled).length }
          : null,
        slug,
        pages,
      ),
      feedbackRow(feedback.data?.integrations, slug, pages),
    ];
    return connectedRows(list.data?.connections ?? [], connectedAccounts, slug, { pages, builtins });
  }, [list.data, connectedAccounts, slug, pages, github.data, repos.data, feedback.data]);
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
    void github.refetch();
    void repos.refetch();
    void feedback.refetch();
  };
  // What Add a connection waits for before it lists (AP-1173, AP-2816): the statuses (what's turned off or missing
  // here) and your accounts (whether Email (IMAP) is offered), each answered or failed.
  const settled =
    (catalog.data !== undefined || catalog.error !== null) &&
    (accounts.data !== undefined || accounts.error !== null);
  return { list, catalog, rows, offered, settled, refetch };
}
