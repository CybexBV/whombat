/**
 * A page's read parts on the phone (docs/design-handoff/council-ui-2026-11/16-final/overview; the decision file
 * docs/decisions/overview-server-connection-final.md): the note a page shows when its first read fails or a refresh
 * fails (the saved readings stay under it), and page-shaped placeholders while it loads (shared by a server's page, a
 * connection's page and Find My).
 */

import { overviewWords } from '@whombat/client';
import { View } from 'react-native';
import { useI18n } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { MoreFold } from '../../ui/fold';
import { Button, Skeleton } from '../../ui/primitives';
import { errorText } from '../feedback';

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
  const { rawLocale } = useI18n();
  const overviewWordsHere = overviewWords(rawLocale);

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
        label={overviewWordsHere.tryAgain}
        onPress={onRetry}
        style={{ alignSelf: 'flex-start', marginTop: 4, paddingHorizontal: 16 }}
      />
      {error ? (
        <MoreFold label={overviewWordsHere.moreDetail}>
          <Text size={13} lh={1.45} color={theme.colors.mut}>
            {errorText(error, rawLocale)}
          </Text>
        </MoreFold>
      ) : null}
    </View>
  );
}

/**
 * Page-shaped placeholders (mock `-loading`): `count` cards each with a title bar, a line and `tiles` figure blocks, in
 * the shape of what comes, under its label (“Loading pve-02…”).
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
