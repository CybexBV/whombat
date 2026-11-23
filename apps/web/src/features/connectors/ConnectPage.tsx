import { createLink, useRouterState } from '@tanstack/react-router';
import {
  addressReasonOf,
  addressReasonText,
  asServerNote,
  CATALOG_REASON_TEXT,
  foundServerSearch,
} from '@whombat/client/connections';
import { useCatalogConnections, useConnectionsCatalog } from '@whombat/client/react';
import { type CatalogEntry, connectAccessOf } from '@whombat/core/domain';
import { useEffect, useRef, useState } from 'react';
import { ButtonLink } from '../../components/Button';
import { SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { GitHubNotice } from '../github/GitHubNotice';
import styles from '../settings/SettingsScreen.module.css';
import { AppOAuthSetup } from './AppOAuthSetup';
import { CatalogHeader } from './CatalogHeader';
import c from './Connectors.module.css';
import { CONNECTION_CONNECT_ERROR_TEXT } from './catalog';
import { SetupForm } from './SetupForm';

const RouterButtonLink = createLink(ButtonLink);

/** What a sign-in elsewhere said when it came back (`connect_error=`), once. */
export interface CatalogOutcome {
  connectError?: string;
}

export function ConnectPage({
  burrow,
  entry,
  url,
  outcome,
  onOutcomeSeen,
  navigate: leave = (url) => window.location.assign(url),
}: {
  burrow: string;
  entry: CatalogEntry;
  /** The address to start with (`&url=`, from Found on your network; CS-51): identified at once. */
  url?: string;
  outcome?: CatalogOutcome;
  onOutcomeSeen?: () => void;
  /** Where an OAuth sign-in goes (tests); a full-page navigation by default. */
  navigate?: (url: string) => void;
}) {
  const catalog = useConnectionsCatalog({}, { retry: false });
  // The level the assistant's card chose (`&access=`, connect-in-chat.md); read as the address has it, so Settings'
  // own search stays as it is.
  const access = useRouterState({
    select: (st) => connectAccessOf((st.location.search as Record<string, unknown>).access),
  });
  const server = asServerNote(entry, url);
  const list = useCatalogConnections({ params: { burrow } });
  const status = catalog.data?.entries.find((e) => e.catalogId === entry.id);
  const [notice, setNotice] = useState<string | null>(null);
  const seen = useRef(false);

  // A sign-in elsewhere came back refused: the reason above the form, once; then off the address.
  useEffect(() => {
    if (seen.current || !outcome?.connectError) return;
    seen.current = true;
    setNotice(
      CONNECTION_CONNECT_ERROR_TEXT[outcome.connectError as keyof typeof CONNECTION_CONNECT_ERROR_TEXT] ??
        'That didn’t connect. Try again.',
    );
    onOutcomeSeen?.();
  }, [outcome, onOutcomeSeen]);

  const appMethod = entry.signIn.find((m) => m.kind === 'app_oauth');
  const appMissing = !!appMethod && status?.available === false && status.reason === 'app_not_configured';
  const address = addressReasonOf(status);

  return (
    <>
      <CatalogHeader entry={entry} back="add" />
      {appMethod && status?.app && <AppOAuthSetup entry={entry} method={appMethod} app={status.app} />}
      <section className={styles.section} aria-labelledby="connect-title">
        <SectionLabel as="h2" id="connect-title">
          CONNECT
        </SectionLabel>
        {notice && <GitHubNotice text={notice} />}
        <div className={styles.card}>
          {!list.data && !list.error ? (
            <SkeletonRows count={2} lines={2} />
          ) : status?.available === false && status.reason === 'off' ? (
            <p className={styles.empty}>{entry.name} is turned off on this Whombat.</p>
          ) : status?.available === false && status.reason === 'no_driver' ? (
            // A link to a tracker nothing here can read: the catalog doesn't offer it either.
            <p className={styles.empty}>{`${entry.name} can’t be connected on this Whombat yet.`}</p>
          ) : address ? (
            <>
              <p className={styles.empty} data-testid="connect-address-reason">
                {addressReasonText(address)}
              </p>
              {address === 'needs_secure_address' ? (
                // One way forward: REACH, where Tailscale and Whombat Link are turned on.
                <div className={c.addressAction}>
                  <RouterButtonLink
                    variant="secondary"
                    size="sm"
                    to="/settings"
                    search={{ tab: 'appliance', section: 'about' } as never}
                    hash="reach"
                    data-testid="connect-address-action"
                  >
                    {CATALOG_REASON_TEXT.needsSecureAddressAction}
                  </RouterButtonLink>
                </div>
              ) : address === 'needs_mac' ? (
                // Find My reads through a Mac: Add a server, where the Mac is added (findmy-connection.md §1.2).
                <div className={c.addressAction}>
                  <RouterButtonLink
                    variant="secondary"
                    size="sm"
                    to="/connections"
                    search={{ add: 1 } as never}
                    data-testid="connect-address-action"
                  >
                    {CATALOG_REASON_TEXT.needsMacAction}
                  </RouterButtonLink>
                </div>
              ) : null}
            </>
          ) : appMissing ? (
            <p className={styles.empty}>{`Set up the ${entry.name} app above first, then connect.`}</p>
          ) : (
            <>
              {server ? (
                <div className={c.asServer} data-as-server="">
                  <div className={c.main}>
                    <span className={c.name}>{server.title}</span>
                    <span className={c.meta}>{server.text}</span>
                  </div>
                  <RouterButtonLink
                    variant="primary"
                    size="sm"
                    to="/connections"
                    search={foundServerSearch(server.address) as never}
                  >
                    {server.label}
                  </RouterButtonLink>
                </div>
              ) : null}
              <SetupForm
                burrow={burrow}
                entry={entry}
                initialUrl={url}
                {...(access ? { initialAccess: access } : {})}
                leave={leave}
              />
            </>
          )}
        </div>
      </section>
    </>
  );
}
