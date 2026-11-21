/**
 * Overview's parts on the phone (docs/design-handoff/council-ui-2026-11/16-final/overview; the decision file
 * docs/decisions/overview-server-connection-final.md): the broken thing as the first line — its heading in `bad`, its
 * consequence, one *Look into it* — and the link to the rest of the Inbox under it; the note a page shows when its first
 * read fails or a refresh fails (the saved readings stay under it); page-shaped placeholders while it loads (shared by
 * Overview, a server's page and a connection's page); and Overview's jump chips under its title.
 */
import {
  type ConnectionsTab,
  NEEDS_YOU_WORDS,
  OVERVIEW_WORDS,
  type OverviewHeadline,
  type OverviewSectionView,
} from '@whombat/client';
import type { NeedsYouItem } from '@whombat/core';
import { useState } from 'react';
import { View } from 'react-native';
import { useAgentWords } from '../../data/useAgent';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { MoreFold } from '../../ui/fold';
import { ChevronRight } from '../../ui/icons';
import { Button, Skeleton } from '../../ui/primitives';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';
import { errorText } from '../feedback';
import { useNeedsYouPress } from '../NeedsYouSheet';

/** The Inbox's own *handle it* on the item, named as Overview names it. */
const LOOK_INTO_IT = {
  id: 'handle',
  kind: 'handle',
  label: OVERVIEW_WORDS.lookIntoIt,
  look: 'primary',
} as const;

/**
 * The broken thing (mock `overview/ios-light.png`): a card with a 4dp `bad` rule on its leading edge, the heading in
 * `bad` 22/700, the consequence in `ink2`, and one *Look into it* — or, while the assistant already looks into it, its
 * words instead of the button.
 */
export function BrokenCard({
  headline,
  item,
}: {
  headline: Extract<OverviewHeadline, { kind: 'broken' }>;
  item: NeedsYouItem | null;
}) {
  const theme = useTheme();
  const words = useAgentWords();
  const press = useNeedsYouPress();
  const [busy, setBusy] = useState(false);
  const look = () => {
    if (!item) return;
    setBusy(true);
    void press(item, LOOK_INTO_IT).finally(() => setBusy(false));
  };
  return (
    <View
      style={{
        backgroundColor: theme.colors.sf,
        borderWidth: 1,
        borderColor: theme.colors.line,
        borderLeftWidth: 4,
        borderLeftColor: theme.colors.bad,
        borderRadius: 16,
        paddingHorizontal: 18,
        paddingVertical: 18,
        gap: 10,
      }}
    >
      <Text
        size={22}
        weight={700}
        lh={1.25}
        tracking={-0.01}
        color={theme.colors.bad}
        accessibilityRole="header"
      >
        {headline.title}
      </Text>
      {headline.detail ? (
        <Text size={15} lh={1.45} color={theme.colors.ink2}>
          {headline.detail}
        </Text>
      ) : null}
      {headline.busy ? (
        <Text size={14} weight={500} color={theme.colors.mut}>
          {headline.busy === 'looking' ? NEEDS_YOU_WORDS.looking(words) : NEEDS_YOU_WORDS.fixing(words)}
        </Text>
      ) : item ? (
        <Button
          label={OVERVIEW_WORDS.lookIntoIt}
          onPress={look}
          busy={busy}
          accessibilityLabel={`${OVERVIEW_WORDS.lookIntoIt}: ${headline.title}`}
          style={{ alignSelf: 'flex-start', marginTop: 4, paddingHorizontal: 16 }}
        />
      ) : null}
    </View>
  );
}

/** “2 other things need you ›”: a 44dp link to the Inbox, under the broken thing. */
export function OthersLink({ count, onPress }: { count: number; onPress: () => void }) {
  const theme = useTheme();
  if (count <= 0) return null;
  const text = OVERVIEW_WORDS.others(count);
  return (
    <Touchable
      onPress={onPress}
      feedback="fade"
      ringRadius={8}
      accessibilityRole="link"
      accessibilityLabel={text}
      style={{
        alignSelf: 'flex-start',
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginVertical: -6,
      }}
    >
      <Text size={14} color={theme.colors.ink2}>
        {text}
      </Text>
      <ChevronRight size={14} color={theme.colors.mut} strokeWidth={1.8} />
    </Touchable>
  );
}

/**
 * The note of a read that failed (mock `-failed`, `-saved-failed`): its heading in `warnText` (a read failing isn't
 * something broken, so never red), one line, Try again, and the error folded under More detail. After a failed refresh
 * the saved readings stay under it with their own times; after a failed first read there is nothing saved to show.
 */
export function ReadNote({
  title,
  body,
  onRetry,
  error,
}: {
  title: string;
  body: string;
  onRetry: () => void;
  error?: unknown;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={{
        backgroundColor: theme.colors.sf,
        borderWidth: 1,
        borderColor: theme.colors.line,
        borderRadius: 16,
        paddingHorizontal: 18,
        paddingTop: 16,
        paddingBottom: error ? 6 : 16,
        gap: 8,
      }}
    >
      <Text size={19} weight={700} lh={1.3} color={theme.colors.warnText} accessibilityRole="header">
        {title}
      </Text>
      <Text size={15} lh={1.45} color={theme.colors.ink2}>
        {body}
      </Text>
      <Button
        label={OVERVIEW_WORDS.tryAgain}
        onPress={onRetry}
        style={{ alignSelf: 'flex-start', marginTop: 4, paddingHorizontal: 16 }}
      />
      {error ? (
        <MoreFold label={OVERVIEW_WORDS.moreDetail}>
          <Text size={13} lh={1.45} color={theme.colors.mut}>
            {errorText(error)}
          </Text>
        </MoreFold>
      ) : null}
    </View>
  );
}

/**
 * Page-shaped placeholders (mock `-loading`): `count` cards each with a title bar, a line and `tiles` figure blocks, in
 * the shape of what comes, under “Loading Overview…”.
 */
export function CardSkeletons({
  label,
  count = 2,
  tiles = 2,
}: {
  label: string;
  count?: number;
  tiles?: number;
}) {
  const theme = useTheme();
  return (
    <View accessible accessibilityLabel={label} style={{ gap: 12 }}>
      <Text size={13} color={theme.colors.mut}>
        {label}
      </Text>
      {Array.from({ length: count }, (_, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length, static placeholder list
          key={i}
          style={{
            backgroundColor: theme.colors.sf,
            borderWidth: 1,
            borderColor: theme.colors.line,
            borderRadius: 16,
            padding: 16,
            gap: 12,
          }}
        >
          <Skeleton width="55%" height={18} radius={9} />
          <Skeleton width="85%" height={10} radius={5} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {Array.from({ length: tiles }, (_, t) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length, static placeholder list
              <View key={t} style={{ flexBasis: '48%', flexGrow: 1 }}>
                <Skeleton height={64} radius={10} />
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Overview's jump chips (docs/decisions/overview-one-page.md OVP-01; the mock's `.jump` at phone width): one per
 * section, wrapping — 34 tall, padded 13, round, a `line2` hairline, the name 14 in `ink2`, its count mono 11.5/500 in
 * `mut` and a 7dp dot in `bad` or `warn` when something in it isn't fine; 7 between them, 6 apart. A tap scrolls to the
 * section; each is a link named “Servers, 6, something needs a look”.
 */
export function JumpChips({
  chips,
  onJump,
}: {
  chips: readonly OverviewSectionView[];
  onJump: (key: ConnectionsTab) => void;
}) {
  const theme = useTheme();
  if (!chips.length) return null;
  return (
    <View
      accessibilityLabel={OVERVIEW_WORDS.onThisPage}
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}
    >
      {chips.map((c) => (
        <Touchable
          key={c.key}
          onPress={() => onJump(c.key)}
          feedback="fade"
          ringRadius={17}
          accessibilityRole="link"
          accessibilityLabel={c.spoken}
          hitSlop={hitSlopFor(34)}
          style={{
            height: 34,
            paddingHorizontal: 13,
            borderRadius: 17,
            borderWidth: 1,
            borderColor: theme.colors.line2,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
          }}
        >
          <Text size={14} color={theme.colors.ink2}>
            {c.label}
          </Text>
          <Text size={11.5} weight={500} mono color={theme.colors.mut}>
            {c.count}
          </Text>
          {c.tone ? (
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 3.5,
                backgroundColor: c.tone === 'bad' ? theme.colors.bad : theme.colors.warn,
              }}
            />
          ) : null}
        </Touchable>
      ))}
    </View>
  );
}
