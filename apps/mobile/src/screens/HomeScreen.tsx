/**
 * Overview, the page of everything the assistant looks after (docs/decisions/overview-one-page.md, the phone form of
 * OVP-11; overview-server-connection-final.md OSC-01, OSC-08, OSC-09). The `Dashboard` route, `HomeScreen` in code (code
 * names stay, AP-2501). The title, then the jump chips (one per section, each scrolling to it; none with one section
 * alone), the broken thing first or the status sentence, then the sections one under the other in one scroll view:
 * Servers (a card per server), Connections (a tile per connection and device) and Pinned (what was pinned from a chat).
 * The sections, their counts, dots and lines are the shared `overviewSections`. An old `?tab=` address
 * (`whombat://connections?tab=servers`) scrolls to its section. Live through `home.changed` and the `hosts` topic; pull
 * to refresh sorts worst first again.
 */
import { type NavigationProp, type RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import {
  type ConnectionsTab,
  homeSections,
  homeStatus,
  OVERVIEW_WORDS,
  overviewHeadline,
  overviewSectionForTab,
  overviewSections,
  readingsMoment,
  readState,
  widgetChart,
} from '@whombat/client';
import { isHostsUnavailable } from '@whombat/client/hosts';
import { useHostsFleet, useHostsStatus } from '@whombat/client/hosts/react';
import { useHomeOverview } from '@whombat/client/react';
import type { HomeOverview } from '@whombat/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type LayoutChangeEvent, RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import { CONNECTIONS_COPY, jumpOffset, overviewChips } from '../data/home';
import { useAgentWords } from '../data/useAgent';
import { useAppNavigation } from '../navigation/hooks';
import type { TabParamList } from '../navigation/routes';
import { PushRationaleCard } from '../push/PushRationaleCard';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { LARGE_TITLE_LEFT, Screen } from '../ui/headers';
import { QuietText } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';
import { TabTop } from '../ui/topRow';
import { BrokenCard, CardSkeletons, JumpChips, OthersLink, ReadNote } from './home/OverviewParts';
import { PanelsCards } from './home/PanelsCards';
import { ServersCard } from './home/ServersCard';
import { ServicesCard } from './home/ServicesCard';

/** The page's side padding. */
const PAD = 16;
/** How much further in the title sits, so it starts where the large titles do (22). */
const TITLE_INSET = LARGE_TITLE_LEFT - PAD;
/** The room above a section's heading (the mock's 32): the list's own 16 between parts and 16 more. */
const SECTION_ROOM = 16;

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
  const views = useMemo(
    () => overviewSections(sections, fleet.data?.servers ?? null),
    [sections, fleet.data?.servers],
  );
  const chips = useMemo(() => overviewChips(views), [views]);
  // A pull to refresh sorts the servers and connections worst first again; live changes keep their order.
  const [sortKey, setSortKey] = useState(0);
  // On an iPhone the list runs on under iOS's tab bar and ends above it.
  const bottomRoom = useBottomRoom();
  const refresh = () => {
    setSortKey((k) => k + 1);
    void home.refetch();
    void hosts.refetch();
  };
  // Loading, a failed first read, a failed refresh (the saved readings stay) and refreshing are kept apart.
  const state = readState({ hasData: !!data, error: home.error, fetching: home.isFetching });
  // The broken thing leads (its own card); else the status sentence as before.
  const headline = useMemo(() => (data ? overviewHeadline(data, { timeZone }) : null), [data, timeZone]);
  const broken = headline?.kind === 'broken' ? headline : null;
  const brokenItem = (broken && data?.needsYou.find((i) => i.id === broken.itemId)) || null;
  const navigation = useAppNavigation();
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
      <TabTop title={CONNECTIONS_COPY.title} />
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
        {/* The status line at the large titles' 22 from the edge, the chips and cards at the page's 16. */}
        <View style={{ gap: 6, marginTop: 4 }}>
          {data && !broken ? (
            <View style={{ paddingHorizontal: TITLE_INSET }}>
              <StatusLine overview={data} />
            </View>
          ) : null}
          {state === 'ready' || state === 'saved' || state === 'refreshing' ? (
            <JumpChips chips={chips} onJump={(key) => jump(key)} />
          ) : null}
        </View>
        {broken ? (
          <>
            <BrokenCard headline={broken} item={brokenItem} />
            <OthersLink
              count={broken.others}
              onPress={() => navigation.navigate('Tabs', { screen: 'NeedsYou' })}
            />
          </>
        ) : null}
        <PushRationaleCard />
        {state === 'loading' ? (
          <CardSkeletons label={OVERVIEW_WORDS.loading(CONNECTIONS_COPY.title)} tiles={4} />
        ) : state === 'failed' || !data ? (
          <ReadNote
            title={OVERVIEW_WORDS.couldntRead(CONNECTIONS_COPY.title)}
            body={OVERVIEW_WORDS.noSaved}
            onRetry={refresh}
            error={home.error}
          />
        ) : sections.length === 0 ? (
          <QuietText>{CONNECTIONS_COPY.empty(assistant)}</QuietText>
        ) : (
          <>
            {savedNote ? (
              <ReadNote title={savedNote.title} body={savedNote.body} onRetry={refresh} error={home.error} />
            ) : null}
            {views.map((view) => {
              const section = sections.find((s) => s.kind === SECTION_KIND[view.key]);
              if (!section) return null;
              return (
                <View key={view.key} style={{ marginTop: SECTION_ROOM }} onLayout={placeOf(view.key)}>
                  {section.kind === 'servers' ? (
                    <ServersCard view={view} sortKey={sortKey} />
                  ) : section.kind === 'things' ? (
                    <ServicesCard
                      view={view}
                      rows={section.rows}
                      things={data.things}
                      add={section.add}
                      sortKey={sortKey}
                    />
                  ) : section.kind === 'panels' ? (
                    <PanelsCards view={view} widgets={section.widgets} />
                  ) : null}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
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
