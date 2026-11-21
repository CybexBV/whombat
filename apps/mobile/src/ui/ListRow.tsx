/**
 * A grouped-list row in the inbox's language (not mocked beyond the inbox): 44dp leading slot, a
 * name / mono meta / trailing line and optional body text; padding 14 16, bottom hairline.
 */
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ChevronRight } from './icons';
import { Touchable } from './Touchable';

/** The arrow at the end of a row that opens a page: the Settings list's chevron, the same everywhere. */
export function RowChevron() {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ alignSelf: 'center' }}
    >
      <ChevronRight size={18} color={theme.colors.mut} />
    </View>
  );
}

/** The row's summary beside its control: the rest of the width (the content's own size, no fixed one). */
const SUMMARY_STYLE = { flex: 1, minWidth: 0, flexDirection: 'row', gap: 12 } as const;

export function ListRow({
  leading,
  title,
  titleMono,
  meta,
  metaLeading,
  trailing,
  control,
  body,
  bodyLines = 2,
  children,
  onPress,
  onLongPress,
  accessibilityLabel,
}: {
  leading?: ReactNode;
  title: string;
  titleMono?: boolean;
  /** Mono, muted, ellipsized: "#billing-v2", "8 in room". */
  meta?: string | null;
  /** Before the meta (an agent's role dot, AP-230). */
  metaLeading?: ReactNode;
  /** Small text or a dot at the end of the title line. */
  trailing?: ReactNode;
  /** A control on the right of the whole row, centred on it (a switch): it never moves the title line. */
  control?: ReactNode;
  body?: string | null;
  /** How many lines of `body` show before it ellipsizes. */
  bodyLines?: number;
  children?: ReactNode;
  onPress?: () => void;
  /**
   * With a `control` and no `onPress`: a long press on the row (TalkBack: double-tap and hold) opens its actions, which
   * a button of their own in the control offers too.
   */
  onLongPress?: () => void;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const content = (
    <>
      {leading ? <View style={{ width: 44, minHeight: 44, justifyContent: 'center' }}>{leading}</View> : null}
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'column', gap: 4, justifyContent: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
          <Text
            size={titleMono ? 14.5 : 15.5}
            weight={titleMono ? 500 : 600}
            mono={titleMono}
            numberOfLines={1}
            style={{ flexShrink: 1 }}
          >
            {title}
          </Text>
          {metaLeading}
          <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
            {meta ?? ''}
          </Text>
          {trailing === '›' ? (
            <RowChevron />
          ) : typeof trailing === 'string' ? (
            <Text size={11.5} mono color={theme.colors.mut}>
              {trailing}
            </Text>
          ) : (
            trailing
          )}
        </View>
        {body ? (
          <Text size={15} lh={1.42} color={theme.colors.ink2} numberOfLines={bodyLines}>
            {body}
          </Text>
        ) : null}
        {children}
      </View>
    </>
  );
  const style = {
    flexDirection: 'row' as const,
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.line,
  };
  // The control stays its own TalkBack stop, next to the row's summary.
  if (control && !onPress)
    return (
      <View style={style}>
        {onLongPress ? (
          <Pressable
            onLongPress={onLongPress}
            delayLongPress={350}
            style={SUMMARY_STYLE}
            accessible={!!accessibilityLabel}
            accessibilityLabel={accessibilityLabel}
          >
            {content}
          </Pressable>
        ) : (
          <View
            style={SUMMARY_STYLE}
            accessible={!!accessibilityLabel}
            accessibilityLabel={accessibilityLabel}
          >
            {content}
          </View>
        )}
        <View style={{ minHeight: 44, justifyContent: 'center' }}>{control}</View>
      </View>
    );
  return onPress ? (
    <Touchable onPress={onPress} feedback="wash" accessibilityLabel={accessibilityLabel} style={style}>
      {content}
    </Touchable>
  ) : (
    <View style={style} accessible={!!accessibilityLabel} accessibilityLabel={accessibilityLabel}>
      {content}
    </View>
  );
}

/** Unread badge: btn pill with the mono count. */
export function CountBadge({ count, label }: { count: number; label: string }) {
  const theme = useTheme();
  if (count <= 0) return null;
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{
        minWidth: 20,
        height: 20,
        paddingHorizontal: 6,
        borderRadius: 999,
        backgroundColor: theme.colors.btn,
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
      }}
    >
      <Text size={11} weight={500} mono color={theme.colors.btnfg}>
        {String(count)}
      </Text>
    </View>
  );
}
