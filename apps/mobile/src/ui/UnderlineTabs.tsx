/**
 * Tabs that look like tabs (underline-tabs-android.md AP-2630…AP-2636): the web's `Tabs` at phone sizes, for moving
 * between the parts of a page — Connections' Servers · Services · Pinned, a server's, a guest's and a connection's tabs.
 * A value you pick (the theme, a range, Off · Ask · On) is `Segmented`. A row over a 1dp `line` hairline that runs to
 * the screen's edges (`bleed`); each tab 44dp tall, its name 14.5/500 `mut`, its count after it in mono 11.5 and the
 * tone's 7dp dot; the open one 600 `ink` with a 2dp `ink` underline over the hairline. No fills, no track. Up to four
 * share the width equally; more scroll sideways, each as wide as its words, keeping the open one in view (AP-2632).
 * TalkBack reads a tablist of tabs, the open one selected, by their `spoken` words.
 */
import type { StatusLevel } from '@whombat/client';
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { toneOf } from './assistant';
import { StatusMark } from './statusMark';
import { Touchable } from './Touchable';
import { revealOffset, underlineTabsLayout } from './tabsLayout';

export interface UnderlineTab<T extends string> {
  key: T;
  label: string;
  count?: number | string | null;
  /** The worst tone of what the tab holds; a dot after the count when set. */
  tone?: Parameters<typeof toneOf>[1];
  /** A status mark by shape after the count instead of the tone's dot (Overview's: only when something isn't working). */
  level?: StatusLevel | null;
  /** What TalkBack reads (“Services, 5, something needs a look”); else the label and the count. */
  spoken?: string;
}

/**
 * A scrolling tab's side padding; the row starts this much less than the page's padding in, so the words line up. The
 * underline hugs the words as on the web (2px), and the room between tabs is a gap, so the first underline doesn't
 * start left of the page's margin.
 */
const TAB_PAD = 2;
/** The room between scrolling tabs (the web's 28 at desktop sizes, a phone's share of it). */
const TAB_GAP = 22;

export function UnderlineTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  bleed = 0,
  trailing,
}: {
  tabs: readonly UnderlineTab<T>[];
  value: T | null;
  onChange: (key: T) => void;
  /** The tablist's name for TalkBack (“pve-02: what to show”). */
  label: string;
  /** The page's side padding: the row reaches over it, so the hairline runs from edge to edge. */
  bleed?: number;
  /** A control after the tabs that is not a tab (a connection's Settings), outside the scrolling part. */
  trailing?: ReactNode;
}) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const scroll = underlineTabsLayout(tabs, tabs.length + (trailing ? 1 : 0), fontScale) === 'scroll';
  const scroller = useRef<ScrollView>(null);
  const spots = useRef(new Map<string, { x: number; width: number }>());
  const view = useRef({ x: 0, width: 0 });
  // The tab last brought into view: the first layout shows the open one at once, a change scrolls to it.
  const revealed = useRef<string | null>(null);
  const reveal = useCallback((key: string | null, animated: boolean) => {
    const at = key === null ? undefined : spots.current.get(key);
    if (!at || !view.current.width) return;
    revealed.current = key;
    const x = revealOffset(at, view.current);
    if (x === null) return;
    view.current.x = x;
    scroller.current?.scrollTo({ x, animated });
  }, []);
  useEffect(() => {
    if (!scroll) revealed.current = null;
    else if (value !== revealed.current) reveal(value, true);
  }, [scroll, value, reveal]);
  const pending = () => {
    if (scroll && value !== revealed.current) reveal(value, false);
  };
  const edge = Math.max(0, bleed - TAB_PAD);

  const items = tabs.map((t) => {
    const selected = t.key === value;
    const count = t.count === null || t.count === undefined ? null : String(t.count);
    return (
      <Touchable
        key={t.key}
        accessibilityRole="tab"
        accessibilityState={{ selected }}
        accessibilityLabel={t.spoken ?? (count === null ? t.label : `${t.label}, ${count}`)}
        onPress={() => onChange(t.key)}
        onLayout={(e) => {
          spots.current.set(t.key, e.nativeEvent.layout);
          pending();
        }}
        feedback={selected ? 'none' : 'wash'}
        // The gap between tabs still takes the finger.
        hitSlop={scroll ? { left: TAB_GAP / 2, right: TAB_GAP / 2 } : undefined}
        style={{
          ...(scroll ? { paddingHorizontal: TAB_PAD } : { flex: 1, paddingHorizontal: 4 }),
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          borderBottomWidth: 2,
          borderBottomColor: selected ? theme.colors.ink : 'transparent',
        }}
      >
        <Text
          size={14.5}
          weight={selected ? 600 : 500}
          color={selected ? theme.colors.ink : theme.colors.mut}
          numberOfLines={1}
        >
          {t.label}
        </Text>
        {count !== null ? (
          <Text
            size={11.5}
            weight={500}
            mono
            color={selected ? theme.colors.ink2 : theme.colors.mut}
            numberOfLines={1}
          >
            {count}
          </Text>
        ) : null}
        {t.level ? (
          <StatusMark level={t.level} />
        ) : t.tone ? (
          <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: toneOf(theme, t.tone) }} />
        ) : null}
      </Touchable>
    );
  });

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        marginHorizontal: -bleed,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      {scroll ? (
        <ScrollView
          ref={scroller}
          horizontal
          showsHorizontalScrollIndicator={false}
          // The underline lies over the hairline, not above it (the web's look at phone sizes).
          style={{ flex: 1, marginBottom: -1 }}
          contentContainerStyle={{ gap: TAB_GAP, paddingLeft: edge, paddingRight: trailing ? 0 : edge }}
          scrollEventThrottle={16}
          onScroll={(e) => {
            view.current.x = e.nativeEvent.contentOffset.x;
          }}
          onLayout={(e) => {
            view.current.width = e.nativeEvent.layout.width;
            pending();
          }}
        >
          {items}
        </ScrollView>
      ) : (
        <View
          style={{
            flex: 1,
            flexDirection: 'row',
            marginBottom: -1,
            paddingLeft: bleed,
            paddingRight: trailing ? 0 : bleed,
          }}
        >
          {items}
        </View>
      )}
      {trailing ? (
        <View style={{ justifyContent: 'center', marginBottom: -1, paddingRight: bleed }}>{trailing}</View>
      ) : null}
    </View>
  );
}
