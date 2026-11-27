import { Link } from '@tanstack/react-router';
import { ApiError, IMAP_COPY, InvalidRequestError, imapAvailable, mailAccountLine } from '@whombat/client';
import {
  useCatalogConnections,
  useCheckConnection,
  useConnectionsCatalog,
  useConnectors,
  useFeedbackIntegrations,
  useGitHubStatus,
  useRemoveConnection,
  useRemoveGoogleApp,
  useRepos,
  useSessionProtocol,
  useSetGoogleApp,
} from '@whombat/client/react';
import { thingHref } from '@whombat/core';
import {
  type AccountPageId,
  CONNECTOR_PROVIDERS,
  CONNECTOR_SERVICES,
  type Connection,
  type ConnectionAccessLevel,
  type ConnectorProvider,
  type ConnectorService,
  type ConnectorsStatus,
  clientIdHint,
  FEEDBACK_THING_ID,
  GITHUB_THING_ID,
  type GoogleUserType,
  isAccountPageId,
  NEW_CLIENT_NEEDS_SECRET_TEXT,
  serviceLabel,
} from '@whombat/core/domain';
import { formatAgo } from '@whombat/core/text';
import { ACCOUNT_PAGES_MINOR, protocolAtLeast } from '@whombat/protocol/session';
import { type DragEvent, type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { useOpenBurrow } from '../../app/routing/openBurrow';
import type { ConnectionPage, ConnectionsPage } from '../../app/routing/search';
import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { ErrorNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { type DotTone, StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import { useWebI18n, type WebMessageKey } from '../../i18n/provider';
import { AccountKeys } from '../connectors/AccountKeys';
import {
  availableState,
  builtinDescription,
  type CatalogOverview,
  type CatalogTile,
  type ConnectionEntry,
  ConnectionsOverview,
  connectionName,
  ProviderLogo,
} from '../connectors/ConnectionsOverview';
import c from '../connectors/Connectors.module.css';
import { ConnectPage } from '../connectors/ConnectPage';
import {
  type CatalogRow,
  CONNECTABLE,
  catalogRows,
  catalogTileFor,
  connectableEntry,
} from '../connectors/catalog';
import {
  checkText,
  connectErrorText,
  parseClientSecretFile,
  REAUTH_TEXT,
  redirectMismatchText,
  serviceList,
} from '../connectors/copy';
import { useConnectionsBack } from '../connectors/home';
import { ImapConnection } from '../connectors/ImapConnection';
import { MicrosoftConnection } from '../connectors/MicrosoftConnection';
import { ServicePicker } from '../connectors/ServicePicker';
import { googleConnectable, useConnectGoogle, useConnectorsStatus } from '../connectors/useConnectGoogle';
import { useConnectionWords } from '../connectors/useConnectionWords';
import { FeedbackTab } from '../feedback';
import { reportsLine } from '../feedback/copy';
import { GitHubNotice } from '../github/GitHubNotice';
import { ReposTab } from './ReposTab';
import styles from './SettingsScreen.module.css';

/**
 * What a sign-in elsewhere said when it came back, once: Google's or Microsoft's (`?connected=google` /
 * `?connect_error=<code>`), or a catalog entry's (`connected=homeassistant`, `ConnectionConnectError` codes; CX-15).
 */
export interface ConnectOutcome {
  connected?: string;
  connectError?: string;
}

export interface ConnectionsTabProps {
  burrow: string;
  /**
   * The page that is open (`&connection=`): GitHub, Google, Microsoft, Website feedback, or a catalog entry's connect page
   * (CX-71); the overview without.
   */
  provider?: ConnectionsPage;
  /** A catalog connection's page (`&id=con_…`, CX-72). */
  connectionId?: string;
  /** The address a catalog entry's connect page starts with (`&url=`, from Found on your network; AP-846). */
  url?: string;
  /** The access level chosen by the assistant's card (`&access=read|manage`). */
  access?: ConnectionAccessLevel;
  /** Where to return once connected (`&returnTo=`). */
  returnTo?: string;
  /** Add a connection opened at On your network (`&found=1`, the assistant's link; Whombat desk-found.md DF-05, AP-3801). */
  found?: boolean;
  outcome?: ConnectOutcome;
  /** Drops the outcome from the URL after it was shown. */
  onOutcomeSeen?: () => void;
  /** Where “Connect” goes (tests); a full-page navigation by default. */
  navigate?: (url: string) => void;
}

/**
 * Settings → Connections (docs/decisions/connectors.md CN-02…CN-06, settings-simplify.md SS-05; not in the mocks,
 * B-05): the overview of what is connected and what can be added (`ConnectionsOverview`, AP-673) and each one's page:
 * GitHub (`&connection=github`, the old Repositories tab without the working directory: sign-in, repositories, new
 * repository), Google (`&connection=google`: GOOGLE APP, the OAuth app of this Whombat with the guided setup, and
 * YOUR ACCOUNTS, the person's own connection), Microsoft, and Website feedback (`&connection=feedback`, the
 * old Feedback tab: the integrations; their own pages stay at `settings/feedback/…`). Google's answer after connecting
 * (`connected=`, `connect_error=`) opens Google's page.
 */
export function ConnectionsTab({
  burrow,
  provider,
  connectionId,
  url,
  access,
  returnTo,
  found = false,
  outcome,
  onOutcomeSeen,
  navigate,
}: ConnectionsTabProps) {
  const open = provider ?? outcome?.connected ?? (outcome?.connectError ? 'google' : undefined);
  const accountPages = protocolAtLeast(useSessionProtocol(), ACCOUNT_PAGES_MINOR);
  // A sign-in that came back with an error keeps this page: its reason and the fixes are here, not on the account's.
  const failed = useRef(false);
  if (outcome?.connectError) failed.current = true;
  // A catalog entry's pages (CX-71, CX-72; AP-756, AP-757).
  const entry = connectableEntry(open);
  // A connection has its own page (connection-pages.md CP-01, CP-18): its Settings tab.
  if (entry && connectionId)
    return (
      <ToThingPage entry={entry} connectionId={connectionId} connected={outcome?.connected === entry.id} />
    );
  if (entry)
    return (
      <ConnectPage
        key={`${entry.id} ${url ?? ''}`}
        burrow={burrow}
        entry={entry}
        url={url}
        access={access}
        returnTo={returnTo}
        outcome={outcome}
        onOutcomeSeen={onOutcomeSeen}
        navigate={navigate}
      />
    );
  if (isAccountPageId(open)) {
    const settings = (
      <AccountSettings
        burrow={burrow}
        account={open}
        outcome={outcome}
        onOutcomeSeen={onOutcomeSeen}
        navigate={navigate}
      />
    );
    // A box with accounts' own pages: a connected account's Settings address opens its page instead.
    return accountPages && !failed.current ? (
      <ToAccountPage burrow={burrow} account={open} connected={outcome?.connected === open}>
        {settings}
      </ToAccountPage>
    ) : (
      settings
    );
  }
  return (
    <ConnectorPages
      burrow={burrow}
      head={null}
      provider={undefined}
      adding={open === 'add'}
      found={found}
      outcome={outcome}
      onOutcomeSeen={onOutcomeSeen}
      navigate={navigate}
    />
  );
}

export interface AccountSettingsProps {
  burrow: string;
  account: AccountPageId;
  /**
   * Drawn inside the account's own page (its Connection tab): without the way back and the logo-and-name header, which
   * the page's head has.
   */
  embedded?: boolean;
  outcome?: ConnectOutcome;
  onOutcomeSeen?: () => void;
  navigate?: (url: string) => void;
}

/**
 * An account's settings: GitHub's (sign-in, repositories), Website feedback's (its sites), Google's (the app's setup,
 * the account, its services, what the assistant may do), Microsoft 365's and Email's. Its page on Settings → Connections,
 * and its own page's Connection tab.
 */
export function AccountSettings({
  burrow,
  account,
  embedded = false,
  outcome,
  onOutcomeSeen,
  navigate,
}: AccountSettingsProps) {
  // Inside its page: the page goes once the account is disconnected, so its Settings page opens to connect again.
  const head = embedded ? (
    <LeaveWhenDisconnected burrow={burrow} account={account} />
  ) : (
    <ProviderHeader provider={account} />
  );
  if (account === 'github')
    return (
      <>
        {head}
        <ReposTab burrow={burrow} />
      </>
    );
  if (account === 'feedback')
    return (
      <>
        {head}
        <FeedbackTab burrow={burrow} />
      </>
    );
  return (
    <ConnectorPages
      burrow={burrow}
      head={head}
      provider={account}
      adding={false}
      outcome={outcome}
      onOutcomeSeen={onOutcomeSeen}
      navigate={navigate}
    />
  );
}

/** On the account's own page: once the account it showed is disconnected, its Settings page (Connect) in its place. */
function LeaveWhenDisconnected({ burrow, account }: { burrow: string; account: AccountPageId }) {
  const { thing } = useAccountThing(burrow, account);
  const navigate = useNavigateHref();
  const seen = useRef(false);
  useEffect(() => {
    if (thing) seen.current = true;
    else if (seen.current) navigate(`/connections?connection=${account}`, { replace: true });
  }, [thing, account, navigate]);
  return null;
}

/** What an account's thing is (`connection:con_…`, GitHub's, Website feedback's), or null while it isn't connected. */
export interface AccountThing {
  /** Still reading whether it is connected. */
  loading: boolean;
  thing: string | null;
  /** The account's address, for the toast after a sign-in (“Google connected: mara@example.com.”). */
  email: string | null;
}

/**
 * An account's thing, as the box names it: Google's, Microsoft 365's and Email's by the person's connection
 * (`connectors.status`), GitHub's while the Whombat is connected to GitHub, Website feedback's while it has a site.
 */
export function useAccountThing(burrow: string, account: AccountPageId): AccountThing {
  // Only what this account needs is read (a hook given null waits); the same reads as its Settings page.
  const builtIn = account === 'github' || account === 'feedback';
  const status = useConnectors(builtIn ? null : {}, { retry: false });
  const on = account === 'github' ? { params: { burrow } } : null;
  const github = useGitHubStatus(on);
  const repos = useRepos(on);
  const feedback = useFeedbackIntegrations(account === 'feedback' ? { params: { burrow } } : null, {
    retry: false,
  });
  if (account === 'github') {
    const connected = github.data?.connected ?? repos.data?.githubConnected;
    // Either answer is enough; both failing leaves the Settings page as it is.
    const loading = connected === undefined && (github.isLoading || repos.isLoading);
    return { loading, thing: connected ? GITHUB_THING_ID : null, email: null };
  }
  if (account === 'feedback') {
    const sites = feedback.data?.integrations.length ?? 0;
    return { loading: feedback.isLoading, thing: sites > 0 ? FEEDBACK_THING_ID : null, email: null };
  }
  const conn = status.data?.connections.find((c) => c.provider === account) ?? null;
  return {
    loading: status.isLoading,
    thing: conn ? `connection:${conn.id}` : null,
    email: conn?.email ?? null,
  };
}

/**
 * A connected account's Settings address on a box with accounts' own pages: its page's Connection tab instead, in
 * place of this address; just connected through a sign-in elsewhere, its Summary, with the toast this page said. Not
 * connected (or Google's app still to set up): this page, as it is, for the whole visit, so connecting here (Email's
 * form, GitHub's sign-in) doesn't take the page away mid-step.
 */
function ToAccountPage({
  burrow,
  account,
  connected,
  children,
}: {
  burrow: string;
  account: AccountPageId;
  connected: boolean;
  children: ReactNode;
}) {
  const { loading, thing, email } = useAccountThing(burrow, account);
  const navigate = useNavigateHref();
  const toast = useToast();
  // Decided once, by the first answer: the page, or this page for the rest of the visit.
  const stay = useRef<boolean | null>(null);
  if (stay.current === null && !loading) stay.current = !thing;
  const go = stay.current === false;
  const done = useRef(false);
  useEffect(() => {
    if (!go || !thing || done.current) return;
    done.current = true;
    if (connected) {
      const name = connectionName(account);
      toast.show(email ? `${name} connected: ${email}.` : `${name} connected.`);
    }
    navigate(`/things/${encodeURIComponent(thing)}${connected ? '' : '?tab=settings'}`, { replace: true });
  }, [go, thing, connected, account, email, navigate, toast]);
  if (go) return null;
  if (stay.current === null)
    return (
      <div className={styles.card}>
        <SkeletonRows count={3} lines={2} />
      </div>
    );
  return children;
}

/**
 * A connection's Settings page on a runtime with things' own pages (connection-pages-web.md AP-1900…): its page's
 * Settings tab instead, in place of this address; just connected through a sign-in elsewhere, its Overview, with the
 * toast the Settings page said.
 */
function ToThingPage({
  entry,
  connectionId,
  connected,
}: {
  entry: { name: string };
  connectionId: string;
  connected: boolean;
}) {
  const navigate = useNavigateHref();
  const toast = useToast();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    if (connected) toast.show(`${entry.name} connected.`);
    navigate(`${thingHref('connection', connectionId)}${connected ? '' : '?tab=settings'}`, {
      replace: true,
    });
  }, [connected, connectionId, entry.name, navigate, toast]);
  return null;
}

/** The overview, or a connector provider's page (Google, Microsoft): both read the connectors' status first. */
function ConnectorPages({
  burrow,
  head,
  provider: open,
  adding,
  found = false,
  outcome,
  onOutcomeSeen,
  navigate,
}: Omit<ConnectionsTabProps, 'provider'> & {
  /** A provider's page header (the way back, its logo and name); none inside the account's own page. */
  head: ReactNode;
  provider: ConnectorProvider | undefined;
  /** Add a connection (`&connection=add`, AP-1157): the overview's catalog on its own page. */
  adding: boolean;
}) {
  const query = useConnectorsStatus();
  const status = query.data;
  // A sign-in that failed keeps the setup and the troubleshooting open, with its reason, after its answer left the
  // address.
  const failed = useRef(false);
  if (outcome?.connectError) failed.current = true;

  const loading = (
    <div className={styles.card}>
      <SkeletonRows count={3} lines={2} />
    </div>
  );
  // The overview lists GitHub and Website feedback without the connectors' status too (a server without connectors).
  if (!open)
    return status || query.error ? (
      <Overview burrow={burrow} status={status} adding={adding} found={found} />
    ) : (
      loading
    );
  if (query.error && !status) {
    return (
      <ErrorNote
        message="Couldn’t load your connections. Try again in a moment."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!status) return loading;
  if (open === 'imap')
    return (
      <>
        {head}
        <ImapConnection status={status} />
      </>
    );
  if (open === 'microsoft')
    return (
      <>
        {head}
        <MicrosoftConnection
          burrow={burrow}
          status={status}
          navigate={navigate}
          outcome={outcome}
          onOutcomeSeen={onOutcomeSeen}
        />
      </>
    );
  const accounts = (
    <YourAccountsSection
      burrow={burrow}
      status={status}
      outcome={outcome}
      onOutcomeSeen={onOutcomeSeen}
      navigate={navigate}
    />
  );
  // While Google works, the page is the account (#28): the app's plumbing folds under Technical details and the
  // troubleshooting waits for a sign-in that failed.
  const google = status.connections.find((conn) => conn.provider === 'google');
  const keys = google ? <AccountKeys burrow={burrow} account="Google" services={google.services} /> : null;
  if (googleWorks(status, outcome) && !failed.current)
    return (
      <>
        {head}
        {accounts}
        {keys}
        <GoogleAppSection status={status} folded />
      </>
    );
  return (
    <>
      {head}
      <GoogleAppSection status={status} />
      {accounts}
      {keys}
      {status.mode !== 'off' && <Troubleshooting status={status} />}
    </>
  );
}

function Overview({
  burrow,
  status,
  adding,
  found,
}: {
  burrow: string;
  status: ConnectorsStatus | undefined;
  adding: boolean;
  /** Add a connection at On your network (`&found=1`, AP-3801). */
  found: boolean;
}) {
  const entries = useConnectionEntries(burrow, status);
  const catalog = useCatalogOverview(burrow);
  // The catalog's rows and tiles arrive with the rest: the overview doesn't change its layout under the pointer.
  if (catalog === undefined)
    return (
      <div className={styles.card}>
        <SkeletonRows count={3} lines={2} />
      </div>
    );
  return (
    <ConnectionsOverview
      burrow={burrow}
      entries={entries}
      catalog={catalog}
      canScan
      adding={adding}
      found={found}
    />
  );
}

/**
 * The catalog's part of the overview (CX-70, AP-755): the connections as rows, and
 * a tile for every entry (any number of the same one may be connected, CX-05); undefined while they load. The rows say
 * only where a connection is (AP-1177): who looks after it and a gateway's tools are on its page.
 */
function useCatalogOverview(burrow: string): CatalogOverview | undefined {
  const catalog = useConnectionsCatalog({}, { retry: false });
  const list = useCatalogConnections({ params: { burrow } }, { retry: false });
  if ((!list.data && !list.error) || (!catalog.data && !catalog.error)) return undefined;
  const rows: CatalogRow[] = catalogRows(list.data?.connections ?? []);
  const tiles: CatalogTile[] = [];
  for (const entry of CONNECTABLE) {
    const state = catalogTileFor(catalog.data?.entries, entry.id);
    if (!state) continue;
    tiles.push({
      catalogId: entry.id,
      name: entry.name,
      description: entry.description,
      category: entry.category,
      action: state.action,
      note: state.note,
      ...(state.addServer ? { addServer: true } : {}),
    });
  }
  return { rows, tiles };
}

/**
 * The overview's entries, in order (SS-05): GitHub (connected for the burrow, with its login and how many repositories
 * are on), Google and Microsoft (the viewer's own account), Website feedback (its integrations; only where the
 * Whombat has Feedback).
 */
function useConnectionEntries(burrow: string, status: ConnectorsStatus | undefined): ConnectionEntry[] {
  const github = useGitHubStatus({ params: { burrow } });
  const repos = useRepos({ params: { burrow } });
  const feedback = useFeedbackIntegrations({ params: { burrow } }, { retry: false });
  const entries: ConnectionEntry[] = [];

  const gh = github.data;
  const ghConnected = gh?.connected ?? repos.data?.githubConnected ?? false;
  const on = (repos.data?.repos ?? []).filter((r) => r.enabled).length;
  entries.push({
    page: 'github',
    connected: ghConnected
      ? {
          detail: gh?.login ? `@${gh.login}` : null,
          meta: on === 1 ? '1 repository on' : `${on} repositories on`,
          ok: !gh?.error,
          state: gh?.error ? 'Needs attention' : 'Connected',
          thing: GITHUB_THING_ID,
        }
      : null,
    tile:
      gh?.mode === 'off'
        ? { action: 'View', note: 'GitHub is turned off on this Whombat.' }
        : gh
          ? { action: 'Connect', note: null }
          : { action: 'View', note: null },
  });

  // Microsoft 365 and Email (IMAP) where this Whombat has them (connections-more-web.md AP-2765).
  const providers = status
    ? CONNECTOR_PROVIDERS.filter(
        (x) => (x !== 'microsoft' || !!status.microsoft) && (x !== 'imap' || imapAvailable(status)),
      )
    : [];
  for (const p of providers) {
    if (!status) break;
    const conn = status.connections.find((x) => x.provider === p);
    const active = conn?.status === 'active';
    entries.push({
      page: p,
      connected: conn
        ? {
            detail: conn.email,
            meta:
              p === 'imap'
                ? mailAccountLine(conn)
                : active
                  ? serviceList(conn.services, p)
                  : REAUTH_TEXT[conn.reauthReason ?? 'revoked'],
            ok: active,
            state: active
              ? 'Connected'
              : p === 'imap'
                ? IMAP_COPY.needsPassword
                : 'Needs you to sign in again',
            thing: `connection:${conn.id}`,
          }
        : null,
      tile: availableState(p, status),
    });
  }

  const list = feedback.data?.integrations ?? [];
  entries.push({
    page: 'feedback',
    connected:
      list.length > 0
        ? {
            detail: list.length === 1 ? (list[0]?.integration.name ?? null) : `${list.length} integrations`,
            plain: true,
            meta: reportsLine(list.reduce((n, { health }) => n + health.reportsLast24h, 0)),
            ok: list.every(({ health }) => health.warnings.length === 0),
            state: list.some(({ health }) => health.warnings.length > 0) ? 'Needs attention' : 'On',
            thing: FEEDBACK_THING_ID,
          }
        : null,
    tile: { action: 'Set up', note: null },
  });

  return entries;
}

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A page starts with the way back to the overview, then its logo, name and what it brings (AP-673). */
function ProviderHeader({ provider }: { provider: ConnectionPage }) {
  // GitHub's line names the assistant in the assistant shell (less-is-more.md AP-1802).
  const words = useConnectionWords(useOpenBurrow());
  const home = useConnectionsBack();
  return (
    <>
      <Link to={home.link.to} search={home.link.search as never} className={c.back}>
        {home.label}
      </Link>
      <div className={c.providerHead}>
        <ProviderLogo provider={provider} size={48} />
        <span className={c.main}>
          <h2 className={c.providerTitle}>{connectionName(provider)}</h2>
          <span className={c.meta}>{builtinDescription(provider, words)}</span>
        </span>
      </div>
    </>
  );
}

/* GOOGLE -------------------------------------------------------------------------------------------- */

const AUDIENCE_LABEL: Record<GoogleUserType, WebMessageKey> = {
  external: 'settings.google.audienceExternal',
  internal: 'settings.google.audienceInternal',
};

/** Google works: its app is set up and tested, every Google account is connected, and no sign-in just failed. */
export function googleWorks(status: ConnectorsStatus, outcome?: ConnectOutcome): boolean {
  const accounts = status.connections.filter((x) => x.provider === 'google');
  return (
    status.mode !== 'off' &&
    status.google.app.configured &&
    status.google.tested &&
    accounts.length > 0 &&
    accounts.every((x) => x.status === 'active') &&
    !outcome?.connectError
  );
}

function GoogleAppSection({ status, folded = false }: { status: ConnectorsStatus; folded?: boolean }) {
  const { t } = useWebI18n();
  const { app } = status.google;
  const off = status.mode === 'off';
  const guided = app.source !== 'config' && !off;
  const done = app.configured && status.google.tested;
  const [showSteps, setShowSteps] = useState(!done);
  const [details, setDetails] = useState(false);
  const stepsId = useId();
  if (folded)
    return (
      <section className={styles.section} id="google-app" aria-labelledby={`${stepsId}-label`}>
        <SectionLabel as="h2" id={`${stepsId}-label`}>
          {t('settings.google.label')}
        </SectionLabel>
        <div className={styles.card}>
          <div className={styles.row}>
            <StatusDot tone="ok" size={8} label={t('settings.google.setUp')} />
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{t('settings.google.setUpHere')}</span>
              {details ? (
                <span className={styles.rowMeta}>
                  {t('settings.google.clientId', { id: app.clientIdHint ?? '' })}
                  {app.userType ? ` · ${t(AUDIENCE_LABEL[app.userType])}` : ''}
                </span>
              ) : null}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className={c.toggleSteps}
              aria-expanded={details}
              aria-controls={stepsId}
              onClick={() => setDetails((v) => !v)}
            >
              {details ? t('settings.google.hideDetails') : t('settings.google.details')}
            </Button>
          </div>
          {details && guided ? (
            <div id={stepsId}>
              <GoogleSetupSteps status={status} />
            </div>
          ) : null}
        </div>
      </section>
    );

  const clientId = t('settings.google.clientId', { id: app.clientIdHint ?? '' });
  const summary = off
    ? t('settings.google.off')
    : app.source === 'config'
      ? `${t('settings.google.inConfig')} · ${clientId}`
      : app.configured
        ? `${t('settings.google.setUp')} · ${clientId}${app.userType ? ` · ${t(AUDIENCE_LABEL[app.userType])}` : ''}`
        : t('settings.google.intro');

  return (
    <section className={styles.section}>
      <SectionLabel as="h2">{t('settings.google.label')}</SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <StatusDot
            tone={app.configured && !off ? 'ok' : 'mut'}
            size={8}
            label={app.configured && !off ? t('settings.google.setUp') : t('settings.google.notSetUp')}
          />
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{t('settings.google.forThisWhombat')}</span>
            <span className={styles.rowMeta}>{summary}</span>
          </span>
          {guided && done && (
            <Button
              variant="ghost"
              size="sm"
              className={c.toggleSteps}
              aria-expanded={showSteps}
              aria-controls={stepsId}
              onClick={() => setShowSteps((v) => !v)}
            >
              {showSteps ? t('settings.google.hideSteps') : t('settings.google.showSteps')}
            </Button>
          )}
        </div>
        {status.mode === 'fake' && (
          <div className={styles.noticeRow}>
            <GitHubNotice tone="neutral" text={t('settings.google.fake')} command="WHOMBAT_GOOGLE=real" />
          </div>
        )}
        {off && (
          <div className={styles.noticeRow}>
            <GitHubNotice tone="neutral" text={t('settings.google.turnedOff')} command="WHOMBAT_GOOGLE=off" />
          </div>
        )}
        {guided && (showSteps || !done) && (
          <div id={stepsId}>
            <GoogleSetupSteps status={status} />
          </div>
        )}
      </div>
    </section>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const { t } = useWebI18n();
  return (
    <a className={c.externalLink} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <Icon name="external" size={13} />
      <span className={c.srOnly}> {t('settings.google.newTab')}</span>
    </a>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useWebI18n();
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
      <CopyButton text={value} copied={t('settings.google.copied', { label })} className={c.copyButton}>
        {t('common.copy')}
        <span className={c.srOnly}> {label.toLowerCase()}</span>
      </CopyButton>
    </>
  );
}

function Step({
  n,
  title,
  done,
  pending,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  /** Done-able but not done yet (step 6 before a connection works). */
  pending?: boolean;
  children: ReactNode;
}) {
  const { t } = useWebI18n();
  const tone: DotTone = done ? 'ok' : pending ? 'warn' : 'mut';
  return (
    <li className={c.step}>
      <span className={c.stepMark}>
        <span className={c.stepNumber} data-done={done || undefined} aria-hidden="true">
          {n}
        </span>
      </span>
      <div className={c.stepMain}>
        <h3 className={c.stepTitle}>
          <span className={c.srOnly}>{t('settings.google.step', { n })} </span>
          {title}
          <StatusDot
            tone={tone}
            size={7}
            label={
              done
                ? t('settings.google.stepDone')
                : pending
                  ? t('settings.google.stepNotYet')
                  : t('settings.google.stepToDo')
            }
          />
        </h3>
        {children}
      </div>
    </li>
  );
}

/** The six steps of CN-03. */
function GoogleSetupSteps({ status }: { status: ConnectorsStatus }) {
  const { t, tx } = useWebI18n();
  const toast = useToast();
  const { app, setup, tested } = status.google;
  const [audience, setAudience] = useState<GoogleUserType>(app.userType ?? 'external');
  const setApp = useSetGoogleApp();
  const configured = app.configured;
  const audienceChanged = configured && app.userType !== null && app.userType !== audience;

  async function saveAudience() {
    const result = await setApp.mutateAsync({ body: { userType: audience } });
    if (result.status === 'ok') toast.show(t('settings.google.audienceSaved'));
  }

  return (
    <ol className={c.steps} aria-label={t('settings.google.stepsLabel')}>
      <Step n={1} title={t('settings.google.step1')} done={configured}>
        <p className={c.stepText}>{t('settings.google.step1Text')}</p>
        <ExternalLink href={setup.links.createProject}>{t('settings.google.step1')}</ExternalLink>
      </Step>

      <Step n={2} title={t('settings.google.step2')} done={configured}>
        <p className={c.stepText}>{t('settings.google.step2Text')}</p>
        <ExternalLink href={setup.enableApisUrl}>{t('settings.google.step2')}</ExternalLink>
      </Step>

      <Step n={3} title={t('settings.google.step3')} done={configured}>
        <p className={c.stepText}>{t('settings.google.step3Ask')}</p>
        <SegmentedControl<GoogleUserType>
          label={t('settings.google.whoConnects')}
          value={audience}
          onChange={setAudience}
          options={[
            { value: 'external', label: t('settings.google.personal') },
            { value: 'internal', label: t('settings.google.workspace') },
          ]}
        />
        {audience === 'external' ? (
          <p className={c.stepText}>
            {tx('settings.google.externalText', {
              external: <strong>External</strong>,
              publish: <strong>Publish app</strong>,
            })}
          </p>
        ) : (
          <p className={c.stepText}>
            {tx('settings.google.internalText', { internal: <strong>Internal</strong> })}
          </p>
        )}
        <dl className={c.copyList}>
          <CopyRow label={t('settings.google.appName')} value={setup.appName} />
          {setup.supportEmail && (
            <CopyRow label={t('settings.google.supportEmail')} value={setup.supportEmail} />
          )}
          {setup.authorizedDomain.includes('.') && (
            <CopyRow label={t('settings.google.authorizedDomain')} value={setup.authorizedDomain} />
          )}
        </dl>
        <div className={c.actions}>
          <ExternalLink href={setup.links.consentScreen}>{t('settings.google.openConsent')}</ExternalLink>
          {audience === 'external' && (
            <ExternalLink href={setup.links.audience}>{t('settings.google.openAudience')}</ExternalLink>
          )}
        </div>
        {audienceChanged && (
          <div className={c.formActions}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void saveAudience()}
              disabled={setApp.isPending}
            >
              {t('settings.google.saveChoice')}
            </Button>
            <span className={c.hint}>
              {t('settings.google.savedSays', {
                audience: t(AUDIENCE_LABEL[app.userType as GoogleUserType]),
              })}
            </span>
          </div>
        )}
      </Step>

      <Step n={4} title={t('settings.google.step4')} done={configured}>
        <p className={c.stepText}>
          {tx('settings.google.step4Text', { type: <strong>Web application</strong> })}
        </p>
        <dl className={c.copyList}>
          <CopyRow label={t('settings.google.redirectUri')} value={setup.redirectUri} />
        </dl>
        <ExternalLink href={setup.links.createClient}>{t('settings.google.createClient')}</ExternalLink>
      </Step>

      <Step n={5} title={t('settings.google.step5')} done={configured}>
        <AppForm status={status} audience={audience} />
      </Step>

      <Step n={6} title={t('settings.google.step6')} done={tested} pending={configured && !tested}>
        <p className={c.stepText}>{tested ? t('settings.google.tested') : t('settings.google.testIt')}</p>
        {!tested && configured && (
          <div>
            <Button
              variant="link"
              onClick={() => document.getElementById('your-accounts')?.scrollIntoView({ behavior: 'smooth' })}
            >
              {t('settings.google.goToAccounts')}
            </Button>
          </div>
        )}
      </Step>
    </ol>
  );
}

function errorOf(err: unknown): { message: string; fields: Record<string, string[]> } | null {
  if (err instanceof ApiError || err instanceof InvalidRequestError)
    return { message: err.message, fields: err.fields };
  return null;
}

/** Step 5: paste the Client ID and secret, or drop the downloaded JSON (read in the browser only). */
function AppForm({ status, audience }: { status: ConnectorsStatus; audience: GoogleUserType }) {
  const { t, tx } = useWebI18n();
  const toast = useToast();
  const ids = useId();
  const { app, setup } = status.google;
  const setApp = useSetGoogleApp();
  const removeApp = useRemoveGoogleApp();
  const [editing, setEditing] = useState(!app.configured);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!app.configured) setEditing(true);
  }, [app.configured]);

  async function readFile(file: File | undefined) {
    if (!file) return;
    setWarning(null);
    const parsed = parseClientSecretFile(await file.text());
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setClientId(parsed.clientId);
    setSecret(parsed.clientSecret);
    if (!parsed.redirectUris.includes(setup.redirectUri)) setWarning(redirectMismatchText(setup.redirectUri));
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    void readFile(event.dataTransfer.files[0]);
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    const id = clientId.trim();
    const key = secret.trim();
    if (!id) {
      setError(t('settings.google.pasteId'));
      return;
    }
    if (!key && !app.configured) {
      setError(t('settings.google.pasteSecret'));
      return;
    }
    // The saved secret is the old client's (the server checks the whole id; the hint catches most).
    if (!key && app.clientIdHint && clientIdHint(id) !== app.clientIdHint) {
      setError(NEW_CLIENT_NEEDS_SECRET_TEXT);
      return;
    }
    setError(null);
    try {
      const result = await setApp.mutateAsync({
        body: { clientId: id, userType: audience, ...(key ? { clientSecret: key } : {}) },
      });
      if (result.status === 'ok') {
        setClientId('');
        setSecret('');
        setWarning(null);
        setEditing(false);
        toast.show(t('settings.google.saved'));
      }
    } catch (err) {
      const problem = errorOf(err);
      if (!problem) throw err;
      setError(problem.fields.clientId?.[0] ?? problem.fields.clientSecret?.[0] ?? problem.message);
    }
  }

  async function onRemove() {
    const result = await removeApp.mutateAsync({});
    setConfirmRemove(false);
    if (result.status === 'ok') toast.show(t('settings.google.removed'));
  }

  if (!editing) {
    return (
      <>
        <p className={c.stepText}>
          {tx('settings.google.savedId', { id: <span className={c.code}>{app.clientIdHint}</span> })}
          {app.updatedAt ? ` · ${formatAgo(app.updatedAt, new Date(), LOCAL_TZ)}` : ''}
        </p>
        {confirmRemove ? (
          <div className={c.formActions}>
            <span className={c.hint}>{t('settings.google.removeAsk')}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onRemove()}
              disabled={removeApp.isPending}
            >
              {t('settings.google.removeApp')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        ) : (
          <div className={c.formActions}>
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              {t('settings.google.replace')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
              {t('settings.google.remove')}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <form className={c.appForm} onSubmit={onSave} noValidate>
      <p className={c.stepText}>
        {tx('settings.google.pasteText', { file: <span className={c.code}>client_secret_….json</span> })}
      </p>
      <div className={c.fields}>
        <label className={c.field} htmlFor={`${ids}-id`}>
          <span className={c.fieldLabel}>{t('settings.google.clientIdLabel')}</span>
          <Input
            id={`${ids}-id`}
            size="lg"
            spellCheck={false}
            autoComplete="off"
            placeholder="1234567890-abc.apps.googleusercontent.com"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              if (error) setError(null);
            }}
            invalid={error !== null}
          />
        </label>
        <label className={c.field} htmlFor={`${ids}-secret`}>
          <span className={c.fieldLabel}>{t('settings.google.secretLabel')}</span>
          <Input
            id={`${ids}-secret`}
            size="lg"
            type="password"
            spellCheck={false}
            autoComplete="off"
            placeholder={app.configured ? t('settings.google.keepSecret') : 'GOCSPX-…'}
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
              if (error) setError(null);
            }}
            invalid={error !== null}
          />
        </label>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is the keyboard way */}
      <div
        className={c.drop}
        data-over={over || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <button type="button" className={c.fileButton} onClick={() => fileInput.current?.click()}>
          {t('settings.google.chooseFile')}
        </button>
        <span>{t('settings.google.dropHere')}</span>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className={c.srOnly}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            void readFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {error && (
        <p className={c.error} role="alert">
          {error}
        </p>
      )}
      {warning && <GitHubNotice text={warning} command="redirect_uri_mismatch" />}
      <div className={c.formActions}>
        <Button type="submit" variant="primary" size="md" disabled={setApp.isPending}>
          {t('common.save')}
        </Button>
        {app.configured && (
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              setEditing(false);
              setError(null);
              setWarning(null);
            }}
          >
            {t('common.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

/** Google's messages and their fixes (CN-03). */
function Troubleshooting({ status }: { status: ConnectorsStatus }) {
  const { t, tx } = useWebI18n();
  const uri = status.google.setup.redirectUri;
  return (
    <section className={styles.section}>
      <SectionLabel as="h2">{t('settings.google.troubleLabel')}</SectionLabel>
      <div className={styles.card}>
        <div className={c.trouble}>
          <span className={c.troubleWhat}>redirect_uri_mismatch</span>
          <p className={c.troubleFix}>
            {tx('settings.google.troubleRedirect', { uri: <span className={c.code}>{uri}</span> })}
          </p>
        </div>
        <div className={c.trouble}>
          <span className={c.troubleWhat}>
            access_denied · “has not completed the Google verification process”
          </span>
          <p className={c.troubleFix}>{t('settings.google.troubleTesting')}</p>
        </div>
        <div className={c.trouble}>
          <span className={c.troubleWhat}>“API has not been used in project … or it is disabled”</span>
          <p className={c.troubleFix}>{t('settings.google.troubleApi')}</p>
        </div>
        <div className={c.trouble}>
          <span className={c.troubleWhat} data-plain="">
            {t('settings.google.troubleSignedOut')}
          </span>
          <p className={c.troubleFix}>{t('settings.google.troubleSignedOutFix')}</p>
        </div>
      </div>
    </section>
  );
}

/* YOUR ACCOUNTS ------------------------------------------------------------------------------------ */

function YourAccountsSection({
  burrow,
  status,
  outcome,
  onOutcomeSeen,
  navigate,
}: {
  burrow: string;
  status: ConnectorsStatus;
  outcome?: ConnectOutcome;
  onOutcomeSeen?: () => void;
  navigate?: (url: string) => void;
}) {
  const { t } = useWebI18n();
  const toast = useToast();
  const google = status.connections.find((conn) => conn.provider === 'google') ?? null;
  const [notice, setNotice] = useState<string | null>(null);
  const seen = useRef(false);

  // Google's answer, once: a toast for success, the reason in the card for a failure; then off the URL.
  useEffect(() => {
    if (seen.current || (!outcome?.connected && !outcome?.connectError)) return;
    seen.current = true;
    if (outcome.connectError) setNotice(connectErrorText(outcome.connectError));
    else
      toast.show(
        google ? t('settings.google.connectedAs', { email: google.email }) : t('settings.google.connected'),
      );
    onOutcomeSeen?.();
  }, [outcome, google, toast, onOutcomeSeen, t]);

  return (
    <section className={styles.section} id="your-accounts">
      <SectionLabel as="h2">{t('settings.google.accountsLabel')}</SectionLabel>
      {notice && <GitHubNotice text={notice} />}
      <div className={styles.card}>
        {status.mode === 'off' ? (
          <p className={styles.empty}>{t('settings.google.accountsOff')}</p>
        ) : (
          <GoogleAccount burrow={burrow} status={status} connection={google} navigate={navigate} />
        )}
      </div>
    </section>
  );
}

const CHECK_TONES: Record<string, DotTone> = {
  ok: 'ok',
  api_disabled: 'warn',
  no_scope: 'warn',
  error: 'bad',
};

function GoogleAccount({
  burrow,
  status,
  connection,
  navigate,
}: {
  burrow: string;
  status: ConnectorsStatus;
  connection: Connection | null;
  navigate?: (url: string) => void;
}) {
  const { t } = useWebI18n();
  const toast = useToast();
  const { connect, busy, problem } = useConnectGoogle(burrow, navigate);
  const check = useCheckConnection();
  const remove = useRemoveConnection();
  const [picking, setPicking] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [services, setServices] = useState<ConnectorService[]>([...CONNECTOR_SERVICES]);
  const connectable = googleConnectable(status);

  if (!connection) {
    return (
      <div className={c.block}>
        <div className={c.head}>
          <StatusDot tone="mut" size={8} label={t('settings.google.notConnected')} />
          <span className={c.main}>
            <span className={c.name}>Google</span>
            <span className={c.meta}>{t('settings.google.pickServices')}</span>
          </span>
        </div>
        <ServicePicker value={services} onChange={setServices} disabled={!connectable || busy} />
        <div className={c.formActions}>
          <Button
            variant="primary"
            size="md"
            disabled={!connectable || busy || services.length === 0}
            onClick={() => void connect(services)}
          >
            {t('settings.google.connect')}
          </Button>
          {!connectable && <span className={c.hint}>{t('settings.google.setUpFirst')}</span>}
          {connectable && services.length === 0 && (
            <span className={c.hint}>{t('settings.google.tickOne')}</span>
          )}
        </div>
        {problem && (
          <p className={c.error} role="alert">
            {problem}
          </p>
        )}
      </div>
    );
  }

  const active = connection.status === 'active';
  const reauth = connection.reauthReason;
  const checked = connection.checks.length > 0;

  async function onDisconnect() {
    if (!connection) return;
    const result = await remove.mutateAsync({ params: { connectionId: connection.id } });
    setConfirmDisconnect(false);
    if (result.status === 'ok') toast.show(t('settings.google.disconnected'));
  }

  return (
    <>
      <div className={c.block}>
        <div className={c.head}>
          <StatusDot
            tone={active ? 'ok' : 'warn'}
            size={8}
            label={active ? t('settings.google.connectedDot') : t('settings.google.signInAgain')}
          />
          <span className={c.main}>
            <span className={c.name}>
              Google · <span className={c.email}>{connection.email}</span>
            </span>
            <span className={c.meta}>
              {active
                ? `Connected${connection.name ? ` as ${connection.name}` : ''} · ${serviceList(connection.services)}`
                : REAUTH_TEXT[reauth ?? 'revoked']}
            </span>
          </span>
          {!picking && !confirmDisconnect && (
            <span className={c.actions}>
              <Button
                variant={active ? 'secondary' : 'primary'}
                size="sm"
                disabled={!connectable || busy}
                onClick={() => {
                  setServices(
                    connection.services.length > 0 ? [...connection.services] : [...CONNECTOR_SERVICES],
                  );
                  setPicking(true);
                }}
              >
                Reconnect
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(true)}>
                Disconnect
              </Button>
            </span>
          )}
        </div>
        {!connectable && !picking && !confirmDisconnect && (
          <p className={c.hint}>Set up Google above first.</p>
        )}
        {confirmDisconnect && (
          <div className={c.formActions}>
            <span className={c.hint}>
              Disconnect Google? Your assistant can’t use your mail, calendar and files until you connect
              again.
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onDisconnect()}
              disabled={remove.isPending}
            >
              Disconnect Google
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)}>
              Cancel
            </Button>
          </div>
        )}
        {picking && (
          <>
            <ServicePicker
              value={services}
              onChange={setServices}
              disabled={busy}
              locked={connection.services}
            />
            <p className={c.hint}>Services you connected stay connected. Disconnect removes them all.</p>
            <div className={c.formActions}>
              <Button
                variant="primary"
                size="md"
                disabled={busy || services.length === 0}
                onClick={() => void connect(services)}
              >
                Continue to Google
              </Button>
              <Button variant="ghost" size="md" onClick={() => setPicking(false)}>
                Cancel
              </Button>
            </div>
          </>
        )}
        {problem && (
          <p className={c.error} role="alert">
            {problem}
          </p>
        )}
        {active && checked && (
          <ul className={c.checks} aria-label="Services">
            {connection.checks.map((item) => (
              <li key={item.service} className={c.check}>
                <StatusDot tone={CHECK_TONES[item.state] ?? 'mut'} size={7} label={null} />
                <span className={c.checkName}>{serviceLabel(item.service, 'google')}</span>
                <span className={c.checkState} data-state={item.state}>
                  {checkText(item)}
                </span>
                {item.state === 'api_disabled' && item.enableUrl && (
                  <>
                    <span className={c.checkState} aria-hidden="true">
                      ·
                    </span>
                    <ExternalLink href={item.enableUrl}>Turn it on</ExternalLink>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {active && (
        <div className={c.footer}>
          <span className={c.meta}>
            {check.isPending
              ? 'Checking each service with Google…'
              : connection.checkedAt
                ? `Checked ${formatAgo(connection.checkedAt, new Date(), LOCAL_TZ)}`
                : 'Not checked yet'}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={check.isPending}
            onClick={() => check.mutate({ params: { connectionId: connection.id } })}
          >
            Check again
          </Button>
        </div>
      )}
    </>
  );
}
