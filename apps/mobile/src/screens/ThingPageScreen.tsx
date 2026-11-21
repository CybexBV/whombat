/**
 * A connection's or device's own page on the phone (Whombat connection-pages.md CP-01…CP-19; connection-pages-mobile.md
 * AP-1950…AP-1966), from `things.page` — the server page's shape at phone width: its glyph and name, its status, the
 * fact lines (version first), its address, “Runs on pve-02 · CT 131” opening that guest or server, why the figures
 * couldn't be read this time; its actions (Restart, behind a confirm sheet, for those who may manage it) and “Open
 * Home Assistant” in the browser; then the tabs, underlined (underline-tabs-android.md AP-2634) — the server's
 * (Overview first), Activity, and Connection on the right, which opens the Connection screen — and the tab's panels
 * stacked. Overview ends with “Ask about Home
 * Assistant”: the chat about it, or a new one; a notice's “Look into it” and a “Show more here” chip open the new-chat
 * sheet with their question ready. Pull to refresh; read again every `refreshS` (60 seconds) while on screen (CP-04).
 * The Overview is the Summary (Whombat dashboards.md DS-01…DS-05, connections-page.md CN-05, CN-06; dashboards-mobile.md
 * AP-2120…, connections-page.md AP-2558): every panel stacked in the order given (`SummaryPanels`: a figure that names
 * charts opens them inside the figures' card), the range control (the page's `ranges`, on a Whombat with
 * `things.dashboards`) at the top or, when every chart sits behind a figure, in the opened figure; the previous range's
 * page on screen while the next one is read. Until the page answers the first time, its glyph, name and status are
 * the Connections tab's row, the rest skeletons (page-speed.md AP-2650).
 * A service's page (Whombat service-dashboards.md SD-01…SD-11; service-dashboards.md AP-4630…): its own buttons in the
 * head beside Restart, and one runner for every button on it (`useThingButtons`) — a question opens the question sheet
 * (Restart's), the toast says the server's words, the page is read again at once; switches and steppers show what the
 * person set until the next read (`useControlGuesses`). Live while shown: read again every `refreshS` (5 s while
 * something plays or downloads, 10 s for controls) while the screen is focused and the app open, a minute without one,
 * and at once when a live page is shown again.
 * Quiet notices (Whombat quiet-notices.md QN-10…QN-15; quiet-notices-mobile.md AP-4861…AP-4865): on a Whombat with
 * `things.quiet` a Worth a look line has its ⋯ menu (Ignore, Remind me tomorrow, Stop watching) for who may manage the
 * thing, a quiet line is greyed at the bottom with Undo, and the toast says how it went with Undo; its Settings (the
 * Connection screen) list What Whombat watches for this thing.
 * What the assistant found out about what needs a look here (Whombat look-research.md LR-09; look-research-mobile.md
 * AP-5923) is a card at the top of the Summary (`LookCard`): its words, the step it offers and Ask {assistant}.
 * A service's settings (Whombat service-settings.md SST-01…SST-10): its settings tab's groups (`thing/Settings.tsx`), a
 * press toast with Put it back when the change can be put back, and its verdict under the name in place of the badge.
 */
import { useIsFocused } from '@react-navigation/native';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import {
  headFacts,
  OVERVIEW_WORDS,
  type ThingHeadPreview,
  thingButtonKey,
  thingGlyph,
  thingMark,
  thingStatusLevel,
} from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import {
  type ThingButtons,
  useCachedThingHead,
  useControlGuesses,
  useQuietActions,
  useThingAction,
  useThingButtons,
  useThingPage,
} from '@whombat/client/react';
import { type HostSeriesRange, parseThingId, type ThingPage, type ThingPageAction } from '@whombat/core';
import { placeKindOfCatalog } from '@whombat/core/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import { DEFAULT_RANGE, rangeOptions } from '../data/dashboard';
import { quietNote } from '../data/quiet';
import { pressNote } from '../data/servicePanels';
import { putBackAction } from '../data/serviceSettings';
import {
  headSpoken,
  type LinkRun,
  phoneThingTabs,
  problemLine,
  problemsFirst,
  readOnShow,
  runsOnTarget,
  shownPanels,
  shownTab,
  THING_PAGE_COPY,
  thingPageInterval,
  thingSubject,
} from '../data/thingPage';
import { showToast, toasts } from '../data/toast';
import { useAgentWords } from '../data/useAgent';
import { openHref, useAppNavigation } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BigButton, ThingDot, ThingIcon } from '../ui/assistant';
import { copyToClipboard } from '../ui/clipboard';
import { BackBar, Screen } from '../ui/headers';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Ellipsis,
  ExternalLink,
  type LucideIcon,
  MessageCircle,
} from '../ui/icons';
import { OneSheet } from '../ui/oneSheet';
import { Button, ErrorState } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { LevelPill } from '../ui/statusMark';
import { Touchable } from '../ui/Touchable';
import { hitSlopFor } from '../ui/touchTarget';
import { errorText, outcomeText, showFailure, showNotice } from './feedback';
import { CardSkeletons, ReadNote } from './home/OverviewParts';
import { NewChatSheet } from './NewChatSheet';
import { ThingActivity } from './thing/Changes';
import type { ControlActions } from './thing/Controls';
import { BackupsKeptHere } from './thing/KeptHere';
import { LookCard } from './thing/LookCard';
import { type PanelContext, SummaryPanels, TabPanels } from './thing/Panels';
import { FactLine, useWidePage } from './thing/parts';
import { usePutBack } from './thing/Settings';
import { HeadButton } from './thing/ThingButton';
import { ThingTabs } from './thing/ThingTabs';
import { useHandOver } from './thing/useHandOver';
import { useAskAbout } from './useAskAbout';

const INSET = 18;

export function ThingPageScreen({
  thingId,
  title,
  back,
  tab: wanted,
  onBack,
}: {
  thingId: string;
  title: string | undefined;
  back: string;
  /** The tab an address or a link asks for (`?tab=logs`). */
  tab: string | undefined;
  onBack: () => void;
}) {
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug, timeZone } = useBurrowBase();
  const now = useNow();
  const navigation = useAppNavigation();
  const qc = useQueryClient();
  const focused = useIsFocused();
  // The range picked here (DS-03); an older runtime (no `things.dashboards`) shows its one range.
  const [range, setRange] = useState<HostSeriesRange | null>(null);
  const query = useThingPage(
    { params: { burrow: slug, thing: thingId }, ...(range ? { query: { range } } : {}) },
    {
      retry: false,
      // Live while shown (SD-09, AP-4535): its `refreshS` while focused; `focusManager` holds it in the background.
      refetchInterval: (q) => thingPageInterval(focused, q.state.data),
      placeholderData: keepPreviousData,
    },
  );
  const page = query.data ?? null;
  // A live page shown again (back from another screen) reads at once when its copy is older than its interval.
  const shownAgain = useRef(focused);
  useEffect(() => {
    const was = shownAgain.current;
    shownAgain.current = focused;
    if (focused && !was && readOnShow(query.data, query.dataUpdatedAt, Date.now())) void query.refetch();
  }, [focused, query]);
  // Every button on the page runs through one runner: one question at a time, the server's words in the toast.
  // A setting's change that can be put back says so with Put it back (service-settings.md SST-03).
  const putBack = usePutBack(thingId);
  const putBackRef = useRef(putBack);
  putBackRef.current = putBack;
  const note = useCallback((message: string, outcome: 'done' | 'failed', undo?: { changeId: string }) => {
    const text = pressNote(message, outcome);
    if (!text) return;
    if (undo) toasts.show(text, { action: putBackAction(() => putBackRef.current(undo.changeId)) });
    else if (outcome === 'failed') showFailure(text);
    else showNotice(text);
  }, []);
  const buttons = useThingButtons(slug, thingId, note);
  // Ignore, Remind me tomorrow, Stop watching and Undo on its lines (quiet-notices-mobile.md AP-4861): on a Whombat
  // with `things.quiet`; the toast says how it went, with Undo.
  const quiet = useQuietActions(slug, thingId, { timeZone, note: quietNote(showToast) });
  const { guesses, guess, done } = useControlGuesses(query.dataUpdatedAt);
  const act = useMemo<ControlActions>(
    () => ({ buttons, guesses, guess, done }),
    [buttons, guesses, guess, done],
  );
  // Until it answers the first time, the head as the Connections tab's row says it (AP-2650).
  const early = useCachedThingHead(slug, thingId);
  const ranges = useMemo(() => rangeOptions(page?.ranges), [page?.ranges]);
  const shownRange = range ?? page?.range ?? DEFAULT_RANGE;
  const tabs = useMemo(() => (page ? phoneThingTabs(page) : []), [page]);
  const [tab, setTab] = useState<string | null>(wanted ?? null);
  useEffect(() => {
    if (wanted) setTab(wanted);
  }, [wanted]);
  const shown = shownTab(tabs, tab);
  const subject = useMemo(() => (page ? thingSubject(page) : null), [page]);
  const [asking, setAsking] = useState<{ text: string | null } | null>(null);
  const [confirm, setConfirm] = useState<ThingPageAction | null>(null);
  const [pulling, setPulling] = useState(false);
  const scroller = useRef<ScrollView>(null);
  const tabsAt = useRef(0);
  const name = page?.name ?? early?.name ?? title ?? THING_PAGE_COPY.back;
  const parsed = parseThingId(thingId);

  // Its settings are the Connection screen, with What Whombat watches for this thing (a device's is its own, AP-4865).
  const settingsOf = (connectionId: string | undefined) =>
    connectionId
      ? () => navigation.navigate('Connection', { connectionId, title: name, back: name, thingId })
      : null;
  const openSettings = settingsOf(page?.settings ? page.connectionId : undefined);
  const fallbackSettings = settingsOf(parsed?.id.startsWith('con_') ? parsed.id : undefined);
  const showTab = (key: string) => {
    setTab(key);
    scroller.current?.scrollTo({ y: Math.max(0, tabsAt.current - 8), animated: true });
  };
  const run = (r: LinkRun) => {
    switch (r.kind) {
      case 'ask':
        // “Or ask something else…” opens it with nothing typed.
        return setAsking({ text: r.question.trim() || null });
      case 'tab':
        return showTab(r.tab);
      case 'settings':
        return openSettings?.();
      case 'href':
        return void openHref(r.href);
      case 'url':
        return void Linking.openURL(r.url).catch(() => {});
    }
  };
  const askAbout = useAskAbout(subject, name, () => setAsking({ text: null }));
  const handOver = useHandOver(thingId, (question) => setAsking({ text: question }));
  const refresh = () => {
    setPulling(true);
    void qc.invalidateQueries({ queryKey: queryKeys.scope('changes.list') });
    void qc.invalidateQueries({ queryKey: queryKeys.scope('widgets.list') });
    void query.refetch().finally(() => setPulling(false));
  };
  // A link to its Settings (`?tab=settings`, the web's old settings address) opens them over the page, once.
  const settingsAsked = useRef(false);
  useEffect(() => {
    if (wanted !== 'settings' || !openSettings || settingsAsked.current) return;
    settingsAsked.current = true;
    openSettings();
  }, [wanted, openSettings]);
  const ctx: PanelContext | null = page
    ? {
        thing: { id: page.id, name: page.name },
        tabs,
        range: page.range ?? DEFAULT_RANGE,
        run,
        openSettings,
        act,
        quiet,
        research: page.research ?? null,
        onHandle: handOver,
        putBack,
      }
    : null;
  const notFound = !!query.error && 'status' in query.error && query.error.status === 404;
  // With the list hidden on an open phone the cards sit in columns, as on the web.
  const widePage = useWidePage(INSET);

  // A service's head (service-slots.md SLT-10): Ask and Open under its name, Restart and its own buttons behind ⋯.
  const service = !!page?.open;
  const more = page && service && (page.actions.length || page.buttons?.length);
  const [menu, setMenu] = useState(false);
  return (
    <Screen>
      <BackBar
        label={back}
        onPress={onBack}
        right={
          page && more ? (
            <Touchable
              onPress={() => setMenu(true)}
              feedback="wash"
              ringRadius={22}
              accessibilityRole="button"
              accessibilityLabel={THING_PAGE_COPY.more(page.name)}
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                borderWidth: 1,
                borderColor: theme.colors.line,
                backgroundColor: theme.colors.sf,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ellipsis size={18} color={theme.colors.ink} strokeWidth={1.8} />
            </Touchable>
          ) : undefined
        }
      />
      <ScrollView
        ref={scroller}
        onLayout={widePage.onLayout}
        contentContainerStyle={{ paddingHorizontal: INSET, paddingBottom: 24 + bottomRoom, gap: 14 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={refresh}
            colors={[theme.colors.ink]}
            tintColor={theme.colors.mut}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        {!page || !ctx ? (
          <>
            {early && !query.error ? (
              <HeadTop thing={early} />
            ) : (
              <Text size={28} weight={700} tracking={-0.02} accessibilityRole="header">
                {name}
              </Text>
            )}
            {query.error ? (
              <>
                {notFound ? (
                  <ErrorState text={THING_PAGE_COPY.notFound} />
                ) : (
                  // Nothing saved to show yet: no figures, controls or status that could look current.
                  <ReadNote
                    title={OVERVIEW_WORDS.couldntRead(name)}
                    body={OVERVIEW_WORDS.noSaved}
                    onRetry={() => void query.refetch()}
                    error={query.error}
                  />
                )}
                {/* Its settings still open without the page: a connection's id is in its thingId, and a server that
                    doesn't serve pages answers 404 too (AP-1962). */}
                {fallbackSettings ? (
                  <Button
                    label={THING_PAGE_COPY.openSettings}
                    variant="secondary"
                    onPress={fallbackSettings}
                  />
                ) : null}
              </>
            ) : (
              <CardSkeletons label={THING_PAGE_COPY.loading} count={2} />
            )}
          </>
        ) : (
          <>
            {service ? (
              <ServiceHead
                page={page}
                problem={problemLine(page, now, timeZone)}
                onAsk={subject ? askAbout : null}
                wide={widePage.wide}
              />
            ) : (
              <>
                <ServiceHead
                  page={page}
                  problem={problemLine(page, now, timeZone)}
                  onAsk={null}
                  wide={false}
                  withButtons={false}
                />
                <Actions page={page} onConfirm={setConfirm} buttons={buttons} />
              </>
            )}
            {query.error ? (
              // A failed refresh keeps the saved page, Needs a look and its problems with it; its controls may have changed.
              <ReadNote
                title={OVERVIEW_WORDS.couldntRefresh(page.name)}
                body={OVERVIEW_WORDS.keepPage}
                onRetry={() => void query.refetch()}
                error={query.error}
              />
            ) : null}
            <View
              onLayout={(e) => {
                tabsAt.current = e.nativeEvent.layout.y;
              }}
            >
              <ThingTabs
                tabs={tabs}
                value={shown}
                onChange={setTab}
                onSettings={() => openSettings?.()}
                label={THING_PAGE_COPY.tabs(page.name)}
                inset={INSET}
              />
            </View>
            {shown === 'activity' ? (
              <ThingActivity page={page} ctx={ctx} />
            ) : (
              <>
                {shown === tabs[0]?.key ? <LookCard page={page} onAsk={askAbout} /> : null}
                {shown === tabs[0]?.key ? (
                  <SummaryPanels
                    key={shown}
                    // The current problems before the controls, whatever the page's own order.
                    panels={problemsFirst(shownPanels(page.tabs.find((t) => t.key === shown)?.panels ?? []))}
                    ctx={ctx}
                    range={{ options: ranges, value: shownRange, onChange: setRange }}
                    wide={widePage.wide}
                  />
                ) : (
                  <TabPanels
                    key={shown}
                    panels={shownPanels(page.tabs.find((t) => t.key === shown)?.panels ?? [])}
                    ctx={ctx}
                    wide={widePage.wide}
                  />
                )}
                {/* A NAS that keeps this Whombat's backups (backup-places.md AP-6721). */}
                {shown === tabs[0]?.key && page.catalogId && placeKindOfCatalog(page.catalogId) ? (
                  <BackupsKeptHere thing={page.id} />
                ) : null}
                {shown === tabs[0]?.key && subject && !service ? (
                  <BigButton label={THING_PAGE_COPY.ask(page.name)} variant="secondary" onPress={askAbout} />
                ) : null}
              </>
            )}
          </>
        )}
      </ScrollView>
      <NewChatSheet
        visible={!!asking}
        onClose={() => setAsking(null)}
        subject={subject}
        back={name}
        initialText={asking?.text ?? null}
      />
      {page && more ? (
        <OneSheet
          visible={menu}
          onClose={() => setMenu(false)}
          title={page.name}
          buttons={[
            { id: 'close', label: THING_PAGE_COPY.close, variant: 'quiet', onPress: () => setMenu(false) },
          ]}
        >
          <View style={{ marginTop: 16 }}>
            <Actions
              page={page}
              onConfirm={(a) => {
                setMenu(false);
                setConfirm(a);
              }}
              buttons={buttons}
              onPressed={() => setMenu(false)}
              withOpen={false}
            />
          </View>
        </OneSheet>
      ) : null}
      {page && confirm ? (
        <ConfirmSheet page={page} thingId={thingId} action={confirm} onClose={() => setConfirm(null)} />
      ) : null}
      {page && buttons.asking ? (
        <QuestionSheet
          badge={page.name}
          title={buttons.asking.confirm.title}
          body={buttons.asking.confirm.body}
          button={buttons.asking.confirm.button}
          busy={buttons.asking.busy}
          onYes={buttons.confirm}
          onClose={buttons.cancel}
          note={null}
        />
      ) : null}
    </Screen>
  );
}

/* The head -------------------------------------------------------------------------------------------------------- */

/**
 * The head's top: the glyph or mark and the name, then the status dot and the badge's words. The page's, or before it
 * answers the row the app holds (AP-2650), drawn the same so nothing moves when the page comes; no status, no dot line.
 */
function HeadTop({
  thing,
  verdict = null,
}: {
  thing: Pick<ThingHeadPreview, 'icon' | 'catalogId' | 'kind' | 'name' | 'status' | 'badge'>;
  /** A service's one sentence (service-settings.md SST-10): in place of the badge, beside the same dot. */
  verdict?: string | null;
}) {
  const theme = useTheme();
  // Before it answers, the row the app holds may have words without a status: TalkBack hears them, nothing is drawn.
  const line = verdict ?? (thing.status ? thing.badge : null);
  return (
    <View
      style={{ gap: 6 }}
      accessible
      accessibilityRole="header"
      accessibilityLabel={headSpoken({ name: thing.name, badge: verdict ?? thing.badge })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <ThingIcon glyph={thingGlyph(thing)} mark={thingMark(thing)} size={24} color={theme.colors.ink2} />
        <Text size={28} weight={700} tracking={-0.02} numberOfLines={2} style={{ flexShrink: 1 }}>
          {thing.name}
        </Text>
      </View>
      {line ? (
        <View style={{ flexDirection: 'row', alignItems: verdict ? 'flex-start' : 'center', gap: 8 }}>
          {thing.status ? (
            <View style={verdict ? { paddingTop: 6 } : undefined}>
              <ThingDot status={thing.status} />
            </View>
          ) : null}
          <Text
            size={verdict ? 15 : 14}
            lh={verdict ? 1.4 : undefined}
            color={theme.colors.ink2}
            numberOfLines={verdict ? 3 : 1}
            style={{ flexShrink: 1 }}
          >
            {line}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * A connection's or device's head (docs/app/decisions/phone-refresh-status.md, as the web's): its mark and name; the
 * status pill and why on the first line; “Runs on {host}”, the address (a press copies it) and when it was last checked
 * on the next; its other facts — version, Docker, database, uptime — behind “More detail”; what couldn't be read; then,
 * for a service, two buttons across, 46dp: Ask {assistant} and Open (named “Open Home Assistant”). On a wide page the
 * buttons stand beside the name instead, in the right half, as on the web.
 */
function ServiceHead({
  page,
  problem,
  onAsk,
  wide,
  withButtons = true,
}: {
  page: ThingPage;
  problem: string | null;
  onAsk: (() => void) | null;
  wide: boolean;
  /** Ask and Open under the head (a service's); a page without them keeps its own actions under it. */
  withButtons?: boolean;
}) {
  const theme = useTheme();
  const agent = useAgentWords();
  const navigation = useAppNavigation();
  const [detailOpen, setDetailOpen] = useState(false);
  const open = withButtons ? page.open : undefined;
  const verdict = page.verdict?.trim() || null;
  const runsOn = page.runsOn;
  const level = thingStatusLevel(page.status);
  const { checked, detail } = headFacts(page.facts);
  const openRunsOn = () => {
    if (!runsOn) return;
    const to = runsOnTarget(runsOn);
    if (to.screen === 'Guest')
      navigation.navigate('Guest', {
        serverId: to.serverId,
        guestId: to.guestId,
        title: to.title,
        back: page.name,
      });
    else navigation.navigate('Thing', { thingId: to.thingId, title: to.title, back: page.name });
  };
  const buttons =
    withButtons && (onAsk || open) ? (
      <View
        style={{ flexDirection: 'row', gap: 10, ...(wide ? { justifyContent: 'flex-end' as const } : {}) }}
      >
        {onAsk ? (
          <HeadWideButton label={agent.ask} icon={MessageCircle} primary onPress={onAsk} grow={!wide} />
        ) : null}
        {open ? (
          <HeadWideButton
            label={THING_PAGE_COPY.openWord}
            spoken={open.label}
            icon={ExternalLink}
            hint={THING_PAGE_COPY.open(open.label)}
            onPress={() => void Linking.openURL(open.url).catch(() => {})}
            grow={!wide}
          />
        ) : null}
      </View>
    ) : null;
  const where = runsOn || page.address || checked;
  const info = (
    <View style={{ gap: 12 }}>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={headSpoken({ name: page.name, badge: page.badge })}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <ThingIcon glyph={thingGlyph(page)} mark={thingMark(page)} size={30} color={theme.colors.ink2} />
        <Text size={30} weight={700} lh={1.05} tracking={-0.02} numberOfLines={2} style={{ flexShrink: 1 }}>
          {page.name}
        </Text>
      </View>
      {/* The first line: how it is, and why. */}
      <View
        style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 6 }}
      >
        <LevelPill level={level} word={page.badge} />
        {verdict ? (
          <Text size={15} lh={1.4} color={theme.colors.ink2} style={{ flexShrink: 1, minWidth: 160 }}>
            {verdict}
          </Text>
        ) : null}
      </View>
      {where ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            columnGap: 14,
            marginVertical: -4,
          }}
        >
          {runsOn ? (
            <Touchable
              onPress={openRunsOn}
              feedback="fade"
              ringRadius={8}
              accessibilityRole="link"
              accessibilityLabel={`${THING_PAGE_COPY.runsOn} ${runsOn.name}`}
              accessibilityHint={THING_PAGE_COPY.runsOnHint}
              // 36 tall with slop to 44, so the wrapped lines sit close.
              hitSlop={hitSlopFor(36)}
              style={{ minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}
            >
              <Text size={13.5} color={theme.colors.mut}>
                {`${THING_PAGE_COPY.runsOn} `}
              </Text>
              <Text
                size={13.5}
                weight={500}
                mono
                color={theme.colors.brand}
                numberOfLines={1}
                style={{ flexShrink: 1 }}
              >
                {runsOn.name}
              </Text>
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <ChevronRight size={15} color={theme.colors.brand} strokeWidth={2} />
              </View>
            </Touchable>
          ) : null}
          {page.address ? <CopyAddress address={page.address} /> : null}
          {checked ? <FactLine line={checked} /> : null}
        </View>
      ) : null}
      {detail.length ? (
        <View>
          <Touchable
            onPress={() => setDetailOpen((o) => !o)}
            feedback="fade"
            ringRadius={8}
            accessibilityRole="button"
            accessibilityState={{ expanded: detailOpen }}
            style={{
              alignSelf: 'flex-start',
              minHeight: 44,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              marginVertical: -8,
            }}
          >
            <Text size={13.5} weight={500} color={theme.colors.brand}>
              {THING_PAGE_COPY.moreDetail}
            </Text>
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              {detailOpen ? (
                <ChevronUp size={15} color={theme.colors.brand} strokeWidth={2} />
              ) : (
                <ChevronDown size={15} color={theme.colors.brand} strokeWidth={2} />
              )}
            </View>
          </Touchable>
          {detailOpen ? (
            <View style={{ gap: 2, marginTop: 8 }}>
              {detail.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the head's lines in their order
                <FactLine key={i} line={line} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {problem ? (
        <Text size={13.5} lh={1.45} color={theme.colors.warnText} accessibilityLiveRegion="polite">
          {problem}
        </Text>
      ) : null}
    </View>
  );
  if (!buttons) return info;
  if (wide)
    return (
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 28 }}>
        <View style={{ flex: 1, minWidth: 0 }}>{info}</View>
        <View style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>{buttons}</View>
      </View>
    );
  return (
    <View style={{ gap: 16 }}>
      {info}
      {buttons}
    </View>
  );
}

/** The address in mono; a press copies it (“Address copied.”), as the web's. */
function CopyAddress({ address }: { address: string }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={() => void copyToClipboard(address, THING_PAGE_COPY.addressCopied)}
      feedback="fade"
      ringRadius={8}
      accessibilityRole="button"
      accessibilityLabel={THING_PAGE_COPY.copyAddress(address)}
      hitSlop={hitSlopFor(36)}
      style={{ minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 }}
    >
      <Text size={12.5} mono color={theme.colors.ink2} numberOfLines={1} style={{ flexShrink: 1 }}>
        {address}
      </Text>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Copy size={13} color={theme.colors.mut} strokeWidth={1.9} />
      </View>
    </Touchable>
  );
}

/** One of a service head's two buttons: 46dp, its icon first, sharing the width. */
function HeadWideButton({
  label,
  spoken,
  icon: Icon,
  primary = false,
  hint,
  onPress,
  grow = true,
}: {
  label: string;
  /** What VoiceOver and TalkBack say when the words on it are short (“Open” → “Open Home Assistant”). */
  spoken?: string;
  icon: LucideIcon;
  primary?: boolean;
  hint?: string;
  onPress: () => void;
  /** Share the width (a phone); else as wide as its words. */
  grow?: boolean;
}) {
  const theme = useTheme();
  const color = primary ? theme.colors.btnfg : theme.colors.ink;
  return (
    <Touchable
      onPress={onPress}
      feedback={primary ? 'fade' : 'wash'}
      ringRadius={12}
      accessibilityRole="button"
      accessibilityLabel={spoken ?? label}
      accessibilityHint={hint}
      style={{
        ...(grow ? { flex: 1 } : {}),
        minHeight: 46,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: primary ? theme.colors.btn : theme.colors.line2,
        backgroundColor: primary ? theme.colors.btn : theme.colors.sf,
      }}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Icon size={16} color={color} strokeWidth={1.9} />
      </View>
      <Text size={15.5} weight={600} color={color} numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}
      </Text>
    </Touchable>
  );
}

/* Actions --------------------------------------------------------------------------------------------------------- */

/**
 * Restart (for those who may manage it; asked first), the page's own buttons (CT-1014: Check for updates, Arm; drawn for
 * everyone, greyed with their reason for those who may not) and “Open Home Assistant” (the browser), side by side.
 */
function Actions({
  page,
  onConfirm,
  buttons,
  onPressed,
  withOpen = true,
}: {
  page: ThingPage;
  onConfirm: (a: ThingPageAction) => void;
  buttons: ThingButtons;
  /** Before a page's own button runs (the ⋯ sheet they sit in closes). */
  onPressed?: () => void;
  /** “Open Plex” among them; a service's head has its own. */
  withOpen?: boolean;
}) {
  const actions = page.actions;
  const own = page.buttons ?? [];
  const open = withOpen ? page.open : undefined;
  if (!actions.length && !own.length && !open) return null;
  const refused = [
    ...new Set(
      [...actions, ...own]
        .filter((a) => !a.allowed && a.reason?.trim())
        .map((a) => (a.reason as string).trim()),
    ),
  ];
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {actions.map((a) => (
          <Button
            key={a.id}
            label={a.label}
            variant="secondary"
            disabled={!a.allowed}
            onPress={() => onConfirm(a)}
            accessibilityHint={a.allowed ? a.confirm.title : a.reason}
            style={{ flexGrow: 1, flexBasis: '30%' }}
          />
        ))}
        {own.map((b) => (
          <HeadButton
            key={thingButtonKey(b)}
            button={b}
            act={buttons}
            {...(onPressed ? { onPressed } : {})}
          />
        ))}
        {open ? (
          <Button
            label={open.label}
            variant="secondary"
            onPress={() => void Linking.openURL(open.url).catch(() => {})}
            accessibilityHint={THING_PAGE_COPY.open(open.label)}
            // Beside the page's own buttons each takes its words' width and the row shares what is left.
            style={{ flexGrow: 1, flexBasis: own.length ? 'auto' : '45%' }}
          />
        ) : null}
      </View>
      {refused.map((r) => (
        <QuietLine key={r} text={r} />
      ))}
    </View>
  );
}

function QuietLine({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text size={13} lh={1.45} color={theme.colors.mut}>
      {text}
    </Text>
  );
}

/** An action's question (CP-12): its words from the server, the button, Cancel; what went wrong stays in the sheet. */
function ConfirmSheet({
  page,
  thingId,
  action,
  onClose,
}: {
  page: ThingPage;
  thingId: string;
  action: ThingPageAction;
  onClose: () => void;
}) {
  const { slug } = useBurrowBase();
  const act = useThingAction(slug, thingId);
  const [error, setError] = useState<string | null>(null);
  const go = () => {
    setError(null);
    act.mutateAsync(action.id).then(
      (result) => {
        if (result.status !== 'ok') {
          const text = outcomeText(result);
          return setError(text ? `${text.title}. ${text.body}` : THING_PAGE_COPY.failed);
        }
        onClose();
        showNotice(result.data.message);
      },
      (e: unknown) => setError(errorText(e)),
    );
  };
  return (
    <QuestionSheet
      badge={page.name}
      title={action.confirm.title}
      body={action.confirm.body}
      button={action.confirm.button}
      busy={act.isPending}
      onYes={go}
      onClose={onClose}
      note={error}
    />
  );
}

/**
 * The question before a button that matters (CP-12, SD-07): Restart's and every button's with `confirm` — the page's
 * name, the server's title and words, its button and Cancel; busy while it runs (Cancel waits).
 */
function QuestionSheet({
  badge,
  title,
  body,
  button,
  busy,
  onYes,
  onClose,
  note,
}: {
  badge: string;
  title: string;
  body: string;
  button: string;
  busy: boolean;
  onYes: () => void;
  onClose: () => void;
  note: string | null;
}) {
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={badge}
      tone="warn"
      title={title}
      body={body}
      busy={busy ? 'yes' : null}
      buttons={[
        { id: 'yes', label: button, variant: 'primary', onPress: onYes },
        { id: 'cancel', label: THING_PAGE_COPY.cancel, variant: 'quiet', onPress: onClose },
      ]}
      note={note}
    />
  );
}
