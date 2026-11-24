/**
 * A service's Summary in slots on the phone (Whombat service-slots.md SLT-02…SLT-09; service-slots-mobile.md): Worth a
 * look as a slim strip in its tone (`StripCard`), Live as cards to swipe with page dots — compact rows stacked in a
 * wide page's half (`LiveCard`) —, the Shelf as one row of posters to swipe — three across in a wide page's half
 * (`ShelfCard`) —, and Inventory's counts as tiles two by two — rows with the count on the right in a wide page's half
 * (`CountsCard`). The words, tags and order are `data/serviceSlots.ts`'s; colours only from the theme.
 */
import { handleTheseView, noticeGroups, thingImageInitial } from '@whombat/client';
import type { ThingPagePanel, ThingTone } from '@whombat/core';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  View,
} from 'react-native';
import { HumanAvatar } from '../../avatars/Avatars';
import { useBurrowBase, useNow } from '../../data/BurrowProvider';
import { DASHBOARD_COPY } from '../../data/dashboard';
import { MONITORING_COPY } from '../../data/monitoring';
import { parseQuietPick, quietLineMenu } from '../../data/nativeMenu';
import { type GalleryItemView, galleryItems, rowsOf, SERVICE_COPY } from '../../data/servicePanels';
import {
  type CountTileView,
  countTiles,
  foldStrip,
  HALF_SHELF_COLUMNS,
  LIVE_CARD_WIDTH,
  type LiveRowView,
  liveRows,
  noteParts,
  SHELF_WIDTH,
  SLOT_COPY,
  SWIPE_GAP,
  shelfShown,
  shelfTag,
  stripOrder,
  stripSentence,
  stripTone,
  swipePage,
} from '../../data/serviceSlots';
import {
  type LinkRun,
  type NoticeRowView,
  noticeRows,
  QUIET_LINE_COPY,
  THING_PAGE_COPY,
} from '../../data/thingPage';
import { useAgentWords } from '../../data/useAgent';
import { Meter } from '../../managed/HostCharts';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { OneCard, toneOf } from '../../ui/assistant';
import { tint } from '../../ui/glanceColors';
import { Ellipsis, ExternalLink, type LucideIcon, MessageCircle } from '../../ui/icons';
import { hasNativeMenu, NativeMenu } from '../../ui/nativeMenu';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';
import { NOTICE_ICONS } from './noticeIcons';
import type { PanelContext } from './Panels';
import { ThingPicture } from './Picture';
import { CardQuiet, PanelLink } from './parts';
import { QuietMenuSheet, type QuietMenuTarget } from './QuietMenu';
import { ItemButtons, ThingButton, ThingIconButton } from './ThingButton';

/** Whether a card sits in one half of a wide page (an open foldable, a tablet): rows instead of swiping and tiles. */
export const SlotHalfContext = createContext(false);

type GalleryPanel = Extract<ThingPagePanel, { kind: 'gallery' }>;
type ListPanel = Extract<ThingPagePanel, { kind: 'list' }>;
type NoticesPanel = Extract<ThingPagePanel, { kind: 'notices' }>;

/** A tone's colour; anything else (a heads-up, a plain line) in `mut`. */
function useToneColor(): (tone: string | null | undefined) => string {
  const theme = useTheme();
  return (tone) =>
    tone === 'ok' || tone === 'warn' || tone === 'bad' ? toneOf(theme, tone) : theme.colors.mut;
}

/** A person's round mark with their initial (decorative where their name is written beside it). */
function PersonMark({ name, initial, size }: { name: string; initial: string; size: number }) {
  return <HumanAvatar initials={initial} size={size} label={name} />;
}

/** A small tag in its tone (“Direct play”, “Paused”): mono words on a tint of the tone, `mut` on `sf2` without one. */
function ToneTag({ text, tone }: { text: string; tone: ThingTone | null }) {
  const theme = useTheme();
  const color = tone ? toneOf(theme, tone) : theme.colors.mut;
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        maxWidth: '100%',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: tone ? tint(color, 0.13) : theme.colors.sf2,
      }}
    >
      <Text size={11} weight={500} mono color={color} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/* Worth a look as a strip (SLT-08) --------------------------------------------------------------------------------- */

/**
 * Worth a look on top as a slim strip: tinted in its worst tone, each line with its icon on a tinted tile, the card's
 * name over the first, the title and its detail as one sentence, then its link and button; the ⋯ menu (Ignore, Remind
 * me tomorrow, Stop watching; held on the line too) or a quiet line's Undo on the right. The first three, then “Show N
 * more”. Nothing at all when it has no line.
 */
export function StripCard({ panel, ctx }: { panel: NoticesPanel; ctx: PanelContext }) {
  const theme = useTheme();
  const quiet = ctx.quiet ?? null;
  const agent = useAgentWords();
  const rows = useMemo(
    () => noticeRows(panel, ctx.tabs, { quiet: !!quiet, askLabel: agent.ask }),
    [panel, ctx.tabs, quiet, agent.ask],
  );
  const ordered = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    return stripOrder(panel.items)
      .map((n) => byId.get(n.id))
      .filter((r): r is NoticeRowView => !!r);
  }, [rows, panel.items]);
  const [open, setOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<QuietMenuTarget | null>(null);
  if (!ordered.length) return null;
  const { shown, more } = foldStrip(ordered, open);
  const tone = stripTone(panel.items);
  const color = tone === 'info' ? theme.colors.ink2 : toneOf(theme, tone);
  const all = handleTheseView(noticeGroups(panel.items).asking, ctx.research, ctx.thing.name, agent.name);
  const handOver = () => {
    if (!all) return;
    if (ctx.onHandle) return ctx.onHandle(all.fallback.question);
    ctx.run({ kind: 'ask', question: all.fallback.question });
  };
  const openMenu = quiet
    ? (r: NoticeRowView) => (r.menu ? setMenuFor({ menu: r.menu, line: r.line }) : undefined)
    : null;
  return (
    <View
      style={{
        backgroundColor: theme.colors.sf,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: tone === 'info' ? theme.colors.line : tint(color, 0.24),
        overflow: 'hidden',
      }}
    >
      <View style={{ backgroundColor: tone === 'info' ? 'transparent' : tint(color, 0.08) }}>
        {shown.map((r, i) => (
          <StripLine
            key={r.id}
            row={r}
            label={i === 0 ? panel.title : null}
            labelColor={color}
            ctx={ctx}
            onMenu={openMenu}
          />
        ))}
        {more || open ? (
          <Touchable
            onPress={() => setOpen(!open)}
            feedback="wash"
            accessibilityRole="button"
            accessibilityLabel={open ? DASHBOARD_COPY.showFewer : DASHBOARD_COPY.showMore(more)}
            style={{
              minHeight: 44,
              justifyContent: 'center',
              paddingHorizontal: 14,
              borderTopWidth: 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <Text size={13.5} weight={600} color={theme.colors.brand}>
              {open ? DASHBOARD_COPY.showFewer : DASHBOARD_COPY.showMore(more)}
            </Text>
          </Touchable>
        ) : null}
        {all?.label || all?.busy ? (
          <View
            style={{
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderTopWidth: 1,
              borderTopColor: theme.colors.line,
            }}
          >
            {all.label ? (
              <SmallLinkButton label={all.label} icon={MessageCircle} onPress={handOver} />
            ) : (
              <View accessibilityRole="text" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <ActivityIndicator size="small" color={theme.colors.brand} />
                <Text size={13.5} color={theme.colors.ink2} style={{ flex: 1 }}>
                  {all.busy}
                </Text>
              </View>
            )}
          </View>
        ) : null}
      </View>
      {quiet ? <QuietMenuSheet target={menuFor} actions={quiet} onClose={() => setMenuFor(null)} /> : null}
    </View>
  );
}

/** A small outlined button with its icon first (30dp, padded to 44): a strip line's link. */
function SmallLinkButton({
  label,
  icon: Icon,
  hint,
  onPress,
}: {
  label: string;
  icon: LucideIcon | null;
  hint?: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={9}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={hitSlopFor(30)}
      style={{
        alignSelf: 'flex-start',
        minHeight: 30,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
      }}
    >
      {Icon ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Icon size={14} color={theme.colors.ink} strokeWidth={1.8} />
        </View>
      ) : null}
      <Text size={13} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}
      </Text>
    </Touchable>
  );
}

const LINK_ICONS: Record<LinkRun['kind'], LucideIcon | null> = {
  ask: MessageCircle,
  url: ExternalLink,
  href: null,
  tab: null,
  settings: null,
};

/** One strip line: its tile, its words (the card's name over the first), its link and button, its ⋯ or Undo. */
function StripLine({
  row,
  label,
  labelColor,
  ctx,
  onMenu,
}: {
  row: NoticeRowView;
  label: string | null;
  labelColor: string;
  ctx: PanelContext;
  onMenu: ((row: NoticeRowView) => void) | null;
}) {
  const theme = useTheme();
  const toneColor = useToneColor();
  const quiet = ctx.quiet ?? null;
  const color = row.quiet ? theme.colors.mut : row.tone ? toneColor(row.tone) : theme.colors.ink2;
  const Icon = NOTICE_ICONS[row.icon];
  const words = stripSentence(row.title, row.quiet ?? row.detail);
  const action = row.action;
  const menu = row.menu && onMenu ? () => onMenu(row) : null;
  const native = menu && row.menu && quiet && hasNativeMenu ? quietLineMenu(row.menu, row.line.title) : null;
  const pick = (id: string) => {
    const p = parseQuietPick(id);
    if (p && quiet) quiet[p](row.line);
  };
  const undo = row.undo && quiet ? row.undo : null;
  // A line held because the whole thing is kept quiet ends with it: End now, not Undo (monitoring.md MON-04).
  const endQuiet = row.endNow ? (ctx.endQuiet ?? null) : null;
  const text = (
    <View style={{ gap: 2 }}>
      {label ? (
        <Text size={10.5} weight={500} mono tracking={0.06} color={labelColor}>
          {label.toUpperCase()}
        </Text>
      ) : null}
      <Text size={14} lh={1.4} color={theme.colors.ink2} numberOfLines={5}>
        <Text size={14} weight={600} color={row.quiet ? theme.colors.mut : theme.colors.ink}>
          {words.title}
        </Text>
        {words.detail ? ` ${words.detail}` : null}
      </Text>
    </View>
  );
  // The words are one element for VoiceOver and TalkBack; held, they open the ⋯ menu.
  const said = (
    <Touchable
      {...(menu ? { onLongPress: menu } : {})}
      feedback="none"
      accessibilityRole="text"
      accessibilityLabel={row.spoken}
      style={{ minHeight: 44, justifyContent: 'center' }}
    >
      {text}
    </Touchable>
  );
  const buttons =
    action || (row.button && ctx.act) ? (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {action ? (
          <SmallLinkButton
            label={action.label}
            icon={LINK_ICONS[action.run.kind]}
            {...(action.run.kind === 'url' ? { hint: SERVICE_COPY.opensBrowser } : {})}
            onPress={() => ctx.run(action.run)}
          />
        ) : null}
        {row.button && ctx.act ? (
          <ThingButton
            button={row.button}
            act={ctx.act.buttons}
            spoken={`${row.button.label} ${row.title}`}
          />
        ) : null}
      </View>
    ) : null;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingTop: 12,
        paddingBottom: 12,
        paddingLeft: 12,
        paddingRight: menu || undo || endQuiet ? 4 : 14,
        borderTopWidth: label ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: row.quiet ? theme.colors.sf2 : tint(color, 0.15),
        }}
      >
        <Icon size={18} color={color} strokeWidth={1.8} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 10 }}>
        {native ? (
          <NativeMenu spec={native} onPick={pick}>
            {said}
          </NativeMenu>
        ) : (
          said
        )}
        {buttons}
      </View>
      {native && row.menu ? (
        <NativeMenu spec={native} onPick={pick} trigger="tap" label={row.menu.label} style={MENU_DOT}>
          <View style={MENU_DOT}>
            <Ellipsis size={18} color={theme.colors.mut} strokeWidth={1.8} />
          </View>
        </NativeMenu>
      ) : menu && row.menu ? (
        <Touchable
          onPress={menu}
          feedback="wash"
          ringRadius={22}
          accessibilityLabel={row.menu.label}
          accessibilityHint={QUIET_LINE_COPY.menuHint}
          style={MENU_DOT}
        >
          <Ellipsis size={18} color={theme.colors.mut} strokeWidth={1.8} />
        </Touchable>
      ) : null}
      {undo && quiet ? (
        <Touchable
          onPress={() => quiet.undo(undo)}
          disabled={quiet.busy(undo)}
          feedback="fade"
          ringRadius={10}
          accessibilityLabel={QUIET_LINE_COPY.undoLabel(row.title)}
          accessibilityHint={QUIET_LINE_COPY.undoHint}
          style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 10, justifyContent: 'center' }}
        >
          <Text size={13} weight={600} color={theme.colors.brand}>
            {THING_PAGE_COPY.undo}
          </Text>
        </Touchable>
      ) : null}
      {endQuiet ? (
        <Touchable
          onPress={endQuiet.run}
          disabled={endQuiet.busy}
          feedback="fade"
          ringRadius={10}
          accessibilityLabel={`${MONITORING_COPY.endNow}: ${row.title}`}
          accessibilityHint={MONITORING_COPY.endNowHint}
          style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 10, justifyContent: 'center' }}
        >
          <Text size={13} weight={600} color={theme.colors.brand}>
            {MONITORING_COPY.endNow}
          </Text>
        </Touchable>
      ) : null}
    </View>
  );
}

/** A line's ⋯: 44dp, a little above the middle of the first line. */
const MENU_DOT = {
  width: 44,
  height: 44,
  marginTop: -4,
  borderRadius: 22,
  alignItems: 'center',
  justifyContent: 'center',
} as const;

/* Live (`gallery` with `look: 'rows'`, SLT-02) -------------------------------------------------------------------- */

/**
 * What plays or downloads now. On a phone: cards to swipe, one 318dp card and the edge of the next, page dots under
 * them; in a wide page's half: compact rows stacked. Each card is a link when its item has one; its buttons under it.
 */
export function LiveCard({ panel, ctx }: { panel: GalleryPanel; ctx: PanelContext }) {
  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  const now = useNow();
  const half = useContext(SlotHalfContext);
  const rows = useMemo(() => liveRows(panel, now, timeZone), [panel, now, timeZone]);
  const [page, setPage] = useState(0);
  const [width, setWidth] = useState(0);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) =>
    setPage(swipePage(e.nativeEvent.contentOffset.x, rows.length));
  // One card alone takes the width; several are 318dp, never wider than the card leaves.
  const cardWidth = rows.length > 1 && width ? Math.min(LIVE_CARD_WIDTH, width - 28 - 24) : null;
  return (
    <OneCard
      label={panel.title}
      meta={panel.meta}
      right={<PanelLink link={panel.link} tabs={ctx.tabs} run={ctx.run} />}
    >
      {rows.length === 0 ? (
        <CardQuiet text={panel.empty ?? ''} first />
      ) : half ? (
        <View style={{ paddingHorizontal: 14, paddingTop: 2, paddingBottom: 14, gap: 10 }}>
          {rows.map((r) => (
            <LiveItem key={r.id} row={r} shape={panel.shape} ctx={ctx} compact />
          ))}
        </View>
      ) : (
        <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ paddingBottom: 12, gap: 10 }}>
          {rows.length === 1 || !cardWidth ? (
            <View style={{ paddingHorizontal: 14, paddingTop: 2 }}>
              {rows.map((r) => (
                <LiveItem key={r.id} row={r} shape={panel.shape} ctx={ctx} />
              ))}
            </View>
          ) : (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                snapToInterval={cardWidth + SWIPE_GAP}
                decelerationRate="fast"
                onScroll={onScroll}
                scrollEventThrottle={32}
                contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 2, gap: SWIPE_GAP }}
              >
                {rows.map((r) => (
                  <View key={r.id} style={{ width: cardWidth }}>
                    <LiveItem row={r} shape={panel.shape} ctx={ctx} />
                  </View>
                ))}
              </ScrollView>
              <PageDots count={rows.length} page={page} color={theme.colors.ink2} rest={theme.colors.line2} />
            </>
          )}
        </View>
      )}
    </OneCard>
  );
}

/** Which card shows: small dots, the current one longer (decorative; each card says itself). */
function PageDots({
  count,
  page,
  color,
  rest,
}: {
  count: number;
  page: number;
  color: string;
  rest: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={SLOT_COPY.pageOf(page + 1, count)}
      style={{ flexDirection: 'row', justifyContent: 'center', gap: 6 }}
    >
      {Array.from({ length: count }, (_, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: one dot per card, by position
          key={i}
          style={{
            width: i === page ? 16 : 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: i === page ? color : rest,
          }}
        />
      ))}
    </View>
  );
}

/**
 * One Live item on `sf2`: its poster (74dp; 50 compact), its title, sub and person (their initial, name · note), its
 * tag, then the progress across the card with its words at both ends — grey while paused. Compact: the tag at the
 * progress line's end instead of `noteEnd`.
 */
function LiveItem({
  row,
  shape,
  ctx,
  compact = false,
}: {
  row: LiveRowView;
  shape: GalleryPanel['shape'];
  ctx: PanelContext;
  compact?: boolean;
}) {
  const theme = useTheme();
  const note = row.note ? noteParts(row.note) : null;
  const content: ReactNode = (
    <>
      <View
        style={{
          flexDirection: 'row',
          gap: compact ? 12 : 14,
          alignItems: compact ? 'center' : 'flex-start',
        }}
      >
        <ThingPicture
          thing={ctx.thing.id}
          image={row.image}
          shape={shape}
          initial={row.initial || thingImageInitial(row.title)}
          width={compact ? 50 : 74}
          radius={8}
          letterSize={compact ? 16 : 20}
          muted={row.muted}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text size={compact ? 15 : 16.5} weight={600} lh={1.2} numberOfLines={1}>
            {row.title}
          </Text>
          {row.sub ? (
            <Text size={13.5} color={theme.colors.mut} numberOfLines={1} style={{ marginTop: 2 }}>
              {row.sub}
            </Text>
          ) : null}
          {row.person ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 7,
                marginTop: compact ? 6 : 8,
                minWidth: 0,
              }}
            >
              <PersonMark name={row.person.name} initial={row.person.initial} size={20} />
              <Text size={13.5} color={theme.colors.ink2} numberOfLines={1} style={{ flexShrink: 1 }}>
                {[row.person.name, row.person.note].filter(Boolean).join(' · ')}
              </Text>
            </View>
          ) : null}
          {row.badge && !compact ? (
            <View style={{ marginTop: 10 }}>
              <ToneTag text={row.badge.text} tone={row.badge.tone} />
            </View>
          ) : null}
        </View>
      </View>
      {row.pct !== null || note || row.noteEnd ? (
        <View style={{ gap: 7, marginTop: 12 }}>
          {row.pct !== null ? (
            <Meter
              pct={row.pct}
              color={row.paused ? theme.colors.mut : theme.colors.progress}
              height={5}
              flush
            />
          ) : null}
          <View
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
          >
            {note ? (
              <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1} style={{ flexShrink: 1 }}>
                <Text size={11.5} mono weight={500} color={theme.colors.ink}>
                  {note.strong}
                </Text>
                {note.rest}
              </Text>
            ) : (
              <View />
            )}
            {compact && row.badge ? (
              <View style={{ flexShrink: 1 }}>
                <ToneTag text={row.badge.text} tone={row.badge.tone} />
              </View>
            ) : row.noteEnd ? (
              <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1}>
                {row.noteEnd}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </>
  );
  const link = row.link;
  const card = {
    borderRadius: compact ? 13 : 16,
    padding: compact ? 10 : 14,
    paddingRight: compact ? 12 : 14,
    backgroundColor: theme.colors.sf2,
  };
  return (
    <View style={{ gap: 8 }}>
      {link ? (
        <Touchable
          onPress={() => ctx.run(link)}
          feedback="fade"
          ringRadius={16}
          accessibilityRole="link"
          accessibilityLabel={row.spoken}
          {...(row.linkHint ? { accessibilityHint: row.linkHint } : {})}
          style={card}
        >
          {content}
        </Touchable>
      ) : (
        <View accessible accessibilityLabel={row.spoken} style={card}>
          {content}
        </View>
      )}
      <ItemButtons buttons={row.actions} act={ctx.act?.buttons} about={row.title} />
    </View>
  );
}

/* Shelf (`gallery` with `look: 'shelf'`, SLT-04) ------------------------------------------------------------------- */

/**
 * What came in: on a phone one row of 104dp posters to swipe; in a wide page's half three across. The person who asked
 * for one wears a small tag on its picture (their initial and “Anna asked”); its title and when under it.
 */
export function ShelfCard({ panel, ctx }: { panel: GalleryPanel; ctx: PanelContext }) {
  const { timeZone } = useBurrowBase();
  const now = useNow();
  const half = useContext(SlotHalfContext);
  const items = useMemo(() => galleryItems(panel, now, timeZone), [panel, now, timeZone]);
  const tags = useMemo(() => new Map(panel.items.map((i) => [i.id, shelfTag(i)])), [panel.items]);
  const draw = (it: GalleryItemView) => (
    <ShelfItem item={it} tag={tags.get(it.id) ?? null} shape={panel.shape} ctx={ctx} />
  );
  return (
    <OneCard
      label={panel.title}
      meta={panel.meta}
      right={<PanelLink link={panel.link} tabs={ctx.tabs} run={ctx.run} />}
    >
      {items.length === 0 ? (
        <CardQuiet text={panel.empty ?? ''} first />
      ) : half ? (
        <View style={{ paddingHorizontal: 14, paddingTop: 2, paddingBottom: 14, gap: 12 }}>
          {rowsOf(items.slice(0, shelfShown(items.length)), HALF_SHELF_COLUMNS).map((row) => (
            <View key={row.map((r) => r.id).join('|')} style={{ flexDirection: 'row', gap: 10 }}>
              {row.map((it) => (
                <View key={it.id} style={{ flex: 1, minWidth: 0 }}>
                  {draw(it)}
                </View>
              ))}
              {Array.from({ length: HALF_SHELF_COLUMNS - row.length }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: empty places at the end of a short shelf
                <View key={`gap-${i}`} style={{ flex: 1 }} />
              ))}
            </View>
          ))}
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 2, paddingBottom: 14, gap: 12 }}
        >
          {items.map((it) => (
            <View key={it.id} style={{ width: SHELF_WIDTH }}>
              {draw(it)}
            </View>
          ))}
        </ScrollView>
      )}
    </OneCard>
  );
}

function ShelfItem({
  item,
  tag,
  shape,
  ctx,
}: {
  item: GalleryItemView;
  tag: { initial: string; text: string } | null;
  shape: GalleryPanel['shape'];
  ctx: PanelContext;
}) {
  const theme = useTheme();
  const content = (
    <>
      <View>
        <ThingPicture
          thing={ctx.thing.id}
          image={item.image}
          shape={shape}
          initial={item.initial || thingImageInitial(item.title)}
          radius={10}
          letterSize={24}
          muted={item.muted}
        />
        {tag ? (
          <View
            style={{
              position: 'absolute',
              top: 6,
              left: 6,
              maxWidth: '90%',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              paddingLeft: 3,
              paddingRight: 7,
              height: 20,
              borderRadius: 10,
              backgroundColor: theme.colors.sf,
            }}
          >
            <HumanAvatar initials={tag.initial} size={15} />
            <Text
              size={11}
              weight={500}
              color={theme.colors.ink2}
              numberOfLines={1}
              style={{ flexShrink: 1 }}
            >
              {tag.text}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={{ gap: 1, marginTop: 7 }}>
        <Text size={13.5} weight={600} lh={1.25} numberOfLines={1}>
          {item.title}
        </Text>
        {item.sub ? (
          <Text size={12} color={theme.colors.mut} numberOfLines={1}>
            {item.sub}
          </Text>
        ) : null}
      </View>
    </>
  );
  const spoken = tag ? `${item.spoken} · ${tag.text}` : item.spoken;
  const link = item.link;
  return (
    <View style={{ gap: 8 }}>
      {link ? (
        <Touchable
          onPress={() => ctx.run(link)}
          feedback="fade"
          ringRadius={10}
          accessibilityRole="link"
          accessibilityLabel={spoken}
          {...(item.linkHint ? { accessibilityHint: item.linkHint } : {})}
        >
          {content}
        </Touchable>
      ) : (
        <View accessible accessibilityLabel={spoken}>
          {content}
        </View>
      )}
      <ItemButtons buttons={item.actions} act={ctx.act?.buttons} about={item.title} column />
    </View>
  );
}

/* Counts (`list` with `look: 'counts'`, SLT-03) ------------------------------------------------------------------ */

/**
 * How big each thing is: on a phone tiles two by two (its icon and name, the count large, what changed under it in its
 * tone, its own button as a small icon in the corner); in a wide page's half rows with the count on the right and the
 * button beside it. The panel's buttons (Scan all) sit in its head.
 */
export function CountsCard({ panel, ctx }: { panel: ListPanel; ctx: PanelContext }) {
  const half = useContext(SlotHalfContext);
  const tiles = useMemo(() => countTiles(panel), [panel]);
  const head = ctx.act && panel.buttons?.length ? panel.buttons : [];
  const act = ctx.act ?? null;
  return (
    <OneCard
      label={panel.title}
      meta={panel.meta}
      right={
        head.length && act ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {head.map((b) => (
              <ThingButton key={`${b.action}:${b.target ?? ''}`} button={b} act={act.buttons} />
            ))}
          </View>
        ) : (
          <PanelLink link={panel.link} tabs={ctx.tabs} run={ctx.run} />
        )
      }
    >
      {tiles.length === 0 ? (
        <CardQuiet text={panel.empty ?? ''} first />
      ) : half ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {tiles.map((t, i) => (
            <CountRow key={t.id} tile={t} first={i === 0} ctx={ctx} />
          ))}
        </View>
      ) : (
        <View style={{ paddingHorizontal: 14, paddingTop: 2, paddingBottom: 14, gap: 10 }}>
          {rowsOf(tiles, 2).map((row) => (
            <View key={row.map((t) => t.id).join('|')} style={{ flexDirection: 'row', gap: 10 }}>
              {row.map((t) => (
                <CountTile key={t.id} tile={t} ctx={ctx} />
              ))}
              {row.length < 2 ? <View style={{ flex: 1 }} /> : null}
            </View>
          ))}
        </View>
      )}
    </OneCard>
  );
}

function CountIcon({ tile, size }: { tile: CountTileView; size: number }) {
  const theme = useTheme();
  if (!tile.icon) return null;
  const Icon = NOTICE_ICONS[tile.icon];
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Icon size={size} color={theme.colors.ink2} strokeWidth={1.8} />
    </View>
  );
}

function CountTile({ tile, ctx }: { tile: CountTileView; ctx: PanelContext }) {
  const theme = useTheme();
  const toneColor = useToneColor();
  const act = ctx.act ?? null;
  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        borderRadius: 13,
        backgroundColor: theme.colors.sf2,
        paddingTop: 12,
        paddingHorizontal: 12,
        paddingBottom: 11,
      }}
    >
      <View accessible accessibilityLabel={tile.spoken} style={{ gap: 2 }}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: tile.action ? 26 : 0 }}
        >
          <CountIcon tile={tile} size={15} />
          <Text size={13} weight={600} color={theme.colors.ink2} numberOfLines={1} style={{ flexShrink: 1 }}>
            {tile.title}
          </Text>
        </View>
        {tile.value ? (
          <Text size={24} weight={700} lh={1.15} tracking={-0.02} numberOfLines={1} style={{ marginTop: 6 }}>
            {tile.value}
          </Text>
        ) : null}
        {tile.note ? (
          <Text size={12} color={toneColor(tile.noteTone)} numberOfLines={1}>
            {tile.note}
          </Text>
        ) : null}
      </View>
      {tile.action && act ? (
        <View style={{ position: 'absolute', top: 6, right: 6 }}>
          <ThingIconButton
            button={tile.action}
            act={act.buttons}
            spoken={`${tile.action.label} ${tile.title}`}
          />
        </View>
      ) : null}
    </View>
  );
}

function CountRow({ tile, first, ctx }: { tile: CountTileView; first: boolean; ctx: PanelContext }) {
  const theme = useTheme();
  const toneColor = useToneColor();
  const act = ctx.act ?? null;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingTop: first ? 2 : 11,
        paddingBottom: 11,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        accessible
        accessibilityLabel={tile.spoken}
        style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <View
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            backgroundColor: theme.colors.sf2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <CountIcon tile={tile} size={18} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text size={15} weight={600} numberOfLines={1}>
            {tile.title}
          </Text>
          {tile.detail ? (
            <Text size={12.5} color={theme.colors.mut} numberOfLines={1} style={{ marginTop: 2 }}>
              {tile.detail}
            </Text>
          ) : null}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          {tile.value ? (
            <Text size={19} weight={700} lh={1.1} tracking={-0.01} numberOfLines={1}>
              {tile.value}
            </Text>
          ) : null}
          {tile.note && tile.note !== tile.detail ? (
            <Text size={11.5} color={toneColor(tile.noteTone)} numberOfLines={1}>
              {tile.note}
            </Text>
          ) : null}
        </View>
      </View>
      {tile.action && act ? (
        <ThingIconButton
          button={tile.action}
          act={act.buttons}
          spoken={`${tile.action.label} ${tile.title}`}
        />
      ) : null}
    </View>
  );
}
