/**
 * A connection's or device's own page (`/things/connection:con_…`, `device:…`; contracts 0.88/0.89 `things.page`;
 * Whombat connection-pages.md CP-01…CP-17, dashboards.md DS-01…DS-17, connections-page.md CN-05, CN-06;
 * connection-pages-web.md AP-1900…, dashboards-web.md AP-2050…, connections-page.md AP-2510; mocks ha.png,
 * hetzner.png): the head every page shares — the crumb back to Connections (`/connections`), the kind's icon, the name
 * with its status badge, Ask, the kind's actions (Restart, asked first) and “Open <service>” in a new tab, the fact
 * line with what it runs on (“Change” for those who may) and its address — then the tabs: the server's (Summary first,
 * `?tab=`), Activity and Connection (its own settings). The range (`?range=`, the page read again for it, the old page shown meanwhile) is
 * picked beside the charts a figure opens (`?chart=`), and at the tab row's end on the Summary only while a chart card
 * is left. Every tab of the server's is drawn by the one Summary renderer (`dashboard/`), except one about a server
 * (`ThingPageTab.server`): Find My's and its Timeline, drawn from the Mac's own reads and the connection's timeline
 * (`findmy/`), the Timeline only when the box sends it, and a 1Password connection's own tab, drawn from its sync's
 * read (`OnePasswordTab`). An open page reads again every
 * `refreshS`
 * while the tab is shown (at least 5 s; a minute without one; contracts 0.121 CT-1010, service-dashboards.md AP-4568),
 * and a read that failed keeps what the page has and says why. Its buttons (CT-1001…CT-1003, CT-1014) share one
 * runner and one question dialog; the toast says how each press went (AP-4560). The Ask pane is closed until asked
 * (`?ask=1`); a notice's “Look into it” opens it in a new chat with its question ready to send. Until the page answers
 * the first time its head is the row the sidebar or Connections hold, the rest skeletons (page-speed.md AP-2650).
 */
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  headFacts,
  holdSaysBadge,
  holdView,
  KEEP_QUIET_WORDS,
  LOOK_PLAN_WORDS,
  pageHeadBadge,
  pageHeadVerdict,
  parseThingTab,
  runsOnParts,
  serverTab,
  type ThingHeadPreview,
  thingBadgeTone,
  thingButtonView,
  thingGlyph,
  thingMark,
  thingPageIsLive,
  thingRefreshMs,
  thingSubject,
  thingTabs,
  threadToOpen,
  undoOutcome,
  withoutHoldLine,
} from '@whombat/client';
import { commitOutcomeText, hostErrorInfo, parseDashboardRange } from '@whombat/client/hosts';
import { queryKeys } from '@whombat/client/query';
import {
  type ThingButtons,
  useCachedThingHead,
  useHandleLook,
  useTheAgent,
  useThingAction,
  useThingButtons,
  useThingPage,
  useThingWatch,
  useUndoChange,
} from '@whombat/client/react';
import {
  CONNECTIONS_HREF,
  HOST_SERIES_RANGES,
  type HostSeriesRange,
  type ThingPage,
  type ThingPageAction,
  thingHref,
} from '@whombat/core';
import {
  FIND_MY_TIMELINE_TAB,
  isAccountPageId,
  isVaultSyncConnection,
  placeKindOfCatalog,
} from '@whombat/core/domain';
import { formatClock } from '@whombat/core/text';
import { ONEPASSWORD_TAB } from '@whombat/core/vault';
import { ExternalLink } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigateHref } from '../../../app/routing/navigation';
import { ButtonLink } from '../../../components/Button';
import { copyText } from '../../../components/CopyButton';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Tabs } from '../../../components/Tabs';
import { useToast } from '../../../components/Toast';
import { useWebI18n } from '../../../i18n/provider';
import { CHAT_WORDS } from '../../../i18n/shared';
import { useOverviewWords } from '../../../i18n/words';
import { ReadNote } from '../../home/ReadState';
import { useBurrowContext, useNow } from '../../messaging/useRoom';
import { AskButton, AskPane, isAskOpen } from '../AskPane';
import { ThingButtonQuestion } from '../dashboard/Buttons';
import { Dashboard } from '../dashboard/Dashboard';
import { rangeInTabRow } from '../dashboard/figures';
import { HeadMenu, type HeadMenuItem } from '../dashboard/HeadMenu';
import { LineParts } from '../dashboard/LineParts';
import { Crumb, PageHead, TabRow, tabsInRow } from '../dashboard/PageHead';
import type { DashboardContext } from '../dashboard/Panels';
import { RangePicker } from '../dashboard/RangePicker';
import { FindMyTab } from '../findmy/FindMyTab';
import { FindMyTimelineTab } from '../findmy/FindMyTimelineTab';
import { BackupsKeptHere } from '../KeptHere';
import { AppLink, ConfirmDialog, Skeleton, useChangeRunner } from '../parts';
import { PAGE_FRESH_MS, thingPageInput } from '../prefetch';
import { HoldLine, KeepQuietDialog, useKeepsQuiet, useThingKeepQuiet } from '../quiet/KeepQuiet';
import { useThingQuiet } from '../quiet/useQuiet';
import { WhatHappened } from '../quiet/WhatHappened';
import { useThingSearch } from '../search';
import things from '../Things.module.css';
import { THING_ICONS } from '../thingIcons';
import { LookCard } from './LookCard';
import { RunsOnDialog } from './RunsOnDialog';
import styles from './ThingPage.module.css';
import { ActivityTab, OnePasswordTab, SettingsTab } from './ThingTabs';

/** The Find My connection's tab (findmy-connection.md): it names its Mac and is drawn from that Mac's Find My. */
const FIND_MY_TAB = 'findmy';

/** A failed press's words stay up long enough to read (the server's reason). */
const FAILED_TOAST_MS = 6000;

/** The range an address asks for, if it is one; else none (the server's default, 24 hours). */
function wantedRange(v: string | undefined): HostSeriesRange | undefined {
  return v && (HOST_SERIES_RANGES as readonly string[]).includes(v) ? (v as HostSeriesRange) : undefined;
}

export interface ThingPageScreenProps {
  burrow: string;
  /** The thingId, decoded: `connection:con_…`, `device:con_…`, `device:dvp_…`. */
  thing: string;
}

export function ThingPageScreen({ burrow, thing }: ThingPageScreenProps) {
  const OVERVIEW_WORDS = useOverviewWords();
  const { tag: uiLocale } = useWebI18n();
  const { timeZone } = useBurrowContext(burrow);
  const now = useNow(60_000);
  const [search, set] = useThingSearch();
  const wanted = wantedRange(search.range);
  const query = useThingPage(thingPageInput(burrow, thing, wanted), {
    // As often as the page asks, at least 5 s apart, a minute without; paused while the tab is hidden (TanStack
    // Query's interval waits for focus), and read at once on coming back when a live page is stale (AP-4568).
    refetchInterval: (q) => thingRefreshMs(q.state.data),
    refetchOnWindowFocus: (q) => thingPageIsLive(q.state.data),
    // A new range keeps the page on screen while it is read.
    placeholderData: keepPreviousData,
    retry: false,
    // A copy read on hover moments ago is the page's (page-speed.md AP-2663): not read again as it opens.
    staleTime: PAGE_FRESH_MS,
  });
  const page = query.data;
  const toast = useToast();
  const putBack = usePutBack(burrow, thing);
  const buttons = useThingButtons(burrow, thing, (message, outcome, undo) => {
    if (!message) return;
    if (outcome === 'failed') toast.show(message, { duration: FAILED_TOAST_MS });
    // A change that can be put back (a service's setting, SST-03): “Put it back” in the toast.
    else if (undo)
      toast.show(message, { action: { label: 'Put it back', onAction: () => putBack.run(undo.changeId) } });
    else toast.show(message);
  });
  // Ignore, Remind me tomorrow, Stop watching and Undo on its lines (quiet-notices.md AP-4822).
  const quiet = useThingQuiet(burrow, thing);
  // Keep quiet for a while and End now, for who may manage it on a Whombat that has it.
  const keeps = useKeepsQuiet();
  const watch = useThingWatch(keeps ? { params: { burrow, thing } } : null, {
    retry: false,
    staleTime: 60_000,
  });
  const mayKeep = keeps && !!watch.data?.mayChange;
  const keepQuiet = useThingKeepQuiet(burrow, thing, page?.name ?? '');
  const [keeping, setKeeping] = useState(false);
  // Ask {assistant} to handle these (handle-it.md); a Whombat without it, or nothing left to look into: the question in
  // the Ask pane, as before.
  const handleQuestion = useRef('');
  // Handed over, its thread opens, where the assistant works on it (backup-places.md BPL-15).
  const navigateHref = useNavigateHref();
  const handle = useHandleLook(burrow, (outcome, thread) => {
    const open = outcome === 'ok' ? threadToOpen(thread) : null;
    if (open) navigateHref(open);
    else if (outcome === 'ask') {
      setDraft(handleQuestion.current || null);
      set({ ask: '1', chat: 'new' }, { replace: true });
    } else if (outcome === 'failed') toast.show(LOOK_PLAN_WORDS.failed);
  });
  // Until it answers the first time, the head as the sidebar's or Connections' row says it (AP-2650).
  const early = useCachedThingHead(burrow, thing);
  const [draft, setDraft] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tab = page ? parseThingTab(page, search.tab) : 'overview';
  const askOpen = isAskOpen(search);

  // A new tab starts at the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the tab changes
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [search.tab, thing]);

  const range = page?.range ?? parseDashboardRange(wanted, page?.ranges ?? HOST_SERIES_RANGES);
  // The ranges to pick from: beside the charts a figure opens, or in the tab row (AP-2510).
  const ranges = (page?.ranges?.length ?? 0) > 1 ? (page?.ranges ?? []) : [];
  const ctx: DashboardContext | null = page
    ? {
        burrow,
        thing: { id: page.id, name: page.name, settings: page.settings, canManage: true },
        timeZone,
        now,
        range,
        ranges,
        onRange: (next) => set({ range: next === '24h' ? undefined : next }, { replace: true }),
        onAsk: (question) => {
          setDraft(question ?? null);
          set({ ask: '1', chat: 'new' }, { replace: true });
        },
        onTab: (next) => set({ tab: next === page.tabs[0]?.key ? undefined : next }),
        buttons,
        readAt: query.dataUpdatedAt,
        quiet,
        research: page.research ?? null,
        onHandle: (question) => {
          handleQuestion.current = question;
          handle.mutate(page.id);
        },
        putBack: putBack.run,
        puttingBack: putBack.busy,
        endQuiet: keeps ? () => void keepQuiet.end() : null,
        endingQuiet: keepQuiet.busy,
      }
    : null;

  let body: ReactNode;
  if (!page || !ctx) {
    const gone = query.error instanceof ApiError && query.error.status === 404;
    body = query.error ? (
      <>
        <Crumb href={CONNECTIONS_HREF} label={CHAT_WORDS.dashboard} />
        <h1 className={styles.title}>{gone ? 'Not found' : (early?.name ?? 'This page couldn’t load')}</h1>
        {gone ? (
          <p className={things.dialogBody}>It isn’t here any more, or it isn’t yours to see.</p>
        ) : (
          // The first read failed: nothing saved, so no facts, controls or status that could look current.
          <ReadNote
            title={OVERVIEW_WORDS.couldntRead(early?.name ? `${early.name}’s page` : 'this page')}
            body={OVERVIEW_WORDS.noSaved}
            error={query.error}
            busy={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        )}
      </>
    ) : early ? (
      <>
        <EarlyHead head={early} />
        <div role="status" aria-busy="true" aria-label="Loading" style={{ display: 'grid', gap: 18 }}>
          <Skeleton height={20} />
          <Skeleton height={108} />
          <Skeleton height={200} />
        </div>
      </>
    ) : (
      <div role="status" aria-busy="true" aria-label="Loading" style={{ display: 'grid', gap: 18 }}>
        <Skeleton height={28} />
        <Skeleton height={64} />
        <Skeleton height={108} />
        <Skeleton height={200} />
      </div>
    );
  } else {
    const tabs = thingTabs(page, uiLocale);
    const own = tabs.find((t) => t.key === tab)?.own ?? null;
    // A tab about a server the page draws from that server's own reads (Find My's names its Mac).
    const about = tabs.find((t) => t.key === tab)?.server ?? null;
    const summary = tab === tabs[0]?.key;
    // The hold's heads-up line is for an app that doesn't draw the line under the head.
    const hold = keeps ? holdView(page) : null;
    const panels = (serverTab(page, tab)?.panels ?? []).map((p) =>
      hold && p.kind === 'notices' ? { ...p, items: [...withoutHoldLine(p.items, page)] } : p,
    );
    body = (
      <>
        <Head
          burrow={burrow}
          page={page}
          buttons={buttons}
          onPickRunsOn={() => setPicking(true)}
          onKeepQuiet={mayKeep ? () => setKeeping(true) : null}
          stateInHold={!!hold && holdSaysBadge(page)}
        />
        {hold ? <HoldLine view={hold} onEnd={() => void keepQuiet.end()} busy={keepQuiet.busy} /> : null}
        {query.error && !query.isPlaceholderData ? (
          // A refresh failed: the saved page stays, its status and problems with it; its controls may have changed.
          <ReadNote
            className={things.readNote}
            title={OVERVIEW_WORDS.couldntRefresh(`${page.name}’s page`)}
            body={OVERVIEW_WORDS.keepPage}
            error={query.error}
            busy={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {page.problem ? (
          <p className={styles.problem} role="status">
            {page.problem}
            {page.readAt ? ` What you see was read at ${formatClock(page.readAt, timeZone)}.` : ''}
          </p>
        ) : null}
        <TabRow
          picker={
            summary && ranges.length > 1 && rangeInTabRow(panels) ? (
              <RangePicker
                ranges={ranges}
                value={range}
                onChange={(next) => set({ range: next === '24h' ? undefined : next }, { replace: true })}
              />
            ) : null
          }
        >
          <Tabs<string>
            tabs={tabs.map((t) => ({
              key: t.key,
              label: t.label,
              ...(t.count !== null ? { meta: t.count } : {}),
            }))}
            value={tab}
            onChange={(next) => set({ tab: next === tabs[0]?.key ? undefined : next }, { replace: true })}
            label={`${page.name} sections`}
            idPrefix="thing-tab"
            panelId="thing-panel"
            className={cx(tabsInRow, styles.tabs)}
          />
        </TabRow>
        <div
          id="thing-panel"
          role="tabpanel"
          aria-labelledby={`thing-tab-${tab}`}
          aria-busy={query.isPlaceholderData || undefined}
          style={{ display: 'contents' }}
        >
          {own === 'activity' ? (
            <ActivityTab burrow={burrow} page={page} now={now} timeZone={timeZone} />
          ) : own === 'settings' ? (
            <SettingsTab burrow={burrow} page={page} />
          ) : tab === ONEPASSWORD_TAB && page.connectionId && isVaultSyncConnection(page.catalogId ?? '') ? (
            <OnePasswordTab burrow={burrow} connectionId={page.connectionId} />
          ) : about && tab === FIND_MY_TAB ? (
            <FindMyTab burrow={burrow} serverId={about} />
          ) : about && tab === FIND_MY_TIMELINE_TAB && page.connectionId ? (
            <FindMyTimelineTab burrow={burrow} connectionId={page.connectionId} serverId={about} />
          ) : (
            <>
              {/* What the assistant found out, at the top of the Summary (look-research-web.md AP-5906). */}
              {summary && page.research ? (
                <LookCard burrow={burrow} page={page} onAsk={() => ctx.onAsk()} />
              ) : null}
              <Dashboard panels={panels} ctx={ctx} />
              {/* A NAS that keeps this Whombat's backups (backup-places.md AP-6710). */}
              {summary && page.catalogId && placeKindOfCatalog(page.catalogId) ? (
                <BackupsKeptHere thing={page.id} />
              ) : null}
              {/* Its outages and problems over the last 30 days. */}
              {summary ? <WhatHappened burrow={burrow} thing={page.id} /> : null}
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <div className={things.screen} data-screen="thing">
      <div className={things.scroll} ref={scrollRef}>
        <main className={things.page} aria-label={page?.name ?? early?.name ?? 'Your thing'}>
          {body}
        </main>
      </div>
      {askOpen && page ? (
        <AskPane
          burrow={burrow}
          subject={thingSubject(page)}
          chatId={search.chat}
          draft={draft}
          onChat={(chat) => {
            // Sent: a later “New chat” starts empty.
            if (chat !== 'new') setDraft(null);
            set({ chat }, { replace: true });
          }}
          onClose={() => {
            setDraft(null);
            set({ ask: undefined, chat: undefined }, { replace: true });
          }}
        />
      ) : null}
      {picking && page ? (
        <RunsOnDialog burrow={burrow} page={page} onClose={() => setPicking(false)} />
      ) : null}
      {page && mayKeep ? (
        <KeepQuietDialog
          open={keeping}
          burrow={burrow}
          name={page.name}
          actions={keepQuiet}
          onClose={() => setKeeping(false)}
        />
      ) : null}
      <ThingButtonQuestion buttons={buttons} />
    </div>
  );
}

/**
 * What the head draws for what it is (DS-01): the crumb, the kind's icon or its maker's mark, on its tint; the page's
 * head and the one drawn before it answers share it (page-speed.md AP-2650).
 */
function headLook(thing: Pick<ThingPage, 'icon' | 'catalogId' | 'kind'>) {
  const glyph = thingGlyph(thing);
  return {
    crumb: { href: CONNECTIONS_HREF, label: CHAT_WORDS.dashboard },
    icon: THING_ICONS[glyph],
    mark: thingMark(thing),
    iconTone: glyph === 'cloud' ? ('warm' as const) : ('blue' as const),
  };
}

/**
 * The head before the page answers (AP-2650, AP-2652): the same crumb, icon, name and badge from the row the app holds,
 * the badge only when the row says how it is. The buttons come with the page, together: Ask first in a right-aligned
 * row would move left as Restart and Open join it.
 */
function EarlyHead({ head }: { head: ThingHeadPreview }) {
  return (
    <PageHead
      {...headLook(head)}
      name={head.name}
      badge={(() => {
        const text =
          head.status && head.badge ? pageHeadBadge({ status: head.status, badge: head.badge }) : null;
        return head.status && text ? { tone: thingBadgeTone(head.status), text } : null;
      })()}
      actions={null}
    />
  );
}

/**
 * The head (DS-01): crumb, icon, name, badge, Ask, the actions, the page's buttons (Check for updates, Arm; contracts
 * 0.121 CT-1014, drawn like Restart, disabled with their reason for those who may not), Open, and the fact line.
 */
function Head({
  burrow,
  page,
  buttons,
  onPickRunsOn,
  onKeepQuiet,
  stateInHold = false,
}: {
  burrow: string;
  page: ThingPage;
  buttons: ThingButtons;
  onPickRunsOn: () => void;
  /** Keep quiet… in ⋯; null where the viewer may not or the Whombat can't. */
  onKeepQuiet: (() => void) | null;
  /** The hold's line under the head says the state pill's words: the pill is left out, as on the phone. */
  stateInHold?: boolean;
}) {
  const headButtons = page.buttons ?? [];
  // Restart's question, from ⋯.
  const [asking, setAsking] = useState<ThingPageAction | null>(null);
  const runsOn = page.runsOn ? runsOnParts(page.runsOn.name) : null;
  // Choosing what it runs on is a connection's (CP-08); asked only of one with an address of its own (a cloud service
  // like Hetzner runs on nothing Whombat watches) that isn't part of a server (CP-10). An account's address is its
  // mail address or login: it runs on nothing of the person's.
  const pick = page.kind === 'connection' && !!page.connectionId && !isAccountPageId(page.catalogId);
  const ask = pick && !!page.address && !page.partOf;
  // The first line: the status, what it runs on, the address and when it was checked; the rest under More detail.
  const { checked, detail } = headFacts(page.facts);
  const factKey = (line: ThingPage['facts'][number]) => line.map((p) => p.text).join('');
  const address = page.address;
  const toast = useToast();
  // The head is one line beside a place's list (servers-connections-places.md): where it runs stays in words;
  // Change, the address and More detail are in ⋯.
  const [detailOpen, setDetailOpen] = useState(false);
  const badgeText = stateInHold ? null : pageHeadBadge(page);
  return (
    <PageHead
      {...headLook(page)}
      name={page.name}
      badge={badgeText ? { tone: thingBadgeTone(page.status), text: badgeText } : null}
      verdict={pageHeadVerdict(page)}
      detail={detail.length ? detail.map((line) => <Fact key={factKey(line)} line={line} />) : null}
      detailOpen={detailOpen}
      actions={
        <>
          {/* The assistant doesn't use the Vault's 1Password sync: nothing to ask it about here. */}
          {isVaultSyncConnection(page.catalogId ?? '') ? null : <AskButton burrow={burrow} />}
          {page.open ? (
            <ButtonLink
              className={things.btn}
              href={page.open.url}
              target="_blank"
              rel="noreferrer"
              iconStart={<Icon icon={ExternalLink} size={15} />}
            >
              {page.open.label}
            </ButtonLink>
          ) : null}
          {/* Every head is Ask, Open, then ⋯ with the rest (Restart, Pause, Update lists): one shape on every page. */}
          <HeadMenu
            name={page.name}
            items={[
              ...page.actions.map(
                (a): HeadMenuItem => ({
                  key: `action-${a.id}`,
                  label: a.label,
                  onSelect: () => setAsking(a),
                  disabled: !a.allowed,
                  reason: a.reason ?? null,
                  serious: a.icon === 'power',
                }),
              ),
              ...headButtons.map((b): HeadMenuItem => {
                const view = thingButtonView(b);
                return {
                  key: `button-${b.action}|${b.target ?? ''}|${String(b.value ?? '')}`,
                  label: view.label,
                  onSelect: () => buttons.press(b, {}),
                  disabled: view.disabled || buttons.running(b),
                  reason: view.reason ?? null,
                  serious: view.tone === 'danger',
                };
              }),
              ...(onKeepQuiet
                ? [
                    {
                      key: 'keep-quiet',
                      label: KEEP_QUIET_WORDS.menu,
                      onSelect: onKeepQuiet,
                    } satisfies HeadMenuItem,
                  ]
                : []),
              ...(pick && page.runsOn
                ? [{ key: 'runs-on', label: HEAD_MENU_WORDS.changeRunsOn, onSelect: onPickRunsOn }]
                : ask
                  ? [{ key: 'runs-on', label: HEAD_MENU_WORDS.askRunsOn, onSelect: onPickRunsOn }]
                  : []),
              ...(address
                ? [
                    {
                      key: 'copy-address',
                      label: HEAD_MENU_WORDS.copyAddress(address),
                      onSelect: () =>
                        void copyText(address).then((ok) => {
                          if (ok) toast.show('Address copied.');
                        }),
                    },
                  ]
                : []),
              ...(detail.length
                ? [
                    {
                      key: 'detail',
                      label: detailOpen ? HEAD_MENU_WORDS.lessDetail : HEAD_MENU_WORDS.moreDetail,
                      onSelect: () => setDetailOpen((o) => !o),
                    },
                  ]
                : []),
            ]}
          />
          <ActionDialog burrow={burrow} page={page} action={asking} onClose={() => setAsking(null)} />
        </>
      }
      facts={
        // Nothing to say (a cloud account with no check yet): no empty line under the head.
        (page.runsOn && runsOn) || checked ? (
          <>
            {page.runsOn && runsOn ? (
              <span>
                {runsOn.rest ? (
                  <>
                    Runs in{' '}
                    <AppLink href={page.runsOn.href} className={styles.runsOn}>
                      {runsOn.rest}
                    </AppLink>{' '}
                    on{' '}
                  </>
                ) : (
                  'Runs on '
                )}
                <AppLink href={thingHref('server', page.runsOn.serverId)} className={styles.runsOn}>
                  <span className={styles.mono}>{runsOn.server}</span>
                </AppLink>
              </span>
            ) : null}
            {checked ? <Fact line={checked} /> : null}
          </>
        ) : null
      }
    />
  );
}

/** The ⋯ menu's words for what left the head's fact line. */
const HEAD_MENU_WORDS = {
  changeRunsOn: 'Change what it runs on',
  askRunsOn: 'What does it run on?',
  copyAddress: (address: string) => `Copy address ${address}`,
  moreDetail: 'More detail',
  lessDetail: 'Less detail',
} as const;

function Fact({ line }: { line: ThingPage['facts'][number] }) {
  return (
    <span>
      <LineParts line={line} />
    </span>
  );
}

/**
 * **Put it back** (service-settings.md SST-03): `changes.undo` of a setting's change, from the toast or its row; the
 * page is read again after it, and a refusal says the server's words (“… was changed again since, so Whombat won’t put
 * it back.”).
 */
function usePutBack(burrow: string, thing: string) {
  const { tag: uiLocale } = useWebI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const undo = useUndoChange(burrow);
  const { agent } = useTheAgent(burrow);
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (changeId: string) => {
      setBusy(changeId);
      try {
        const result = await undo.mutateAsync(changeId);
        if (result.status !== 'ok') {
          toast.show(commitOutcomeText(result, uiLocale) ?? '', { duration: FAILED_TOAST_MS });
          return;
        }
        const outcome = undoOutcome(result.data, agent?.name);
        toast.show(outcome.kind === 'undone' ? 'Put back.' : outcome.message);
      } catch (error) {
        toast.show(hostErrorInfo(error, uiLocale).message, { duration: FAILED_TOAST_MS });
      } finally {
        setBusy(null);
        void qc.invalidateQueries({ queryKey: queryKeys.scope('things.page', { burrow, thing }) });
        void qc.invalidateQueries({ queryKey: queryKeys.scope('changes.list', { burrow }) });
      }
    },
    [undo, toast, qc, burrow, thing, agent?.name, uiLocale],
  );
  return { run: (changeId: string) => void run(changeId), busy };
}

/** One of the page's actions (Restart): asked first, refused with its reason when it may not be used (CP-12). */
/** An action's question (Restart, always asked first) and its run; the page's toast says how it went. */
function ActionDialog({
  burrow,
  page,
  action,
  onClose,
}: {
  burrow: string;
  page: ThingPage;
  action: ThingPageAction | null;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const run = useThingAction(burrow, page.id);
  const runner = useChangeRunner();
  const qc = useQueryClient();
  // Keep the last words while the dialog closes.
  const last = useRef(action);
  if (action) last.current = action;
  const shown = action ?? last.current;
  const close = () => {
    setError(null);
    onClose();
  };
  const confirm = async (a: ThingPageAction) => {
    setError(null);
    const out = await runner.run(
      () => run.mutateAsync(a.id),
      (data) => data.message,
      { inline: true },
    );
    if (out.ok) {
      close();
      void qc.invalidateQueries();
    } else if (out.error) setError(out.message);
    else close();
  };
  return (
    <ConfirmDialog
      open={!!action}
      title={shown?.confirm.title ?? ''}
      body={shown?.confirm.body}
      confirm={shown?.confirm.button ?? ''}
      serious={shown?.icon === 'power'}
      busy={runner.busy}
      error={error}
      onConfirm={() => (action ? void confirm(action) : undefined)}
      onClose={close}
    />
  );
}
