/**
 * The final design's places on the phone (Settings, Vault, Files, Usage; docs/design-handoff/council-ui-2026-11/
 * 16-final/, docs/decisions/final-settings-vault-files-usage.md), the same on iPhone and Android: the large title over
 * one plain line, a section title, a card of rows (an icon or a face, the name over its line, a chevron) and a read's
 * loading, empty and failed card that leaves the rest of the screen working. Rows are at least 60 tall, so the 44pt
 * and 48dp targets hold, and grow with large text.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ChevronRight, type LucideIcon } from './icons';
import { Button } from './primitives';
import { StatusPill } from './StatusPill';
import { Touchable } from './Touchable';

/** The pages' sides: the large title's 20 from the edge, the cards at the same. */
export const PLACE_SIDE = 20;

export function PlaceTitle({ title, intro }: { title: string; intro?: string | null }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 8, paddingTop: 8 }}>
      <Text size={32} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header">
        {title}
      </Text>
      {intro ? (
        <Text size={15} lh={1.5} color={theme.colors.ink2}>
          {intro}
        </Text>
      ) : null}
    </View>
  );
}

export function PlaceSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={{ gap: 12 }}>
      {title ? (
        <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

export function PlaceCard({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      {children}
    </View>
  );
}

/**
 * A row of a card: its icon (or a face), the name (and a quiet tag after it: a Vault entry kept in step with 1Password)
 * over its line, and a chevron; the first has no line above.
 */
export function PlaceRow({
  icon: Icon,
  mark,
  title,
  tag,
  line,
  bad = false,
  warn = false,
  first = false,
  selected = false,
  label,
  onPress,
}: {
  icon?: LucideIcon;
  /** In place of the icon: a face or a logo. */
  mark?: ReactNode;
  title: string;
  /** After the name, wrapping under it on a narrow row. */
  tag?: string | null;
  line?: string | null;
  /** The line in the Not working colour. */
  bad?: boolean;
  /** The line in the warning's text colour (“Update ready”). */
  warn?: boolean;
  first?: boolean;
  /** With two pages: the page beside the list shows what it opens. */
  selected?: boolean;
  /** What VoiceOver and TalkBack read. */
  label?: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label ?? [title, line].filter(Boolean).join(', ')}
      accessibilityState={{ selected }}
      feedback="wash"
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        minHeight: 64,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
        backgroundColor: selected ? theme.colors.sel : 'transparent',
      }}
    >
      {mark || Icon ? (
        <View style={{ width: 28, alignItems: 'center', justifyContent: 'center' }}>
          {mark ?? (Icon ? <Icon size={20} color={theme.colors.ink2} /> : null)}
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        {tag ? (
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4 }}
          >
            <Text size={16} weight={600}>
              {title}
            </Text>
            <StatusPill text={tag} tone="neutral" />
          </View>
        ) : (
          <Text size={16} weight={600}>
            {title}
          </Text>
        )}
        {line ? (
          <Text
            size={13.5}
            lh={1.4}
            color={bad ? theme.colors.bad : warn ? theme.colors.warnText : theme.colors.ink2}
          >
            {line}
          </Text>
        ) : null}
      </View>
      <ChevronRight size={18} color={theme.colors.mut} />
    </Touchable>
  );
}

export type PlaceStateKind = 'loading' | 'empty' | 'failed';

/**
 * A read's state as one card: loading (its title and two bars), empty (a successful read with nothing in it) or
 * failed (in the warning colour, never red: a read failing isn't the thing failing) with Try again.
 */
export function PlaceState({
  kind,
  icon: Icon,
  title,
  line,
  onRetry,
  retryLabel = 'Try again',
  action,
}: {
  kind: PlaceStateKind;
  icon: LucideIcon;
  title: string;
  line?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  /** The empty state's way on (Go to Chat). */
  action?: { label: string; onPress: () => void };
}) {
  const theme = useTheme();
  return (
    <View
      accessible={kind === 'loading'}
      accessibilityLabel={kind === 'loading' ? title : undefined}
      accessibilityLiveRegion={kind === 'failed' ? 'polite' : 'none'}
      style={{
        gap: 10,
        padding: 20,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        alignItems: 'flex-start',
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.sf2,
        }}
      >
        <Icon size={18} color={theme.colors.ink2} />
      </View>
      <Text size={16} weight={700} color={kind === 'failed' ? theme.colors.warnText : theme.colors.ink}>
        {title}
      </Text>
      {line ? (
        <Text size={14} lh={1.5} color={theme.colors.ink2}>
          {line}
        </Text>
      ) : null}
      {kind === 'loading' ? (
        <View style={{ gap: 12, alignSelf: 'stretch', marginTop: 4 }}>
          <View style={{ height: 10, width: '80%', borderRadius: 5, backgroundColor: theme.colors.sf2 }} />
          <View style={{ height: 10, width: '52%', borderRadius: 5, backgroundColor: theme.colors.sf2 }} />
        </View>
      ) : null}
      {kind === 'failed' && onRetry ? (
        <Button label={retryLabel} variant="secondary" onPress={onRetry} wrap />
      ) : null}
      {action ? <Button label={action.label} variant="secondary" onPress={action.onPress} wrap /> : null}
    </View>
  );
}
