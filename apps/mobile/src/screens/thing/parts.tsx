/**
 * Small parts of a thing page's cards (connection-pages-mobile.md AP-1953): a header link in `brand` (44dp with its
 * padding), the grey words under a card's title, a quiet line inside a card, and a head's fact line (a connection's
 * and a server's, dashboards-mobile.md AP-2128); whether the page is wide enough for its cards in columns.
 */
import type { ThingLine, ThingPageLink } from '@whombat/core';
import { useCallback, useState } from 'react';
import { type LayoutChangeEvent, View } from 'react-native';
import { isWidePage } from '../../data/fullWidth';
import { type LinkRun, lineText, linkRun, type PhoneThingTab } from '../../data/thingPage';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';

/** A card's link in its header (“Backups”, “Show all”, “Change”): brand words, 44dp tall. */
export function HeaderLink({ label, hint, onPress }: { label: string; hint?: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="fade"
      ringRadius={8}
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={hitSlopFor(28)}
      style={{ minHeight: 28, justifyContent: 'center', paddingHorizontal: 2 }}
    >
      <Text size={13} weight={600} color={theme.colors.brand}>
        {label}
      </Text>
    </Touchable>
  );
}

/** A card's header link from the builder's (`table`, `list`, `bars`, `gallery`), when the phone has a way out for it. */
export function PanelLink({
  link,
  tabs,
  run,
}: {
  link: ThingPageLink | undefined;
  tabs: readonly PhoneThingTab[];
  run: (r: LinkRun) => void;
}) {
  const out = linkRun(link, tabs);
  if (!out) return null;
  return <HeaderLink label={out.label} onPress={() => run(out.run)} />;
}

/**
 * The grey words under a card's title (“last 24 h · the dip is yesterday’s restart”); `inline` without the card's
 * insets (inside an opened figure).
 */
export function Meta({ text, inline = false }: { text: string | undefined; inline?: boolean }) {
  const theme = useTheme();
  if (!text?.trim()) return null;
  return (
    <Text
      size={13}
      color={theme.colors.mut}
      style={inline ? undefined : { paddingHorizontal: 14, paddingBottom: 10, marginTop: -4 }}
    >
      {text}
    </Text>
  );
}

/** A quiet line inside a card (“Nothing needs a look.”). */
export function CardQuiet({ text, first = false }: { text: string; first?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: 14,
        paddingVertical: 14,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <Text size={14} lh={1.45} color={theme.colors.mut}>
        {text}
      </Text>
    </View>
  );
}

/** One fact line: grey words, some in `ink` and semibold, some mono (“Home Assistant **2026.10.2** · Container”). */
export function FactLine({ line }: { line: ThingLine }) {
  const theme = useTheme();
  return (
    <Text size={13.5} lh={1.45} color={theme.colors.mut} accessibilityLabel={lineText(line)}>
      {line.map((p, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: a line's parts in their order
          key={i}
          size={p.mono ? 13 : 13.5}
          weight={p.strong ? 600 : 400}
          mono={!!p.mono}
          color={p.strong ? theme.colors.ink : theme.colors.mut}
        >
          {p.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Whether a page's cards sit in columns (iphone-duo.md AP-6741): from the width its scroller is given, less its margins,
 * so it follows the list being hidden or shown, the line between the pages and the phone folding.
 */
export function useWidePage(inset: number): { wide: boolean; onLayout: (e: LayoutChangeEvent) => void } {
  const [wide, setWide] = useState(false);
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => setWide(isWidePage(e.nativeEvent.layout.width - 2 * inset)),
    [inset],
  );
  return { wide, onLayout };
}
