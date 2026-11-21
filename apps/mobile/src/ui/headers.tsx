/**
 * Screen chrome from the mock: safe-area screen, large title, the back bar and the chat header. Back is each platform's
 * own: on iPhone `chevron.backward` with the previous screen's title in `brand`; on Android Material's `arrow_back` in a
 * 48dp target, named “Back to {previous}”, the screen's own title being the large title under it (a large top app bar).
 */
import { createContext, type ReactNode, useContext, useEffect, useId } from 'react';
import { Platform, type StyleProp, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Tab } from '../data/shell';
import { HeaderLineContext, ListToggleContext, usePaneRole } from '../navigation/panes';
import { backButtonLabel } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackGlyph } from './BackGlyph';
import { PanelLeftClose, PanelLeftOpen, X } from './icons';
import { PageSideContext } from './screenShape';
import { Touchable } from './Touchable';
import { hitSlopFor } from './touchTarget';

/**
 * A quiet one-line strip every screen shows under the status bar while it is set (a managed Whombat's connection
 * trouble or “Recovery kit not saved”); it pushes the screen down rather than covering its header.
 */
export const ScreenStripContext = createContext<ReactNode>(null);

/**
 * The tab a screen is the root of, given by the tab's layout, so its top row (`TabTop`, `ui/topRow.tsx`) has Places and
 * Search beside its title. Null on pages pushed over the tabs, which start with their back button.
 */
export const TabRootContext = createContext<Tab | null>(null);

/** Full-screen background with the status bar inset on top (the mock's 50pt status bar). */
export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const strip = useContext(ScreenStripContext);
  return (
    <View style={[{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: insets.top }, style]}>
      {strip}
      {children}
    </View>
  );
}

/** Where a tab's title starts from the screen's edge: the mock's `Inbox` large title, 22. */
export const LARGE_TITLE_LEFT = 22;

/** `Inbox` large title (34/700/-.02em) with an optional trailing element; padding 14 22 6. */
export function LargeTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingTop: 14,
        paddingHorizontal: LARGE_TITLE_LEFT,
        paddingBottom: 6,
      }}
    >
      <Text size={34} weight={700} tracking={-0.02} accessibilityRole="header">
        {title}
      </Text>
      {right}
    </View>
  );
}

/** Chat's and Feedback's header and a thread's in them, the hairline included (the Chat channel mockup's phone). */
export const ROOM_HEADER_HEIGHT = 58;

/** What closes the right page's first screen with two pages, where “back” would only empty the page. */
export const CLOSE_WORD = 'Close';

/**
 * How a back button looks (docs/app/decisions/iphone-duo.md): “‹ label” — or, on the right page's first screen with two
 * pages, “✕ Close”, since going back there only empties the page.
 */
export function useBackLook(label: string): { closes: boolean; spoken: string } {
  const closes = usePaneRole() === 'beside-first';
  return { closes, spoken: closes ? CLOSE_WORD : backButtonLabel(label) };
}

/** “✕ Close” in the back button's colour; the cross alone when `words` is false. */
export function CloseLook({ words = true }: { words?: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <X size={words ? 18 : 20} color={theme.colors.brand} strokeWidth={2} />
      {words ? (
        <Text size={16} weight={500} color={theme.colors.brand}>
          {CLOSE_WORD}
        </Text>
      ) : null}
    </View>
  );
}

/** What the button that hides and shows the list says to VoiceOver and TalkBack: Chat's threads, another tab's list. */
export const LIST_TOGGLE_WORDS = { hide: 'Hide threads', show: 'Show threads' } as const;
export const OTHER_LIST_TOGGLE_WORDS = { hide: 'Hide the list', show: 'Show the list' } as const;

/**
 * With two pages, the button at the start of the right page's header that hides the list, so what is open takes the
 * whole width, and shows it again (iphone-duo.md): beside Chat always, beside the other tabs while
 * something is open there. Nothing on one page or on the list.
 */
export function ListToggleButton() {
  const theme = useTheme();
  const toggle = useContext(ListToggleContext);
  const side = useContext(PageSideContext);
  if (!toggle || side !== 'beside') return null;
  const Icon = toggle.hidden ? PanelLeftOpen : PanelLeftClose;
  const words = toggle.chat ? LIST_TOGGLE_WORDS : OTHER_LIST_TOGGLE_WORDS;
  return (
    <Touchable
      onPress={toggle.toggle}
      feedback="wash"
      ringRadius={22}
      accessibilityRole="button"
      accessibilityLabel={toggle.hidden ? words.show : words.hide}
      style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon size={20} color={theme.colors.ink2} strokeWidth={1.75} />
    </Touchable>
  );
}

/**
 * The back button. iPhone: the chevron and, unless `compact` (a header whose title follows at once), the previous
 * screen's title in `brand`, 44pt tall; iOS's edge swipe goes back too. Android: the arrow alone in a 48dp round target,
 * named “Back to {previous}”; the system's back (and its predictive animation) does the same. “✕ Close” on the right
 * page's first screen with two pages.
 */
export function BackButton({
  label,
  onPress,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  compact?: boolean;
}) {
  const theme = useTheme();
  const look = useBackLook(label);
  if (look.closes)
    return (
      <Touchable
        onPress={onPress}
        feedback="fade"
        accessibilityRole="button"
        accessibilityLabel={look.spoken}
        ringRadius={10}
        style={{ minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' }}
      >
        <CloseLook words={!compact} />
      </Touchable>
    );
  if (Platform.OS === 'ios')
    return (
      <Touchable
        onPress={onPress}
        feedback="fade"
        accessibilityRole="button"
        accessibilityLabel={look.spoken}
        ringRadius={10}
        hitSlop={compact ? hitSlopFor(30) : undefined}
        style={{
          minHeight: 44,
          minWidth: compact ? 30 : 44,
          paddingHorizontal: compact ? 6 : 4,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
          flexShrink: 1,
        }}
      >
        <BackGlyph />
        {compact ? null : (
          <Text size={17} color={theme.colors.brand} numberOfLines={1} style={{ flexShrink: 1 }}>
            {label}
          </Text>
        )}
      </Touchable>
    );
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      accessibilityRole="button"
      accessibilityLabel={look.spoken}
      ringRadius={24}
      style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' }}
    >
      <BackGlyph />
    </Touchable>
  );
}

/**
 * The back bar: the platform's back button on an 8 × 14 bar (4 × 6 on Android, so the arrow lines up with the page's
 * text); the button that hides the list with two pages first (AP-6740); `right` at the other end (a page's ⋯).
 */
export function BackBar({
  label,
  onPress,
  right,
}: {
  label: string;
  onPress: () => void;
  right?: ReactNode;
}) {
  const android = Platform.OS !== 'ios';
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: android ? 4 : 8,
        paddingLeft: android ? 6 : 14,
        paddingRight: 14,
      }}
    >
      <ListToggleButton />
      <BackButton label={label} onPress={onPress} />
      {right ? <View style={{ marginLeft: 'auto' }}>{right}</View> : null}
    </View>
  );
}

/**
 * A header with a hairline under it (Chat's, a thread's, “Threads”): `style` lays out what is in it, `minHeight` counts
 * the hairline. With two pages every one of them is as tall as the tallest, so their lines meet across the divider.
 */
export function LinedHeader({
  style,
  minHeight,
  children,
}: {
  style: StyleProp<ViewStyle>;
  minHeight?: number;
  children: ReactNode;
}) {
  const theme = useTheme();
  const line = useContext(HeaderLineContext);
  const report = line?.report;
  const id = useId();
  useEffect(() => (report ? () => report(id, null) : undefined), [report, id]);
  return (
    <View
      style={{
        minHeight: line ? Math.max(line.height, minHeight ?? 0) : minHeight,
        justifyContent: 'center',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      <View
        style={style}
        onLayout={
          report ? (e) => report(id, Math.max(minHeight ?? 0, e.nativeEvent.layout.height + 1)) : undefined
        }
      >
        {children}
      </View>
    </View>
  );
}

/**
 * Chat header: the back button (the chevron alone on iPhone, the arrow on Android) + 36dp avatar + name (16/600) over a
 * mono subtitle, bottom hairline; padding 6 14 12. With two pages
 * it is as tall as Chat's header (padding 6 14 6, 58 tall), so the lines meet.
 */
export function ChatHeader({
  onBack,
  backLabel,
  avatar,
  title,
  subtitle,
  onTitlePress,
  right,
  titleLabel,
}: {
  onBack: () => void;
  backLabel: string;
  avatar?: ReactNode;
  title: string;
  subtitle?: string | null;
  onTitlePress?: () => void;
  /** At the end of the header: the conversation's “More” button (essentials AP-511). */
  right?: ReactNode;
  /** What TalkBack reads for the title when the words on screen aren't enough (“Chat with Dusty”). */
  titleLabel?: string;
}) {
  const theme = useTheme();
  const twoPages = useContext(HeaderLineContext) !== null;
  const titleBlock = (
    <View style={{ flexDirection: 'column', flexShrink: 1 }}>
      <Text size={16} weight={600} numberOfLines={1}>
        {title}
      </Text>
      {subtitle ? (
        <Text size={11} weight={500} mono color={theme.colors.mut} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
  return (
    <LinedHeader
      minHeight={twoPages ? ROOM_HEADER_HEIGHT : undefined}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingTop: 6,
        paddingHorizontal: 14,
        paddingBottom: twoPages ? 6 : 12,
      }}
    >
      <ListToggleButton />
      <View style={{ marginLeft: Platform.OS === 'ios' ? 0 : -10 }}>
        <BackButton label={backLabel} onPress={onBack} compact />
      </View>
      {onTitlePress ? (
        <Touchable
          onPress={onTitlePress}
          feedback="fade"
          accessibilityRole="link"
          accessibilityLabel={titleLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
          hitSlop={hitSlopFor(36)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 }}
        >
          {avatar}
          {titleBlock}
        </Touchable>
      ) : (
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={titleLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 }}
        >
          {avatar}
          {titleBlock}
        </View>
      )}
      {right ? <View style={{ marginLeft: 'auto', marginRight: -6 }}>{right}</View> : null}
    </LinedHeader>
  );
}
