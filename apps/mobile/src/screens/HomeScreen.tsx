/**
 * Overview, the page of everything the assistant looks after (docs/decisions/overview-arranged.md; the
 * phone form of overview-one-page.md; overview-server-connection-final.md). The
 * `Dashboard` route, `HomeScreen` in code. The title with Arrange beside it, the jump chips
 * (one per section, each scrolling to it; none with one section alone), then one scroll view: the summary card (the
 * broken thing or how things are, and the four figures), Today, Connections (a tile per connection, device and account,
 * in the person's order), Servers (a card per server) and Pinned (what was pinned from a chat). While arranged, every
 * tile, figure and pinned chart has a gear that opens its sheet, and every choice is saved at once for every device. An
 * older Whombat, which can't keep a layout, has no Arrange: its tiles keep Overview's order. An old `?tab=` address
 * (`whombat://connections?tab=servers`) scrolls to its section. Live through `home.changed` and the `hosts` topic; pull
 * to refresh sorts the servers (and, never arranged, the tiles) worst first again.
 */
import { type NavigationProp, type RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import {
  ARRANGE_WORDS,
  addTile,
  arrangePins,
  arrangeTiles,
  type ConnectionsTab,
  type HomeSection,
  homeSections,
  homeStatus,
  layoutNow,
  moveTileBy,
  OVERVIEW_STARTING_TOP,
  OVERVIEW_WORDS,
  type OverviewTile,
  overviewHeadline,
  overviewSectionForTab,
  overviewSections,
  overviewSpecs,
  overviewTiles,
  rangeOfTile,
  readingsMoment,
  readState,
  removeTile,
  setPin,
  setTopFigure,
  showId,
  showOnTile,
  sizeTile,
  viewFace,
  widgetChart,
} from '@whombat/client';
import { isHostsUnavailable } from '@whombat/client/hosts';
import { useHostsFleet, useHostsStatus } from '@whombat/client/hosts/react';
import { useArrangeOverview, useHomeOverview, useMoveWidget, useOverviewViews } from '@whombat/client/react';
import type { HomeOverview, OverviewLayout, OverviewLayoutPin } from '@whombat/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, type LayoutChangeEvent, RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import { CONNECTIONS_COPY, jumpOffset, overviewChips } from '../data/home';
import { pinMovePosition } from '../data/overviewArranged';
import { phoneThingGlyph } from '../data/thingLook';
import { useAgentWords } from '../data/useAgent';
import { useStatusOrder } from '../data/useStatusOrder';
import { useAppNavigation } from '../navigation/hooks';
import type { TabParamList } from '../navigation/routes';
import { PushRationaleCard } from '../push/PushRationaleCard';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Screen } from '../ui/headers';
import { QuietText } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';
import { TabTop } from '../ui/topRow';
import { showNotice } from './feedback';
import { ArrangeBar, ArrangeToggle } from './home/ArrangedParts';
import { type ArrangeActions, ArrangeSheet, type ArrangeTarget } from './home/ArrangeSheets';
import { CardSkeletons, JumpChips, ReadNote } from './home/OverviewParts';
import { PanelsCards } from './home/PanelsCards';
import { ServersCard } from './home/ServersCard';
import { ServicesCard } from './home/ServicesCard';
import { SummaryCard } from './home/SummaryCard';
import { TodayCard } from './home/TodayCard';

/** The page's side padding. */
const PAD = 16;
/** The room above a section's heading (the mock's 32): the list's own 16 between parts and 16 more. */
const SECTION_ROOM = 16;
/** The sections in the page's order: Connections, Servers, Pinned. */
const PAGE_ORDER: readonly ConnectionsTab[] = ['services', 'servers', 'pinned'];

const tileId = (t: OverviewTile) => t.row.id;
const tileLevel = (t: OverviewTile) => t.row.level;

export function HomeScreen() {
  const theme = useTheme();
  const { slug, timeZone } = useBurrowBase();
  const now = useNow();
  const assistant = useAgentWords();
  const home = useHomeOverview({ params: { burrow: slug } });
  const data: HomeOverview | undefined = home.data;
  // Servers shows where the hosts service runs (or says it can't be reached); the section reads the fleet itself.
  const hosts = useHostsStatus({ params: { burrow: slug } }, { retry: false });
  const servers = hosts.data?.present === true || isHostsUnavailable(hosts.error);
  // The same read as the Servers section's, so the heading's count matches its cards.
  const fleet = useHostsFleet(hosts.data?.present === true ? { params: { burrow: slug } } : null, {
    retry: false,
  });
  // Whoever has Connections in Settings has Add a connection here (AP-2258).
  const sections = useMemo(
    () => (data ? homeSections(data, { now, timeZone, servers, canAddConnection: true }) : []),
    [data, now, timeZone, servers],
  );
  // A pull to refresh sorts the servers and connections worst first again; live changes keep their order.
  const [sortKey, setSortKey] = useState(0);

  /* The arranged page ----------------------------------------------------------------------------- */

  // Undefined: an older Whombat (no Arrange); null: never arranged (the starting layout).
  const arranged = data?.arranged;
  const canArrange = arranged !== undefined;
  const thingsSection = sections.find((s) => s.kind === 'things');
  const panelsSection = sections.find((s) => s.kind === 'panels');
  const allTiles = useMemo(
    () =>
      thingsSection && data
        ? overviewTiles(thingsSection.rows, data.things, now, timeZone, assistant.name)
        : [],
    [thingsSection, data, now, timeZone, assistant.name],
  );
  const ordered = useStatusOrder(allTiles, tileId, tileLevel, sortKey);
  const tiles = useMemo(() => arrangeTiles(arranged, ordered), [arranged, ordered]);
  const thingRows = useMemo(() => ordered.map((t) => t.row), [ordered]);
  const top = arranged?.top?.length ? arranged.top : OVERVIEW_STARTING_TOP;
  const specs = useMemo(
    () =>
      canArrange
        ? overviewSpecs(
            tiles.shown.map((s) => s.tile),
            top,
          )
        : null,
    [canArrange, tiles.shown, top],
  );
  const tileViews = useOverviewViews(slug, specs).data;
  const pins = useMemo(() => arrangePins(arranged, panelsSection?.widgets ?? []), [arranged, panelsSection]);
  // Pinned charts removed from the Overview leave its section (and its jump link's count).
  const shownSections = useMemo(
    () =>
      sections.flatMap((s): HomeSection[] =>
        s.kind !== 'panels' ? [s] : pins.shown.length ? [{ ...s, widgets: pins.shown }] : [],
      ),
    [sections, pins.shown],
  );
  const views = useMemo(
    () => overviewSections(shownSections, fleet.data?.servers ?? null),
    [shownSections, fleet.data?.servers],
  );
  const chips = useMemo(() => overviewChips(views), [views]);
  const pageViews = useMemo(
    () => [...views].sort((a, b) => PAGE_ORDER.indexOf(a.key) - PAGE_ORDER.indexOf(b.key)),
    [views],
  );
  const looks = useMemo(() => {
    const byId = new Map((data?.things ?? []).map((t) => [t.id, t]));
    return new Map(
      ordered.map((t) => {
        const thing = byId.get(t.row.id);
        return [
          t.row.id,
          { glyph: thing ? phoneThingGlyph(thing) : t.row.glyph, mark: t.row.mark, name: t.row.name },
        ];
      }),
    );
  }, [data?.things, ordered]);
  const glyphOf = useCallback((thing: string) => looks.get(thing) ?? null, [looks]);

  const [arranging, setArranging] = useState(false);
  const [target, setTarget] = useState<ArrangeTarget | null>(null);
  const [failed, setFailed] = useState(false);
  const arrange = useArrangeOverview(slug);
  const moveWidget = useMoveWidget(slug);
  const endArranging = useCallback(() => {
    setTarget(null);
    setArranging(false);
    setFailed(false);
  }, []);
  // Android's back ends arranging first (a sheet closes itself before).
  useEffect(() => {
    if (!arranging) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      endArranging();
      return true;
    });
    return () => sub.remove();
  }, [arranging, endArranging]);
  // An older Whombat (after a restore, say) can't be arranged: the mode ends.
  useEffect(() => {
    if (!canArrange && arranging) endArranging();
  }, [canArrange, arranging, endArranging]);
  const fail = () => {
    setFailed(true);
    showNotice(ARRANGE_WORDS.couldntSave);
  };
  // Every choice saves the whole layout as the page shows it now, changed.
  const save = (edit: (layout: OverviewLayout) => OverviewLayout) => {
    if (!data) return;
    setFailed(false);
    arrange.mutate(edit(layoutNow(data.arranged, thingRows)), {
      onSuccess: (result) => {
        if (result.status !== 'ok') fail();
      },
      onError: fail,
    });
  };
  const allPinIds = (panelsSection?.widgets ?? []).map((w) => w.id);
  const shownPinIds = pins.shown.map((w) => w.id);
  const actions: ArrangeActions = {
    show: (thing, choice) =>
      save((l) => {
        const range = l.tiles.find((t) => t.thing === thing)?.range;
        return showOnTile(l, thing, { ...choice.show, ...(range ? { range } : {}) });
      }),
    range: (thing, range) => save((l) => rangeOfTile(l, thing, range)),
    size: (thing, size) => save((l) => sizeTile(l, thing, size)),
    move: (thing, by) => save((l) => moveTileBy(l, thing, by)),
    remove: (thing) => save((l) => removeTile(l, thing)),
    add: (thing) => save((l) => addTile(l, thing)),
    top: (index, figure) => save((l) => setTopFigure(l, index, figure)),
    pinSize: (id, size) => save((l) => setPin(l, id, { size })),
    canPinMove: (id, by) => pinMovePosition(allPinIds, shownPinIds, id, by) !== null,
    pinMove: (id, by) => {
      const position = pinMovePosition(allPinIds, shownPinIds, id, by);
      if (position === null) return;
      setFailed(false);
      moveWidget.mutate(
        { widgetId: id, position },
        {
          onSuccess: (result) => {
            if (result.status !== 'ok') fail();
          },
          onError: fail,
        },
      );
    },
    pinRemove: (id) => save((l) => setPin(l, id, { hidden: true })),
    pinAdd: (id) => save((l) => setPin(l, id, { hidden: undefined } as OverviewLayoutPin)),
  };
  const pinSizes = useMemo(
    () => Object.fromEntries(pins.shown.map((p) => [p.id, p.size])) as Record<string, 'half' | 'full'>,
    [pins.shown],
  );

  // On an iPhone the list runs on under iOS's tab bar and ends above it.
  const bottomRoom = useBottomRoom();
  const refresh = () => {
    setSortKey((k) => k + 1);
    void home.refetch();
    void hosts.refetch();
  };
  // Loading, a failed first read, a failed refresh (the saved readings stay) and refreshing are kept apart.
  const state = readState({ hasData: !!data, error: home.error, fetching: home.isFetching });
  // The broken thing leads the summary card; else how things are.
  const headline = useMemo(() => (data ? overviewHeadline(data, { timeZone }) : null), [data, timeZone]);
  const broken = headline?.kind === 'broken' ? headline : null;
  const brokenItem = (broken && data?.needsYou.find((i) => i.id === broken.itemId)) || null;
  const navigation = useAppNavigation();
  const toInbox = () => navigation.navigate('Tabs', { screen: 'NeedsYou' });
  // With Pinned alone a failed refresh says how old its readings are; else every server keeps its own time.
  const savedNote = useMemo(() => {
    if (state !== 'saved' || !data) return null;
    const only = sections.length === 1 ? sections[0] : null;
    if (only?.kind === 'panels') {
      const lastAt = Math.max(
        ...only.widgets.map((w) => widgetChart(w, timeZone).lastAt ?? Number.NEGATIVE_INFINITY),
      );
      return Number.isFinite(lastAt)
        ? { title: OVERVIEW_WORDS.savedFrom(readingsMoment(lastAt, timeZone)), body: OVERVIEW_WORDS.keepLast }
        : { title: OVERVIEW_WORDS.savedUnknown, body: OVERVIEW_WORDS.keepLast };
    }
    return { title: OVERVIEW_WORDS.couldntRefresh(CONNECTIONS_COPY.title), body: OVERVIEW_WORDS.savedEach };
  }, [state, data, sections, timeZone]);

  // Where each section sits in the list, for the jump chips and an old `?tab=` address.
  const scroller = useRef<ScrollView>(null);
  const placed = useRef<Partial<Record<ConnectionsTab, number>>>({});
  const jump = useCallback((key: ConnectionsTab, animated = true) => {
    const y = placed.current[key];
    if (y === undefined) return false;
    scroller.current?.scrollTo({ y: jumpOffset(y), animated });
    return true;
  }, []);
  const placeOf = (key: ConnectionsTab) => (e: LayoutChangeEvent) => {
    placed.current[key] = e.nativeEvent.layout.y;
    if (asked === key) landAsked();
  };
  // A link that names a section (`?tab=`) scrolls there once the section is drawn, then forgets it, so coming back
  // to the tab later opens where the person left it.
  const route = useRoute<RouteProp<TabParamList, 'Dashboard'>>();
  const tabNavigation = useNavigation<NavigationProp<TabParamList, 'Dashboard'>>();
  const asked = overviewSectionForTab(route.params?.tab);
  // The servers' cards replace their placeholders when the fleet arrives, moving what is under them: until then a
  // section asked for is followed as it moves.
  const settled = !servers || !!fleet.data || !!fleet.error;
  const landAsked = () => {
    if (asked && jump(asked, false) && settled) tabNavigation.setParams({ tab: undefined });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: tries again when the asked section is drawn
  useEffect(() => {
    if (asked) landAsked();
  }, [asked, views, settled]);

  return (
    <Screen>
      <TabTop
        title={CONNECTIONS_COPY.title}
        right={
          canArrange ? (
            <ArrangeToggle
              arranging={arranging}
              onPress={() => (arranging ? endArranging() : setArranging(true))}
            />
          ) : null
        }
      />
      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: PAD,
          paddingTop: 6,
          paddingBottom: 18 + bottomRoom,
          gap: 16,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={home.isRefetching}
            onRefresh={refresh}
            colors={[theme.colors.ink]}
            tintColor={theme.colors.mut}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        {state === 'ready' || state === 'saved' || state === 'refreshing' ? (
          <View style={{ marginTop: 4 }}>
            <JumpChips chips={chips} onJump={(key) => jump(key)} />
          </View>
        ) : null}
        {arranging ? <ArrangeBar failed={failed} /> : null}
        <PushRationaleCard />
        {state === 'loading' ? (
          <CardSkeletons label={OVERVIEW_WORDS.loading(CONNECTIONS_COPY.title)} tiles={4} />
        ) : state === 'failed' || !data || !headline ? (
          <ReadNote
            title={OVERVIEW_WORDS.couldntRead(CONNECTIONS_COPY.title)}
            body={OVERVIEW_WORDS.noSaved}
            onRetry={refresh}
            error={home.error}
          />
        ) : (
          <>
            {savedNote ? (
              <ReadNote title={savedNote.title} body={savedNote.body} onRetry={refresh} error={home.error} />
            ) : null}
            <SummaryCard
              overview={data}
              headline={headline}
              item={brokenItem}
              status={<StatusLine overview={data} />}
              onOthers={toInbox}
              figures={{
                top,
                views: tileViews,
                rows: thingRows,
                fleet: fleet.data?.servers ?? null,
                glyphOf,
              }}
              arranging={arranging}
              onGear={(index) => setTarget({ kind: 'figure', index })}
            />
            <TodayCard overview={data} onAll={toInbox} />
            {sections.length === 0 ? <QuietText>{CONNECTIONS_COPY.empty(assistant)}</QuietText> : null}
            {pageViews.map((view) => {
              const section = shownSections.find((s) => s.kind === SECTION_KIND[view.key]);
              if (!section) return null;
              return (
                <View key={view.key} style={{ marginTop: SECTION_ROOM }} onLayout={placeOf(view.key)}>
                  {section.kind === 'servers' ? (
                    <ServersCard view={view} sortKey={sortKey} />
                  ) : section.kind === 'things' ? (
                    <ServicesCard
                      view={view}
                      tiles={tiles.shown}
                      removed={tiles.removed.length + pins.removed.length}
                      views={tileViews}
                      things={data.things}
                      add={section.add}
                      arranging={arranging}
                      onGear={(thing) => setTarget({ kind: 'tile', thing })}
                      onAdd={() => setTarget({ kind: 'add' })}
                    />
                  ) : section.kind === 'panels' ? (
                    <PanelsCards
                      view={view}
                      widgets={section.widgets}
                      arranging={arranging}
                      onGear={(id) => setTarget({ kind: 'pin', id })}
                    />
                  ) : null}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
      {canArrange ? (
        <ArrangeSheet
          target={target}
          onClose={() => setTarget(null)}
          tiles={tiles.shown}
          removed={tiles.removed}
          faceOf={(at) => {
            const v = tileViews?.get(showId(at.tile));
            return v ? viewFace(v) : null;
          }}
          glyphOf={glyphOf}
          top={top}
          pins={pins.shown}
          removedPins={pins.removed}
          pinSizes={pinSizes}
          actions={actions}
          failed={failed}
        />
      ) : null}
    </Screen>
  );
}

/** The shared section each jump link stands for. */
const SECTION_KIND = { servers: 'servers', services: 'things', pinned: 'panels' } as const;

/**
 * The status sentence (mock `.pl`, CN-03): 15/400 `ink2`, what needs the person set in `warn` at 600 (the mock's `<b>`),
 * or what is wrong in `bad` (status-line.md). When it names an Inbox item, its red sentence is a 44dp link to that row
 * (the item's page), on a line of its own, and the rest follows under it.
 */
function StatusLine({ overview }: { overview: HomeOverview }) {
  const theme = useTheme();
  const navigation = useAppNavigation();
  const { timeZone } = useBurrowBase();
  const status = useMemo(() => homeStatus(overview, { timeZone }), [overview, timeZone]);
  const { parts, tone, itemId } = status;
  const strongColor = tone === 'bad' ? theme.colors.bad : theme.colors.warnText;
  const lead = parts[0];
  if (itemId && lead?.strong) {
    const rest = parts
      .slice(1)
      .map((p) => p.text)
      .join('')
      .trim();
    return (
      <View>
        <Touchable
          onPress={() => navigation.navigate('NeedsYouItem', { itemId, back: CONNECTIONS_COPY.title })}
          feedback="fade"
          ringRadius={8}
          accessibilityRole="link"
          accessibilityLabel={lead.text}
          accessibilityHint={CONNECTIONS_COPY.opensInbox}
          style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', marginVertical: -8 }}
        >
          <Text size={15} lh={1.45} weight={600} color={strongColor}>
            {lead.text}
            {'\u00a0›'}
          </Text>
        </Touchable>
        {rest ? (
          <Text size={15} lh={1.45} color={theme.colors.ink2}>
            {rest}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <Text size={15} lh={1.45} color={theme.colors.ink2}>
      {parts.map((p) =>
        p.strong ? (
          <Text key={p.text} size={15} weight={600} color={strongColor}>
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
}
