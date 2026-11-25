/**
 * The Inbox, the phone's second tab (Whombat inbox.md IBX-01…; needs-you-list.md NYL-01…NYL-09): the one list of what
 * needs the person, in the shared groups (`needsYouListView`) — NEEDS YOU (its count is the tab's badge), {ASSISTANT}’S
 * ON IT, HEADS-UPS folded under one row, LATER, and SETTLED pinned at the bottom above the tab bar (inbox.md IBX-09). A row is
 * its glyph on a 28dp tile in its tone, the title, the grey detail, what the assistant says by its face, a chevron. As
 * T3 Code's thread list it swipes left (`SwipeRow`): ✓ Settle at the edge (↶ Bring back on Later and Settled), which a
 * full swipe runs, and ⋯ More beside it — iOS's own menu on iPhone, a sheet elsewhere — with *Ask {assistant} to handle
 * it*, *Talk to {assistant} about it*, *Remind me tomorrow* and *Stop watching this*; a long press opens the same. A tap
 * opens its sheet with every button (with two pages, its page on the right); what the assistant is on opens its thread;
 * a heads-up its place. Live through `home.changed`; pull to refresh.
 */
import type { NeedsYouButton, NeedsYouGlyph, NeedsYouListGroupView, NeedsYouListRow } from '@whombat/client';
import { NEEDS_YOU_WORDS, needsYouApprovalCard, needsYouListView, TEAM_REPORT_WORDS } from '@whombat/client';
import { useHomeOverview, useStartChat } from '@whombat/client/react';
import type { NeedsYouItem } from '@whombat/core';
import { APPROVAL_CARD_WORDS } from '@whombat/core/approvals';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, RefreshControl, ScrollView, useWindowDimensions, View } from 'react-native';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import { startedChatRoute } from '../data/chatRoom';
import { inboxMoreMenu } from '../data/nativeMenu';
import {
  approvalRowDoors,
  groupHeading,
  NEEDS_YOU_TAB,
  type PhoneRowInline,
  phoneRowActions,
  phoneRowHint,
  phoneRowInline,
  phoneRowOpens,
  phoneRowSwipe,
  swipeEdgeLabel,
} from '../data/needsYou';
import { useAgentWords } from '../data/useAgent';
import { navigateTo, openHref, useAppNavigation } from '../navigation/hooks';
import { isBeside, useBeside, usePaneRole } from '../navigation/panes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ApprovalFact, TonightBox } from '../ui/approvalFacts';
import { OneCard } from '../ui/assistant';
import { tint } from '../ui/glanceColors';
import { Screen } from '../ui/headers';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Ellipsis,
  type LucideIcon,
  MessageCircleQuestion,
  Plug,
  Power,
  Server,
  Star,
  TriangleAlert,
  Undo2,
} from '../ui/icons';
import { LookSays } from '../ui/LookSays';
import { hasNativeMenu, MenuSheet, NativeMenu } from '../ui/nativeMenu';
import { Button, SkeletonRows } from '../ui/primitives';
import { ReadNotice, ReadState, readErrorText, TARGET } from '../ui/readState';
import { focusRowSoon, registerRowFocus, rowAfter } from '../ui/rowFocus';
import { useBottomRoom } from '../ui/screenBottom';
import { closeSwipeRows, type SwipeAction, SwipeRow } from '../ui/swipeRow';
import { Touchable } from '../ui/Touchable';
import { TabTop } from '../ui/topRow';
import { useDecisionFeedback } from './feedback';
import { Section } from './home/Section';
import { NeedsYouSheet, useNeedsYouPress } from './NeedsYouSheet';

const GLYPHS: Record<NeedsYouGlyph, LucideIcon> = {
  alert: TriangleAlert,
  power: Power,
  skill: Star,
  question: MessageCircleQuestion,
  connection: Plug,
  server: Server,
};

export function NeedsYouScreen() {
  const theme = useTheme();
  const { slug, timeZone } = useBurrowBase();
  const now = useNow();
  const words = useAgentWords();
  const home = useHomeOverview({ params: { burrow: slug } });
  const view = useMemo(
    () => (home.data ? needsYouListView(home.data, { now, timeZone, assistant: words.name }) : null),
    [home.data, now, timeZone, words.name],
  );
  const navigation = useAppNavigation();
  const list = usePaneRole() === 'list';
  // On an iPhone the list runs on under iOS's tab bar and ends above it.
  const bottomRoom = useBottomRoom();
  const [open, setOpen] = useState<NeedsYouItem | null>(null);
  // Elsewhere than iPhone a row's More is a sheet, for the row it was opened on.
  const [menuFor, setMenuFor] = useState<{ row: NeedsYouListRow; buttons: NeedsYouButton[] } | null>(null);
  const run = useNeedsYouPress();
  const feedback = useDecisionFeedback();
  const start = useStartChat(slug);
  // The list couldn't be read: ask the assistant why, in a new chat (never an answer or a retry of anything).
  const askWhy = async () => {
    const result = await start
      .mutateAsync({ text: NEEDS_YOU_WORDS.readFailedAsk })
      .catch((error: unknown) => {
        feedback.onError(error);
        return null;
      });
    if (!result) return;
    if (result.status === 'ok') navigateTo(navigation, startedChatRoute(result.data, NEEDS_YOU_TAB.title));
    else feedback.onResult(result);
  };
  // Every row's id in the order they show, for where focus goes once one settles.
  const order = view?.groups.flatMap((g) => g.rows.map((r) => `inbox:${r.id}`)) ?? [];
  const act = (row: NeedsYouListRow, id: string): Promise<void> => {
    const button = row.buttons.find((b) => b.id === id);
    if (!button) return Promise.resolve();
    return run(row.item, button).then((done) => {
      if (done && (button.kind === 'settle' || button.kind === 'back'))
        focusRowSoon(rowAfter(order, `inbox:${row.id}`));
    });
  };
  const press = (row: NeedsYouListRow) => {
    const opens = phoneRowOpens(row);
    if (!opens) return;
    if (opens.to === 'href') openHref(opens.href);
    // With two pages an item shows on the right page; on one, in its sheet over the list.
    else if (list) navigation.navigate('NeedsYouItem', { itemId: row.id });
    else setOpen(row.item);
  };
  const youEmpty = view ? !view.groups.some((g) => g.key === 'you') : false;
  // Settled is pinned to the bottom of the screen, above the tab bar (inbox.md IBX-09); the list ends above it.
  const settled = view?.groups.find((g) => g.key === 'settled') ?? null;
  const listed = view?.groups.filter((g) => g.key !== 'settled') ?? [];
  return (
    <Screen>
      <TabTop title={NEEDS_YOU_TAB.title} />
      <ScrollView
        onScrollBeginDrag={closeSwipeRows}
        contentContainerStyle={{ paddingBottom: settled ? 18 : 18 + bottomRoom }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={home.isRefetching}
            onRefresh={() => void home.refetch()}
            colors={[theme.colors.ink]}
            tintColor={theme.colors.mut}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View style={{ paddingHorizontal: 16, paddingTop: 10, gap: 16 }}>
          {home.isPending ? (
            <View accessibilityLabel={NEEDS_YOU_WORDS.loading} style={{ gap: 4 }}>
              <Text size={15.5} color={theme.colors.ink2} style={{ paddingHorizontal: 4 }}>
                {NEEDS_YOU_WORDS.loading}
              </Text>
              <SkeletonRows count={4} lines={2} label={NEEDS_YOU_WORDS.loading} />
            </View>
          ) : !view ? (
            // A first read that failed: never an empty list or a new broken thing.
            <ReadState
              problem
              title={NEEDS_YOU_WORDS.readFailed}
              body={NEEDS_YOU_WORDS.noSaved}
              action={{ label: NEEDS_YOU_WORDS.retry, onPress: () => void home.refetch() }}
              second={{
                label: NEEDS_YOU_WORDS.ask(words),
                onPress: () => void askWhy(),
                busy: start.isPending,
              }}
              detail={{ label: NEEDS_YOU_WORDS.moreDetail, text: readErrorText(home.error) }}
            />
          ) : view.empty ? (
            <ReadState
              title={NEEDS_YOU_WORDS.empty}
              body={NEEDS_YOU_WORDS.emptyBody}
              action={{
                label: NEEDS_YOU_WORDS.backToChat,
                onPress: () => navigation.navigate('Tabs', { screen: 'ChatRoom' }),
              }}
            />
          ) : (
            <>
              {/* A refresh that failed keeps the saved list, in its order, under the note. */}
              {home.error && !home.isRefetching ? (
                <ReadNotice title={NEEDS_YOU_WORDS.refreshFailed} body={NEEDS_YOU_WORDS.saved}>
                  <Button
                    label={NEEDS_YOU_WORDS.retry}
                    variant="secondary"
                    onPress={() => void home.refetch()}
                    style={{ alignSelf: 'flex-start', minHeight: TARGET }}
                  />
                </ReadNotice>
              ) : null}
              {youEmpty ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 }}>
                  <Check size={18} color={theme.colors.ok} strokeWidth={2} />
                  <Text size={15} color={theme.colors.ink2} style={{ flex: 1 }}>
                    {NEEDS_YOU_WORDS.nothing}
                  </Text>
                </View>
              ) : null}
              {listed.map((group) => (
                <Group
                  key={group.key}
                  group={group}
                  onPress={press}
                  onAct={act}
                  onMenu={(row, buttons) => setMenuFor({ row, buttons })}
                />
              ))}
            </>
          )}
        </View>
      </ScrollView>
      {settled ? (
        // Under the list in the page's own order (what is read is what is shown), flush above the tab bar.
        <View style={{ paddingBottom: bottomRoom }}>
          <SettledBar
            group={settled}
            onPress={press}
            onAct={act}
            onMenu={(row, buttons) => setMenuFor({ row, buttons })}
          />
        </View>
      ) : null}
      <NeedsYouSheet
        item={open}
        onClose={() => {
          if (open) focusRowSoon(`inbox:${open.id}`);
          setOpen(null);
        }}
      />
      {hasNativeMenu ? null : (
        <MenuSheet
          spec={menuFor ? inboxMoreMenu(menuFor.buttons, menuFor.row.title) : null}
          visible={menuFor !== null}
          label={NEEDS_YOU_TAB.moreLabel}
          onClose={() => setMenuFor(null)}
          onPick={(id) => void (menuFor && act(menuFor.row, id))}
        />
      )}
    </Screen>
  );
}

/**
 * Settled, pinned at the bottom (inbox.md IBX-09): a flush row “Settled · 3” on a hairline (44pt on iPhone, 48dp on
 * Android), no card or shadow, that opens upward into its rows, which scroll on their own (at most about half the
 * screen) and swipe to Bring back and More as the list's rows do. It always opens: with nothing settled into the line
 * that says what it is for, which shows only then.
 */
function SettledBar({
  group,
  onPress,
  onAct,
  onMenu,
}: {
  group: NeedsYouListGroupView;
  onPress: (row: NeedsYouListRow) => void;
  onAct: (row: NeedsYouListRow, id: string) => Promise<void>;
  onMenu: (row: NeedsYouListRow, buttons: NeedsYouButton[]) => void;
}) {
  const theme = useTheme();
  const beside = useBeside();
  const { height } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const empty = group.rows.length === 0;
  const fold = group.fold;
  // No count with nothing settled: a zero isn't news.
  const name = groupHeading(group);
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.line, backgroundColor: theme.colors.bg }}>
      {open ? (
        empty ? (
          <Text
            size={13.5}
            lh={1.45}
            color={theme.colors.mut}
            style={{ paddingHorizontal: 20, paddingTop: 12 }}
          >
            {NEEDS_YOU_WORDS.noneSettled}
          </Text>
        ) : (
          <ScrollView
            style={{ maxHeight: height * 0.45 }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8 }}
            onScrollBeginDrag={closeSwipeRows}
            showsVerticalScrollIndicator={false}
          >
            <View
              style={{
                borderWidth: 1,
                borderColor: theme.colors.line,
                borderRadius: 16,
                overflow: 'hidden',
                backgroundColor: theme.colors.sf,
              }}
            >
              {group.rows.map((row, i) => (
                <Row
                  key={row.id}
                  row={row}
                  first={i === 0}
                  selected={isBeside(beside, 'NeedsYouItem', 'itemId', row.id)}
                  onPress={() => onPress(row)}
                  onAct={(id) => onAct(row, id)}
                  onMenu={(buttons) => onMenu(row, buttons)}
                />
              ))}
            </View>
          </ScrollView>
        )
      ) : null}
      <Touchable
        onPress={() => setOpen((o) => !o)}
        feedback="wash"
        accessibilityRole="button"
        accessibilityLabel={empty ? name : `${name}, ${open ? fold?.hide : fold?.show}`}
        accessibilityState={{ expanded: open }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          minHeight: Platform.OS === 'android' ? 48 : 44,
          paddingHorizontal: 20,
        }}
      >
        <Text size={15} weight={600}>
          {group.label}
        </Text>
        {empty ? null : (
          <Text size={12} mono color={theme.colors.mut}>
            {`· ${group.rows.length}`}
          </Text>
        )}
        <View style={{ flex: 1 }} />
        {open ? (
          <ChevronDown size={16} color={theme.colors.mut} strokeWidth={1.9} />
        ) : (
          <ChevronUp size={16} color={theme.colors.mut} strokeWidth={1.9} />
        )}
      </Touchable>
    </View>
  );
}

/** A group's label over its card; heads-ups and Settled folded under one row until opened. */
function Group({
  group,
  onPress,
  onAct,
  onMenu,
}: {
  group: NeedsYouListGroupView;
  onPress: (row: NeedsYouListRow) => void;
  onAct: (row: NeedsYouListRow, id: string) => Promise<void>;
  onMenu: (row: NeedsYouListRow, buttons: NeedsYouButton[]) => void;
}) {
  const theme = useTheme();
  const beside = useBeside();
  const [unfolded, setUnfolded] = useState(false);
  const folded = group.folded && !unfolded;
  const fold = group.fold;
  return (
    <Section label={groupHeading(group)}>
      <OneCard>
        {fold ? (
          <Touchable
            onPress={() => setUnfolded((u) => !u)}
            feedback="wash"
            accessibilityRole="button"
            accessibilityLabel={folded ? fold.show : fold.hide}
            accessibilityState={{ expanded: !folded }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              minHeight: 44,
              paddingHorizontal: 14,
            }}
          >
            {folded ? (
              <ChevronRight size={16} color={theme.colors.brand} strokeWidth={1.9} />
            ) : (
              <ChevronDown size={16} color={theme.colors.brand} strokeWidth={1.9} />
            )}
            <Text size={13.5} weight={600} color={theme.colors.brand}>
              {folded ? fold.show : fold.hide}
            </Text>
          </Touchable>
        ) : null}
        {folded
          ? null
          : group.rows.map((row, i) => (
              <Row
                key={row.id}
                row={row}
                first={i === 0 && !fold}
                selected={isBeside(beside, 'NeedsYouItem', 'itemId', row.id)}
                onPress={() => onPress(row)}
                onAct={(id) => onAct(row, id)}
                onMenu={(buttons) => onMenu(row, buttons)}
              />
            ))}
      </OneCard>
    </Section>
  );
}

function Row({
  row,
  first,
  selected,
  onPress,
  onAct,
  onMenu,
}: {
  row: NeedsYouListRow;
  first: boolean;
  /** What the right page shows, with two pages. */
  selected: boolean;
  onPress: () => void;
  /** Runs one of its buttons, by id (a swipe, a menu's pick, a screen reader's action, its inline buttons). */
  onAct: (id: string) => Promise<void>;
  /** Opens the More sheet with these buttons, where iOS's own menu isn't. */
  onMenu: (buttons: NeedsYouButton[]) => void;
}) {
  const theme = useTheme();
  const says = row.says;
  const opens = phoneRowOpens(row);
  // What needs the person shows its way forward (an approval its card and answers) under its words; the rest is More.
  const inline = phoneRowInline(row);
  const [busy, setBusy] = useState<string | null>(null);
  const press = (id: string) => {
    if (busy) return;
    setBusy(id);
    void onAct(id).finally(() => setBusy(null));
  };
  // Where a screen reader's focus comes back to after its sheet, or after the row before it settled.
  const focusRef = useRef<View>(null);
  useEffect(() => registerRowFocus(`inbox:${row.id}`, focusRef), [row.id]);
  // The tile's colour: what needs the person in its severity (a question the first chart colour, the mock's blue), the
  // others calm; green with a check once the assistant fixed it.
  const color = says?.fixed
    ? theme.colors.ok
    : row.group === 'you' && row.tone === 'bad'
      ? theme.colors.bad
      : row.group === 'you' && row.tone === 'warn'
        ? theme.colors.warn
        : row.group === 'later' || row.group === 'settled'
          ? theme.colors.mut
          : theme.chart.chart1;
  const Icon = says?.fixed ? Check : GLYPHS[row.glyph];
  const meta = row.state ? `${row.meta} · ${row.state}` : row.meta;
  const content = (
    <>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: 28,
          height: 28,
          borderRadius: 9,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tint(color, 0.14),
        }}
      >
        <Icon size={14} color={color} strokeWidth={1.9} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={14.5} weight={600} lh={1.35} numberOfLines={2}>
          {row.title}
        </Text>
        {row.body ? (
          // Three lines in the list; the whole of it is in the sheet.
          <Text size={13} lh={1.35} color={theme.colors.mut} numberOfLines={3}>
            {row.body}
          </Text>
        ) : null}
        <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1} style={{ marginTop: 2 }}>
          {meta}
        </Text>
        {says ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ marginTop: 4 }}
          >
            <LookSays view={says} size={18} textSize={13} lines={3} />
          </View>
        ) : null}
      </View>
      {opens ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ alignSelf: 'center' }}
        >
          <ChevronRight size={16} color={theme.colors.mut} strokeWidth={1.7} />
        </View>
      ) : null}
    </>
  );
  const style = {
    flexDirection: 'row' as const,
    // A row with the assistant's words is taller: its tile stays by the title.
    alignItems: says ? ('flex-start' as const) : ('center' as const),
    gap: 11,
    paddingVertical: 11,
    paddingHorizontal: 14,
    minHeight: 52,
    borderTopWidth: first ? 0 : 1,
    borderTopColor: theme.colors.line,
    ...(selected ? { backgroundColor: theme.colors.sel } : null),
  };
  const swipe = phoneRowSwipe(row);
  const actions = phoneRowActions(row);
  const held = [...(swipe?.edge ? [swipe.edge] : []), ...(swipe?.more ?? [])];
  const heldMenu = held.length ? inboxMoreMenu(held, row.title) : null;
  const a11y = {
    accessibilityLabel: row.label,
    // Screen readers can't swipe or hold: Settle and More's choices are the row's own actions.
    ...(actions.length
      ? {
          accessibilityActions: actions,
          onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) =>
            press(e.nativeEvent.actionName),
        }
      : null),
  };
  const approvalRow = inline && row.item.kind === 'approval';
  const inlineActions =
    inline && !approvalRow ? (
      <InlineActions inline={inline} title={row.title} busy={busy} onPress={press} onMenu={onMenu} />
    ) : null;
  const lineBody = !opens ? (
    <View ref={focusRef} style={style} accessible {...a11y}>
      {content}
    </View>
  ) : (
    <Touchable
      ref={focusRef}
      onPress={onPress}
      {...(hasNativeMenu || !held.length ? null : { onLongPress: () => onMenu(held) })}
      feedback="wash"
      accessibilityRole="button"
      accessibilityHint={phoneRowHint(opens, row.group)}
      accessibilityState={selected ? { selected } : undefined}
      style={style}
      {...a11y}
    >
      {content}
    </Touchable>
  );
  const body = approvalRow ? (
    <ApprovalRow
      row={row}
      first={first}
      inline={inline}
      busy={busy}
      focusRef={focusRef}
      onPress={press}
      onMenu={onMenu}
    />
  ) : inlineActions ? (
    <View>
      {lineBody}
      {inlineActions}
    </View>
  ) : (
    lineBody
  );
  if (!swipe) return body;
  const trailing: SwipeAction[] = [];
  const { edge, more } = swipe;
  if (edge)
    trailing.push({
      label: swipeEdgeLabel(edge),
      icon: edge.kind === 'back' ? Undo2 : Check,
      leaves: true,
      run: () => press(edge.id),
    });
  if (more.length)
    trailing.push({
      label: NEEDS_YOU_WORDS.more,
      icon: Ellipsis,
      tone: 'neutral',
      run: () => onMenu(more),
      menu: { spec: inboxMoreMenu(more, row.title), onPick: press },
    });
  return (
    <SwipeRow trailing={trailing}>
      {heldMenu && opens && !inlineActions && !approvalRow ? (
        <NativeMenu spec={heldMenu} onPick={press}>
          {body}
        </NativeMenu>
      ) : inlineActions && heldMenu && opens ? (
        <View>
          <NativeMenu spec={heldMenu} onPick={press}>
            {lineBody}
          </NativeMenu>
          {inlineActions}
        </View>
      ) : (
        body
      )}
    </SwipeRow>
  );
}

/** A line's one way forward under its words, and More beside it with the rest (Settle among them). */
function InlineActions({
  inline,
  title,
  busy,
  onPress,
  onMenu,
}: {
  inline: PhoneRowInline;
  title: string;
  busy: string | null;
  onPress: (id: string) => void;
  onMenu: (buttons: NeedsYouButton[]) => void;
}) {
  const { lead, more } = inline;
  if (!lead && !more.length) return null;
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        paddingLeft: 53,
        paddingRight: 14,
        paddingBottom: 12,
      }}
    >
      {lead ? (
        <Button
          label={lead.label}
          variant={lead.look === 'quiet' ? 'secondary' : lead.look}
          wrap
          busy={busy === lead.id}
          disabled={busy !== null}
          onPress={() => onPress(lead.id)}
          style={{ minHeight: TARGET, flexShrink: 1 }}
        />
      ) : null}
      <View style={{ flex: 1 }} />
      {more.length ? <MoreButton buttons={more} title={title} onPick={onPress} onMenu={onMenu} /> : null}
    </View>
  );
}

/** “More” beside a row's way forward: iOS's own menu from it, a sheet elsewhere; read as “More for {title}”. */
function MoreButton({
  buttons,
  title,
  onPick,
  onMenu,
}: {
  buttons: NeedsYouButton[];
  title: string;
  onPick: (id: string) => void;
  onMenu: (buttons: NeedsYouButton[]) => void;
}) {
  const theme = useTheme();
  const label = NEEDS_YOU_WORDS.moreFor(title);
  const face = (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: TARGET, paddingHorizontal: 10 }}
    >
      <Ellipsis size={16} color={theme.colors.ink2} strokeWidth={1.9} />
      <Text size={14} color={theme.colors.ink2}>
        {NEEDS_YOU_WORDS.more}
      </Text>
    </View>
  );
  if (hasNativeMenu)
    return (
      <NativeMenu spec={inboxMoreMenu(buttons, title)} onPick={onPick} trigger="tap" label={label}>
        {face}
      </NativeMenu>
    );
  return (
    <Touchable
      onPress={() => onMenu(buttons)}
      feedback="wash"
      ringRadius={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ borderRadius: 10 }}
    >
      {face}
    </Touchable>
  );
}

/**
 * An approval in the list as the one approval card (approval-card.md): who asks and when, the title in full, where,
 * what happens, the permission (an Inbox item names none) and the exact moment Yes, tonight means, all before its
 * answers, which stack full width and equal; More under the card with talking it over and the reminder.
 */
function ApprovalRow({
  row,
  first,
  inline,
  busy,
  focusRef,
  onPress,
  onMenu,
}: {
  row: NeedsYouListRow;
  first: boolean;
  inline: PhoneRowInline;
  busy: string | null;
  /** Where a screen reader's focus comes back to (the row's own). */
  focusRef: RefObject<View | null>;
  onPress: (id: string) => void;
  onMenu: (buttons: NeedsYouButton[]) => void;
}) {
  const theme = useTheme();
  const navigation = useAppNavigation();
  const { timeZone } = useBurrowBase();
  const words = useAgentWords();
  const card = needsYouApprovalCard(row, { timeZone, assistant: words.name });
  // The assistant's draft report: Edit opens the form with it; too long for its yes here, its own screen takes it.
  const doors = approvalRowDoors(row);
  if (!card) return null;
  return (
    <View
      ref={focusRef}
      style={{ borderTopWidth: first ? 0 : 1, borderTopColor: theme.colors.line, padding: 14, gap: 8 }}
    >
      <View
        style={{
          borderWidth: 1.5,
          borderColor: theme.colors.warn,
          borderRadius: 16,
          overflow: 'hidden',
          backgroundColor: theme.colors.sf,
        }}
      >
        <View style={{ padding: 18, gap: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <Text size={12} weight={500} mono color={theme.colors.warnText} style={{ flex: 1 }}>
              {`○ ${card.status}`}
            </Text>
            <Text size={12} mono color={theme.colors.mut}>
              {card.asked}
            </Text>
          </View>
          <Text size={21} weight={700} lh={1.2} tracking={-0.02} accessibilityRole="header">
            {card.title}
          </Text>
          {card.subject ? (
            <Text size={15.5} lh={1.5} color={theme.colors.ink2}>
              {card.subject}
            </Text>
          ) : null}
          {card.happens.map((line) => (
            <Text key={line} size={15.5} lh={1.5} color={theme.colors.ink2}>
              {line}
            </Text>
          ))}
          <ApprovalFact label={APPROVAL_CARD_WORDS.permission}>{card.permission}</ApprovalFact>
          {card.tonight ? <TonightBox tonight={card.tonight} /> : null}
        </View>
        <View
          accessibilityLabel={APPROVAL_CARD_WORDS.answersLabel}
          style={{
            gap: 10,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
            paddingTop: 14,
            paddingHorizontal: 18,
            paddingBottom: 18,
          }}
        >
          {inline.answers.map((b) => (
            <Button
              key={b.id}
              label={b.label}
              variant="secondary"
              size="lg"
              wrap
              busy={busy === b.id}
              disabled={busy !== null}
              onPress={() => onPress(b.id)}
            />
          ))}
          {doors.approvalNumber ? (
            <Button
              label={NEEDS_YOU_WORDS.openApproval}
              variant="secondary"
              size="lg"
              wrap
              disabled={busy !== null}
              accessibilityHint="Shows all of it, where you can send it"
              onPress={() =>
                navigation.navigate('Approval', {
                  number: doors.approvalNumber as number,
                  back: NEEDS_YOU_TAB.title,
                })
              }
            />
          ) : null}
          {doors.draftId ? (
            <Button
              label={TEAM_REPORT_WORDS.edit}
              variant="secondary"
              size="lg"
              wrap
              disabled={busy !== null}
              accessibilityHint="Opens the report form with this draft"
              onPress={() =>
                navigation.navigate('TeamReportNew', {
                  draftId: doors.draftId as string,
                  back: NEEDS_YOU_TAB.title,
                })
              }
            />
          ) : null}
        </View>
      </View>
      {inline.more.length ? (
        <View style={{ alignItems: 'flex-end' }}>
          <MoreButton buttons={inline.more} title={row.title} onPick={onPress} onMenu={onMenu} />
        </View>
      ) : null}
    </View>
  );
}
