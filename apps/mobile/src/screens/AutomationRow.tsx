/**
 * The Automations list's rows (docs/decisions/automations-final.md): each row is one target opening the automation's page
 * — the real mark of what starts it and the whole name, then one line joined with “ · ”: On, Off or Not on yet, its last
 * run in words and when, its next run and a plan that waits for the person, wrapping only when it must; one chevron
 * stays at the end. Off and not on yet read as clearly as on. One TalkBack or VoiceOver stop that says it all in words.
 * The agent's own schedules are rows under Only tells you, with their own buttons (`OnlyTellsYouRowView`; Whombat
 * automation-chat.md).
 */

import type { AutomationListRow, AutomationStateTone } from '@whombat/client';
import { useGitHubAvatar } from '@whombat/client/react';
import type { AutomationSource } from '@whombat/core';
import { SCHEDULE_STATUS_LABELS } from '@whombat/core';
import { useState } from 'react';
import { Image, Platform, View } from 'react-native';
import {
  AUTOMATION_LIST_TEXT,
  type AutomationTileView,
  type OnlyTellsYouRow,
  type RunBarTone,
} from '../data/automations';
import { useBurrowBase } from '../data/BurrowProvider';
import type { ScheduleAction, ScheduleRow } from '../data/schedules';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Facts } from '../ui/facts';
import { runBarColor } from '../ui/glanceColors';
import {
  ChevronRight,
  Clock,
  Inbox,
  LinkIcon,
  type LucideIcon,
  MessageSquare,
  Play,
  Smile,
} from '../ui/icons';
import { StatusDot, toneColor } from '../ui/primitives';
import { GitHubMark } from '../ui/sourceMarks';
import { Touchable } from '../ui/Touchable';
import { ScheduleButtons } from './agent/scheduleActions';

/** A GitHub owner's picture is asked for again after six hours, and never retried: the mark stands in. */
const AVATAR_STALE_MS = 6 * 60 * 60 * 1000;

/** A report tracker is any ticket system: one icon for all of them, its label names it. */
const ICONS: Record<Exclude<AutomationSource, 'github'>, LucideIcon> = {
  tracker: Inbox,
  schedule: Clock,
  message: MessageSquare,
  reaction: Smile,
  webhook: LinkIcon,
  manual: Play,
};

/** The summary beside the control: the rest of the width, as `ListRow`'s. */
const SUMMARY_STYLE = { flex: 1, minWidth: 0, flexDirection: 'row', gap: 12 } as const;

/** The state dot's colour: on `ok`, waiting `warn`; off and not on yet a ring in `mut`. */
export function stateColor(theme: ReturnType<typeof useTheme>, tone: AutomationStateTone): string | null {
  if (tone === 'on') return theme.colors.ok;
  if (tone === 'waiting') return theme.colors.warn;
  return null;
}

/** A 7dp dot: filled for on and waiting, a ring for off and not on yet. */
export function StateDot({ tone }: { tone: AutomationStateTone }) {
  const theme = useTheme();
  const fill = stateColor(theme, tone);
  return (
    <View
      style={{
        width: 7,
        height: 7,
        borderRadius: 3.5,
        ...(fill ? { backgroundColor: fill } : { borderWidth: 1.5, borderColor: theme.colors.mut }),
      }}
    />
  );
}

/**
 * Its last few runs as small bars, oldest left (AP-1093's colours): 4dp wide, 11dp tall. A screen reader hears them in
 * the row's own words (“Last 5 runs: 4 done, 1 failed”), so they aren't an element of their own.
 */
export function RunBars({ bars }: { bars: readonly { key: string; tone: RunBarTone }[] }) {
  const theme = useTheme();
  if (!bars.length) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 11 }}>
      {bars.map((b) => (
        <View
          key={b.key}
          style={{
            width: 4,
            height: b.tone === 'quiet' ? 7 : 11,
            borderRadius: 1.5,
            backgroundColor: runBarColor(theme.colors, b.tone),
          }}
        />
      ))}
    </View>
  );
}

/** The smallest target here: 44pt on iOS, 48dp on Android. */
export const ROW_TARGET = Platform.OS === 'android' ? 48 : 44;

/** One automation on the list; marked while its page shows beside the list. */
export function AutomationListRowView({
  row,
  selected,
  last,
  onPress,
}: {
  row: AutomationListRow;
  selected: boolean;
  /** The card's last row: no line under it. */
  last: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      accessibilityRole="button"
      accessibilityLabel={row.accessibilityLabel}
      accessibilityState={{ selected }}
      style={{
        minHeight: ROW_TARGET,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 12,
        paddingLeft: 14,
        paddingRight: 10,
        ...(selected ? { backgroundColor: theme.colors.sel } : null),
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <SourceMark tile={row.tile} />
          <Text size={16} weight={600} lh={1.4} style={{ flex: 1, minWidth: 0 }}>
            {row.name}
          </Text>
        </View>
        <Text size={13} lh={1.45} color={theme.colors.ink2}>
          {row.line.map((part, i) => (
            <Text
              key={part.key}
              size={13}
              lh={1.45}
              weight={part.key === 'state' ? 600 : 400}
              color={
                part.key === 'state'
                  ? theme.colors.ink
                  : part.key === 'plan'
                    ? theme.colors.warnText
                    : theme.colors.ink2
              }
            >
              {i > 0 ? ` · ${part.text}` : part.text}
            </Text>
          ))}
        </Text>
      </View>
      <ChevronRight size={18} color={theme.colors.mut} strokeWidth={1.8} />
      {/* The line between rows stops short of the card's sides. */}
      {last ? null : (
        <View
          style={{
            position: 'absolute',
            left: 14,
            right: 14,
            bottom: 0,
            height: 1,
            backgroundColor: theme.colors.line,
          }}
        />
      )}
    </Touchable>
  );
}

/**
 * What starts it on a compact row, 24dp beside the name: the GitHub owner's picture with GitHub's small badge once it
 * has loaded, else GitHub's mark; or an icon.
 */
export function SourceMark({ tile }: { tile: AutomationTileView }) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const avatar = useGitHubAvatar(tile.owner ? { params: { burrow: slug, owner: tile.owner } } : null, {
    staleTime: AVATAR_STALE_MS,
    retry: false,
  });
  const image = avatar.data?.image ?? null;
  const [shown, setShown] = useState<{ image: string; ok: boolean } | null>(null);
  const loaded = image !== null && shown?.image === image && shown.ok;
  const failed = image !== null && shown?.image === image && !shown.ok;
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={tile.label}
      style={{ width: 24, height: 24, marginTop: 0.5, alignItems: 'center', justifyContent: 'center' }}
    >
      {tile.source === 'github' ? (
        loaded ? null : (
          <GitHubMark size={22} color={theme.colors.ink} />
        )
      ) : (
        <SourceGlyph source={tile.source} size={21} color={theme.colors.ink} />
      )}
      {tile.source === 'github' && image && !failed ? (
        <Image
          source={{ uri: image }}
          resizeMode="cover"
          onLoad={() => setShown({ image, ok: true })}
          onError={() => setShown({ image, ok: false })}
          style={{ position: 'absolute', top: 0, left: 0, width: 24, height: 24, borderRadius: 6 }}
        />
      ) : null}
      {loaded ? (
        <View
          style={{
            position: 'absolute',
            right: -4,
            bottom: -4,
            width: 14,
            height: 14,
            borderRadius: 7,
            borderWidth: 1.5,
            borderColor: theme.colors.sf,
            backgroundColor: theme.colors.ink,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <GitHubMark size={8} color={theme.colors.bg} />
        </View>
      ) : null}
    </View>
  );
}

/** What starts it, 40dp on the list and 52dp on the page (AP-1090): the GitHub owner's picture with GitHub's badge, a brand's mark, or an icon. */
export function SourceTile({ tile, size = 40 }: { tile: AutomationTileView; size?: number }) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const avatar = useGitHubAvatar(tile.owner ? { params: { burrow: slug, owner: tile.owner } } : null, {
    staleTime: AVATAR_STALE_MS,
    retry: false,
  });
  const image = avatar.data?.image ?? null;
  // The picture shows once it has loaded; the mark stays when it fails (as a person's photo, HumanAvatar).
  const [shown, setShown] = useState<{ image: string; ok: boolean } | null>(null);
  const loaded = image !== null && shown?.image === image && shown.ok;
  const failed = image !== null && shown?.image === image && !shown.ok;
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={tile.label}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {tile.source === 'github' ? (
        loaded ? null : (
          <GitHubMark size={size / 2} color={theme.colors.ink} />
        )
      ) : (
        <SourceGlyph
          source={tile.source}
          size={Math.round(size * (tile.source === 'tracker' ? 0.6 : 0.45))}
        />
      )}
      {image && !failed ? (
        <Image
          source={{ uri: image }}
          resizeMode="cover"
          onLoad={() => setShown({ image, ok: true })}
          onError={() => setShown({ image, ok: false })}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: size - 2,
            height: size - 2,
            borderRadius: size * 0.3 - 1,
          }}
        />
      ) : null}
      {/* GitHub's badge over the corner, 5dp past the tile's edge (offsets count from inside its border). */}
      {loaded ? (
        <View
          style={{
            position: 'absolute',
            right: -6,
            bottom: -6,
            width: 18,
            height: 18,
            borderRadius: 9,
            borderWidth: 2,
            borderColor: theme.colors.sf,
            backgroundColor: theme.colors.ink,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <GitHubMark size={10} color={theme.colors.bg} />
        </View>
      ) : null}
    </View>
  );
}

/** A source's own mark or icon, in `ink2` (or `color`) where it takes a colour. */
function SourceGlyph({ source, size, color }: { source: AutomationSource; size: number; color?: string }) {
  const theme = useTheme();
  const tint = color ?? theme.colors.ink2;
  if (source === 'github') return <GitHubMark size={size} color={tint} />;
  const Icon = ICONS[source];
  return <Icon size={size} color={tint} strokeWidth={1.75} absoluteStrokeWidth />;
}

/**
 * Something waiting for the person, with “Open”: a run, or a plan waiting for a yes (its conversation). A
 * `warn` dot, the words, “Open”; 44dp tall.
 */
export function WaitingLine({
  waiting,
  onOpen,
  indent = true,
}: {
  waiting: { text: string; accessibilityLabel: string };
  onOpen: () => void;
  /** Under the tile's column (a run's line); false inside a row's footer, which is already there. */
  indent?: boolean;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onOpen}
      feedback="wash"
      accessibilityRole="link"
      accessibilityLabel={waiting.accessibilityLabel}
      ringRadius={10}
      style={{
        minHeight: 44,
        marginLeft: indent ? 52 : 0,
        marginTop: 4,
        marginBottom: indent ? -10 : 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderRadius: 10,
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: theme.colors.warn }} />
      <Text size={13.5} lh={1.35} color={theme.colors.ink2} style={{ flex: 1 }}>
        {waiting.text}
      </Text>
      <Text size={13.5} weight={600} color={theme.colors.ink} style={{ paddingHorizontal: 8 }}>
        {AUTOMATION_LIST_TEXT.open}
      </Text>
    </Touchable>
  );
}

/**
 * One of the agent's schedules on the list (Whombat automation-chat.md), under ONLY TELLS YOU: the clock tile, what it
 * does, when it runs and its state, when it runs next, and Pause or Resume and Remove. It starts at once when made, as a
 * reminder needs no yes.
 */
export function OnlyTellsYouRowView({
  row,
  agentName,
  busy,
  onPress,
}: {
  row: OnlyTellsYouRow;
  agentName: string;
  busy: boolean;
  onPress: (action: ScheduleAction, row: ScheduleRow) => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      <View style={SUMMARY_STYLE} accessible accessibilityLabel={row.accessibilityLabel}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.colors.line,
            backgroundColor: theme.colors.sf2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <SourceGlyph source="schedule" size={18} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4 }}
          >
            <Text size={15.5} weight={600} lh={1.35} style={{ flexShrink: 1 }}>
              {row.what}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <StatusDot color={toneColor(theme, row.tone)} label={SCHEDULE_STATUS_LABELS[row.status]} />
            <Text size={13} lh={1.4} color={theme.colors.ink2} style={{ flex: 1 }}>
              {row.when}
            </Text>
          </View>
          {row.next ? <Facts facts={[row.next]} /> : null}
        </View>
      </View>
      <View style={{ marginLeft: 52 }}>
        <ScheduleButtons row={row} agentName={agentName} busy={busy} onPress={onPress} />
      </View>
    </View>
  );
}
