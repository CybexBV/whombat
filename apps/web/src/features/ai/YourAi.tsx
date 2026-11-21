/**
 * Settings → AI in the assistant shell (`?tab=ai`; docs/decisions/less-is-more.md AP-1780…AP-1788): what was four
 * screens — accounts, usage and spend — as one calm page, every function still there.
 *
 * - YOUR AI SIGN-INS (`#accounts`, `#usage`): one sentence with the assistant's name, then a row per AI provider that
 *   is its sign-in and its usage at once — the dot, the name, one line (“Max plan · Signed in with your Claude
 *   subscription”, “Pay as you go · Signed in with your API key”, “Not signed in”), the subscription's meters under it,
 *   a small Refresh beside Sign out; signing in opens in the row as before (`SignInRow`).
 * - Under it one line for what is on this Whombat (`#clients`, AP-1786): “Claude Code 2.1.302 is installed and up to
 *   date · Details”. Details folds the AI clients (the runner, Claude Code's version, Install/Remove, the runner's words
 *   when one didn't start, Check again) and how usage is read; it opens by itself when something there needs the
 *   person (AP-1753) or the address asks for `#clients`. ChatGPT is a sign-in only:
 *   nothing to install, no client row (chatgpt-no-client.md AP-5610, AP-5614).
 * - The burrow's AI gateway pool while it has one (`GatewayUsage`), then A MODEL ON YOUR NETWORK (`LocalModelSection`,
 *   hermes-engine-app.md AP-5048) and WEB SEARCH (`WebSearchSection`, web-search.md). No one else's usage: a Whombat
 *   is one person's (one-person.md AP-5693).
 * Spend follows (`AssistantSpend`, AP-1782). No jump links, no GitHub pointer (GitHub is under Connections).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { localModelOf } from '@whombat/client';
import { endpointScope } from '@whombat/client/query';
import { useBootstrap, useTheAgent } from '@whombat/client/react';
import {
  API_KEY_MODE,
  CLIENT_PROVIDERS,
  type ClientsList,
  clientOf,
  clientReady,
  needsClient,
  SIGNIN_TEXT,
  type SignInsList,
  signInOf,
} from '@whombat/client/signins';
import { api } from '@whombat/core/contracts';
import {
  type AgentSetupStatus,
  GATEWAY_PROVIDERS,
  isUsageStale,
  LIVE_PROVIDERS,
  type LiveProvider,
  type SubscriptionUsage,
} from '@whombat/core/domain';
import { formatAsOf } from '@whombat/core/text';
import { useCallback, useEffect, useId, useState } from 'react';
import { LoadErrorNote } from '../../app/runtime';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import {
  ProviderReadiness,
  ProviderRow,
  ReadinessFooter,
  RunnerRow,
  useAgentSetupStatus,
} from '../agent/AiProviderPanel';
import { useNow } from '../messaging/useRoom';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import {
  GatewayUsage,
  INLINE_USAGE_TEXT,
  InlineUsage,
  planLabel,
  RefreshUsageButton,
  USAGE_TEXT,
  useUsageList,
  useUsageRefresh,
} from '../usage';
import styles from './ai.module.css';
import { foldSummary, signInsHelp, YOUR_AI_TEXT } from './aiSummary';
import { ClientRow } from './ClientRow';
import { LocalModelSection } from './LocalModelSection';
import { SignInRow, type SignInRowProps } from './SignIn';
import { useAiRefresh, useClientsStatus, useSignInsStatus } from './useAi';
import { webSearchOf } from './useWebSearch';
import { WebSearchSection } from './WebSearchSection';

const T = SIGNIN_TEXT;

export function YourAi({
  burrow,
  terminal,
  only,
}: {
  burrow: string;
  terminal?: SignInRowProps['terminal'];
  /**
   * One half (settings-groups.md): your sign-ins (the assistant's AI sign-in), or what is on this
   * Whombat — the AI programs, the AI gateway's pool and a model on your network (Advanced). Both without.
   */
  only?: 'signins' | 'machine';
}) {
  const { words } = useTheAgent(burrow);
  const viewer = useBurrowViewer(burrow);
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const clientsQ = useClientsStatus();
  const setupQ = useAgentSetupStatus(burrow, { watch: true });
  const signInsQ = useSignInsStatus();
  // Read again every time the tab opens; `usage.updated` keeps it fresh while it is open.
  const usageQ = useUsageList({ params: { burrow } }, { refetchOnMount: 'always' });
  const now = useNow(30_000);
  const aiRefresh = useAiRefresh();
  const qc = useQueryClient();
  // A new sign-in has a subscription to read, a sign-out none.
  const refresh = useCallback(() => {
    aiRefresh();
    void qc.invalidateQueries({ queryKey: endpointScope(api.usage.list) });
  }, [aiRefresh, qc]);

  if (signInsQ.isError || clientsQ.isError)
    return (
      <p className={styles.sectionHelp} role="alert">
        {T.loadFailed}{' '}
        <Button variant="link" onClick={refresh}>
          {T.retry}
        </Button>
      </p>
    );

  const usage = usageQ.data;
  const pool = usage?.gateway ?? null;
  const through = pool ? GATEWAY_PROVIDERS.filter((p) => pool[p]) : [];
  const help = signInsHelp(words.Name, pool ? { name: pool.name, providers: through } : null);

  const signIns = (
    <section className={styles.section} aria-label={T.signIns} id="usage">
      <SectionLabel as="h2">{T.signIns}</SectionLabel>
      <p className={styles.sectionHelp}>{help}</p>
      <div className={styles.card}>
        {!signInsQ.data ? (
          <div aria-busy="true">
            <SkeletonRows count={2} lines={1} />
          </div>
        ) : (
          LIVE_PROVIDERS.map((p) => (
            <YourSignInRow
              key={p}
              burrow={burrow}
              provider={p}
              signIns={signInsQ.data}
              clients={clientsQ.data}
              usage={usage?.mine.find((s) => s.provider === p) ?? null}
              now={now}
              timeZone={viewer.timeZone}
              onChanged={refresh}
              {...(terminal && { terminal })}
            />
          ))
        )}
      </div>
      {usageQ.error && !usage ? (
        <LoadErrorNote
          error={usageQ.error}
          message={USAGE_TEXT.loadFailed}
          onRetry={() => void usageQ.refetch()}
        />
      ) : null}
    </section>
  );
  const onThisWhombat = (
    <OnThisWhombat
      burrow={burrow}
      clients={clientsQ.data}
      listedAt={clientsQ.dataUpdatedAt}
      setup={setupQ.data}
      assistant={words.name}
      onChanged={refresh}
    />
  );
  const machine = (
    <>
      {pool ? <GatewayUsage pool={pool} now={now} timeZone={viewer.timeZone} /> : null}
      {bootstrap ? <LocalModelSection burrow={burrow} view={localModelOf(bootstrap.burrow)} /> : null}
      {bootstrap ? <WebSearchSection burrow={burrow} view={webSearchOf(bootstrap.burrow)} /> : null}
    </>
  );
  if (only === 'signins')
    return (
      <div className={styles.yourAi} id="accounts">
        {signIns}
      </div>
    );
  if (only === 'machine')
    return (
      <>
        <div className={styles.yourAi}>{onThisWhombat}</div>
        {machine}
      </>
    );
  return (
    <>
      <div className={styles.yourAi} id="accounts">
        {signIns}
        {onThisWhombat}
      </div>
      {machine}
    </>
  );
}

/** A provider's sign-in with its usage in the same row (AP-1780). */
function YourSignInRow({
  burrow,
  provider,
  signIns,
  clients,
  usage,
  now,
  timeZone,
  onChanged,
  terminal,
}: {
  burrow: string;
  provider: LiveProvider;
  signIns: SignInsList;
  clients: ClientsList | undefined;
  usage: SubscriptionUsage | null;
  now: number;
  timeZone: string;
  onChanged: () => void;
  terminal?: SignInRowProps['terminal'];
}) {
  const refresh = useUsageRefresh(burrow, provider, {
    failed: USAGE_TEXT.refreshFailed,
    notSignedIn: USAGE_TEXT.notSignedIn(provider),
  });
  const mine = signInOf(signIns, provider);
  const ready = mine?.state === 'ready';
  const metered = ready && usage?.connected && usage.kind === 'subscription' ? usage : null;
  // The sign-in says how it is paid; the usage snapshot names a subscription's plan.
  const plan = !ready
    ? null
    : mine.authMode === API_KEY_MODE
      ? INLINE_USAGE_TEXT.payAsYouGo
      : metered
        ? planLabel(metered)
        : null;
  const stale =
    metered?.observedAt && isUsageStale(metered.observedAt, new Date(now))
      ? INLINE_USAGE_TEXT.asOf(formatAsOf(metered.observedAt, now, timeZone))
      : null;
  return (
    <SignInRow
      provider={provider}
      list={signIns}
      onChanged={onChanged}
      installed={clientReady(provider, clients)}
      titled
      plan={plan}
      after={stale}
      tools={metered ? <RefreshUsageButton provider={provider} refresh={refresh} /> : null}
      {...(terminal && { terminal })}
    >
      {metered ? <InlineUsage usage={metered} refresh={refresh} now={now} timeZone={timeZone} /> : null}
    </SignInRow>
  );
}

/**
 * What is on this Whombat, folded to one line (AP-1786, AP-1787): the AI clients with the host's readiness and how usage
 * is read. Opens by itself when something there needs the person, or for `#clients`.
 */
function OnThisWhombat({
  burrow,
  clients,
  listedAt,
  setup,
  assistant,
  onChanged,
}: {
  burrow: string;
  clients: ClientsList | undefined;
  listedAt: number;
  setup: AgentSetupStatus | undefined;
  assistant: string;
  onChanged: () => void;
}) {
  const ids = useId();
  const summary = foldSummary({ clients, setup });
  const hash = useLocation({ select: (l) => l.hash.replace(/^#/, '') });
  const [open, setOpen] = useState(summary.attention || hash === 'clients');
  // Trouble opens it (once it is known: the lists load after the tab), and so does a link to `#clients`.
  useEffect(() => {
    if (summary.attention || hash === 'clients') setOpen(true);
  }, [summary.attention, hash]);
  const loading = !clients && !setup;

  return (
    <section className={styles.fold} id="clients" aria-labelledby={`${ids}-title`}>
      <h2 className={styles.srOnly} id={`${ids}-title`}>
        {YOUR_AI_TEXT.fold}
      </h2>
      <div className={styles.foldLine}>
        <StatusDot tone={summary.tone} size={7} label={null} />
        <span className={styles.foldText}>
          <span data-fold-summary="">{loading ? 'Checking the AI clients…' : summary.text}</span>
          <Button
            variant="link"
            className={styles.foldToggle}
            aria-expanded={open}
            aria-controls={`${ids}-body`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? YOUR_AI_TEXT.hideDetails : YOUR_AI_TEXT.details}
            <Icon name="chevronDown" size={14} className={styles.foldChevron} />
          </Button>
        </span>
      </div>
      <div className={styles.foldBody} id={`${ids}-body`} hidden={!open}>
        {open ? (
          <section className={styles.section} aria-label={T.clients}>
            <SectionLabel as="h3">{T.clients}</SectionLabel>
            <div className={styles.card}>
              {setup ? <RunnerRow status={setup} /> : null}
              {CLIENT_PROVIDERS.map((p) => {
                const client = clientOf(clients, p);
                const host = setup?.providers.find((x) => x.provider === p);
                return (
                  <ClientRow
                    key={p}
                    provider={p}
                    client={client}
                    onChanged={onChanged}
                    listedAt={listedAt}
                    detailed
                  >
                    {host ? <ProviderReadiness setup={host} /> : null}
                  </ClientRow>
                );
              })}
              {/* ChatGPT has no client (AP-5614): a row only when it didn't start, with the runner's words. */}
              {(setup?.providers ?? [])
                .filter((x) => !needsClient(x.provider) && x.state === 'error')
                .map((x) => (
                  <ProviderRow key={x.provider} setup={x} />
                ))}
            </div>
            {setup ? <ReadinessFooter burrow={burrow} status={setup} /> : null}
            <p className={styles.sectionHelp}>{INLINE_USAGE_TEXT.howRead(assistant)}</p>
          </section>
        ) : null}
      </div>
    </section>
  );
}
